import type { ChannelAuthService } from "../auth-service";
import type { Channel, ChannelMessage, ChannelPlatform } from "../types";
import { parseCommand } from "./parser";
import { ChannelCommandRegistry } from "./registry";
import { checkCommandAuthorization } from "./security";
import {
  PENDING_COMMAND_TTL_MS,
  type CommandContext,
  type CommandConversationManager,
  type CommandProviderAuthService,
  type CommandProviderRegistry,
  type CommandResult,
  type PendingCommandState,
} from "./types";

export interface CommandDispatcherOptions {
  registry: ChannelCommandRegistry;
  authService: ChannelAuthService;
  conversationManager: CommandConversationManager;
  providerRegistry: CommandProviderRegistry;
  providerAuthService: CommandProviderAuthService;
}

/**
 * Coordinates command parsing, authorization, handler dispatch, and pending state.
 *
 * One instance per channel session. Maintains per-user pending state in memory.
 */
export class CommandDispatcher {
  private readonly registry: ChannelCommandRegistry;
  private readonly authService: ChannelAuthService;
  private readonly conversationManager: CommandConversationManager;
  private readonly providerRegistry: CommandProviderRegistry;
  private readonly providerAuthService: CommandProviderAuthService;

  private readonly pendingState = new Map<string, PendingCommandState>();

  constructor(options: CommandDispatcherOptions) {
    this.registry = options.registry;
    this.authService = options.authService;
    this.conversationManager = options.conversationManager;
    this.providerRegistry = options.providerRegistry;
    this.providerAuthService = options.providerAuthService;
  }

  /**
   * Determine if a message should be intercepted as a command.
   */
  public isCommandMessage(channelMessage: ChannelMessage, userId: string): boolean {
    const text = channelMessage.text?.trim() ?? "";

    if (text.startsWith("/")) {
      const parsed = parseCommand(text, this.registry);
      return parsed !== null;
    }

    const pending = this.getPendingState(userId);
    if (pending && (pending.step === "awaiting_api_key" || pending.step === "awaiting_auth_code")) {
      return true;
    }

    return false;
  }

  /**
   * Dispatch an inbound message as a command.
   */
  public async dispatch(
    channelMessage: ChannelMessage,
    channel: Channel,
    userId: string,
    conversationId?: string,
  ): Promise<CommandResult | null> {
    const text = channelMessage.text?.trim() ?? "";
    const senderId = channelMessage.sender.id;
    const channelId = channel.config.id;
    const platform = channel.config.platform as ChannelPlatform;

    const authResult = await checkCommandAuthorization(channelId, senderId, this.authService);
    if (!authResult.authorized) {
      return authResult.result;
    }

    let currentModel: string | undefined;
    let currentProvider: string | undefined;
    let currentConversationId: string | undefined = conversationId;

    const context: CommandContext = {
      senderId,
      senderName: channelMessage.sender.displayName ?? channelMessage.sender.username,
      channelId,
      platform,
      conversationId: currentConversationId,
      currentModel,
      currentProvider,
      conversationManager: this.conversationManager,
      providerRegistry: this.providerRegistry,
      providerAuthService: this.providerAuthService,
      setModel: (model) => {
        currentModel = model;
      },
      setProvider: (provider) => {
        currentProvider = provider;
      },
      setConversationId: (id) => {
        currentConversationId = id;
      },
    };

    const pending = this.getPendingState(userId);
    if (pending && !text.startsWith("/")) {
      this.clearPendingState(userId);
      if (pending.command === "connect") {
        if (pending.step === "awaiting_auth_code") {
          const { handleOAuthCodeReply } = await import("./handlers/connect");
          return handleOAuthCodeReply(text, pending, context);
        }
        const { handleConnectReply } = await import("./handlers/connect");
        return handleConnectReply(text, pending, context);
      }
      return null;
    }

    const parsed = parseCommand(text, this.registry);
    if (!parsed) {
      return null;
    }

    const commandDef = this.registry.get(parsed.name);
    if (!commandDef) {
      return null;
    }

    const result = await commandDef.handler(context, parsed.args);

    if (parsed.name === "connect" && result.kind === "menu") {
      this.setPendingState(userId, {
        command: "connect",
        step: "awaiting_provider_selection",
        data: {},
        createdAt: Date.now(),
      });
    } else if (parsed.name === "connect" && result.kind === "text" && result.oauthPending) {
      // Direct `/connect <provider>` for an OAuth provider — wait for code paste.
      this.setPendingState(userId, {
        command: "connect",
        step: "awaiting_auth_code",
        data: {
          selectedProvider: result.oauthPending.provider,
          oauthState: result.oauthPending.state,
          ...(result.oauthPending.codeVerifier
            ? { oauthCodeVerifier: result.oauthPending.codeVerifier }
            : {}),
        },
        createdAt: Date.now(),
      });
    }

    return result;
  }

  /**
   * Dispatch a callback interaction (e.g., Telegram callback_query id).
   */
  public async dispatchCallback(
    callbackId: string,
    channelMessage: ChannelMessage,
    channel: Channel,
    userId: string,
    conversationId?: string,
  ): Promise<CommandResult | null> {
    const senderId = channelMessage.sender.id;
    const channelId = channel.config.id;
    const platform = channel.config.platform as ChannelPlatform;

    const authResult = await checkCommandAuthorization(channelId, senderId, this.authService);
    if (!authResult.authorized) {
      return authResult.result;
    }

    const pending = this.getPendingState(userId);

    let currentModel: string | undefined;
    let currentProvider: string | undefined;
    let currentConversationId: string | undefined = conversationId;

    const context: CommandContext = {
      senderId,
      senderName: channelMessage.sender.displayName ?? channelMessage.sender.username,
      channelId,
      platform,
      conversationId: currentConversationId,
      currentModel,
      currentProvider,
      conversationManager: this.conversationManager,
      providerRegistry: this.providerRegistry,
      providerAuthService: this.providerAuthService,
      setModel: (model) => {
        currentModel = model;
      },
      setProvider: (provider) => {
        currentProvider = provider;
      },
      setConversationId: (id) => {
        currentConversationId = id;
      },
    };

    if (callbackId.startsWith("connect:")) {
      if (!pending) {
        return {
          kind: "text",
          text: "Session expired. Please run `/connect` again.",
          success: false,
          error: "SESSION_EXPIRED",
        };
      }

      const { handleConnectCallback } = await import("./handlers/connect");
      const result = await handleConnectCallback(callbackId, pending, context);

      if (result.kind === "text" && result.success && callbackId !== "connect:cancel") {
        if (result.oauthPending) {
          // OAuth provider — wait for the user to paste the authorization code.
          this.setPendingState(userId, {
            command: "connect",
            step: "awaiting_auth_code",
            data: {
              selectedProvider: result.oauthPending.provider,
              oauthState: result.oauthPending.state,
              ...(result.oauthPending.codeVerifier
                ? { oauthCodeVerifier: result.oauthPending.codeVerifier }
                : {}),
            },
            createdAt: Date.now(),
          });
        } else {
          const provider = callbackId.slice("connect:".length);
          this.setPendingState(userId, {
            command: "connect",
            step: "awaiting_api_key",
            data: { selectedProvider: provider },
            createdAt: Date.now(),
          });
        }
      } else {
        this.clearPendingState(userId);
      }

      return result;
    }

    if (callbackId.startsWith("disconnect:")) {
      const provider = callbackId.slice("disconnect:".length);
      const { disconnectHandler } = await import("./handlers/disconnect");
      return disconnectHandler(context, [provider]);
    }

    return null;
  }

  /**
   * Get active (non-expired) pending state for a user.
   */
  public getPendingState(userId: string): PendingCommandState | undefined {
    const state = this.pendingState.get(userId);
    if (!state) {
      return undefined;
    }

    if (Date.now() - state.createdAt > PENDING_COMMAND_TTL_MS) {
      this.pendingState.delete(userId);
      return undefined;
    }

    return state;
  }

  /**
   * Set pending state for a user. Replaces any existing state.
   */
  public setPendingState(userId: string, state: PendingCommandState): void {
    this.pendingState.set(userId, state);
  }

  /**
   * Clear pending state for a user.
   */
  public clearPendingState(userId: string): void {
    this.pendingState.delete(userId);
  }
}

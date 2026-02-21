import type { ChannelSource, Message } from "../conversation/types";
import type { CreateOptions, HistoryOptions } from "../conversation/manager";
import {
  ChannelRouter,
  type AgentResponse,
  type ChannelRouterOptions,
  type RouteInboundResult,
} from "./router";
import type { Channel, ChannelMessage } from "./types";

interface ConversationBridgeConversationManager {
  create(options: CreateOptions): Promise<{ id: string }>;
  addMessage(
    conversationId: string,
    message: {
      role: "user" | "assistant" | "system" | "tool";
      content: string | Message["content"];
      channelSource?: ChannelSource;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Message>;
  getHistory(conversationId: string, options?: HistoryOptions): Promise<Message[]>;
}

export interface ConversationBridgeOptions
  extends Omit<ChannelRouterOptions, "conversationManager"> {
  conversationManager: ConversationBridgeConversationManager;
  userKeyResolver?: (channelMessage: ChannelMessage) => string | undefined;
}

/**
 * Wraps ChannelRouter to enforce unified conversation context across channels.
 */
export class ConversationBridge {
  private readonly conversationManager: ConversationBridgeConversationManager;
  private readonly router: ChannelRouter;
  private readonly userKeyResolver: (channelMessage: ChannelMessage) => string | undefined;

  private readonly conversationByUserKey = new Map<string, string>();
  private readonly dedupeMessageIdByKey = new Map<string, string>();

  constructor(options: ConversationBridgeOptions) {
    this.conversationManager = options.conversationManager;
    this.userKeyResolver = options.userKeyResolver ?? defaultUserKeyResolver;
    this.router = new ChannelRouter({
      ...options,
      conversationManager: {
        create: (createOptions) => this.conversationManager.create(createOptions),
        addMessage: (conversationId, message) => this.addMessage(conversationId, message),
      },
    });
  }

  /**
   * Routes an inbound channel message into the shared conversation timeline.
   */
  public async routeInbound(
    channelMessage: ChannelMessage,
    sourceChannel: Channel,
  ): Promise<RouteInboundResult> {
    const userKey = this.userKeyResolver(channelMessage);
    const mappedConversationId =
      userKey && !channelMessage.conversationId
        ? this.conversationByUserKey.get(userKey)
        : undefined;

    const messageWithConversation =
      mappedConversationId
        ? {
            ...channelMessage,
            conversationId: mappedConversationId,
          }
        : channelMessage;

    const result = await this.router.routeInbound(messageWithConversation, sourceChannel);

    if (userKey) {
      this.conversationByUserKey.set(userKey, result.conversationId);
    }

    return result;
  }

  /**
   * Routes an assistant response to the source channel or broadcast targets.
   */
  public async routeOutbound(agentResponse: AgentResponse, sourceChannel: Channel): Promise<void> {
    await this.router.routeOutbound(agentResponse, sourceChannel);
  }

  /**
   * Binds a unified user key to an existing conversation.
   */
  public bindUserConversation(userKey: string, conversationId: string): void {
    this.conversationByUserKey.set(userKey, conversationId);
  }

  /**
   * Reads the currently mapped conversation for a unified user key.
   */
  public getConversationForUser(userKey: string): string | undefined {
    return this.conversationByUserKey.get(userKey);
  }

  private async addMessage(
    conversationId: string,
    message: {
      role: "user" | "assistant" | "system" | "tool";
      content: Message["content"];
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ id: string }> {
    const channelSource = parseChannelSource(message.metadata);
    const channelMessageId =
      typeof message.metadata?.channelMessageId === "string"
        ? message.metadata.channelMessageId
        : undefined;

    if (channelSource && channelMessageId) {
      const dedupeKey = buildDedupeKey(conversationId, message.role, channelSource, channelMessageId);
      const knownMessageId = this.dedupeMessageIdByKey.get(dedupeKey);
      if (knownMessageId) {
        return { id: knownMessageId };
      }

      const existingMessages = await this.conversationManager.getHistory(conversationId, { limit: 200 });
      const duplicate = existingMessages.find((existingMessage) => {
        if (existingMessage.role !== message.role) {
          return false;
        }

        const existingChannelMessageId =
          typeof existingMessage.metadata?.channelMessageId === "string"
            ? existingMessage.metadata.channelMessageId
            : undefined;

        return (
          existingChannelMessageId === channelMessageId
          && existingMessage.channelSource?.platform === channelSource.platform
          && existingMessage.channelSource?.channelId === channelSource.channelId
        );
      });

      if (duplicate) {
        this.dedupeMessageIdByKey.set(dedupeKey, duplicate.id);
        return { id: duplicate.id };
      }
    }

    const created = await this.conversationManager.addMessage(conversationId, {
      ...message,
      channelSource,
    });

    if (channelSource && channelMessageId) {
      const dedupeKey = buildDedupeKey(conversationId, message.role, channelSource, channelMessageId);
      this.dedupeMessageIdByKey.set(dedupeKey, created.id);
    }

    return { id: created.id };
  }
}

function parseChannelSource(metadata: Record<string, unknown> | undefined): ChannelSource | undefined {
  if (!metadata?.channelSource || typeof metadata.channelSource !== "object") {
    return undefined;
  }

  const source = metadata.channelSource as Record<string, unknown>;
  const platform = source.platform;
  const channelId = source.channelId;

  if (
    (platform === "tui" || platform === "telegram" || platform === "discord")
    && typeof channelId === "string"
    && channelId.length > 0
  ) {
    return {
      platform,
      channelId,
    };
  }

  return undefined;
}

function buildDedupeKey(
  conversationId: string,
  role: "user" | "assistant" | "system" | "tool",
  channelSource: ChannelSource,
  channelMessageId: string,
): string {
  return `${conversationId}:${role}:${channelSource.platform}:${channelSource.channelId}:${channelMessageId}`;
}

function defaultUserKeyResolver(channelMessage: ChannelMessage): string | undefined {
  const unifiedUserId = channelMessage.platformData?.unified_user_id;
  if (typeof unifiedUserId === "string" && unifiedUserId.length > 0) {
    return unifiedUserId;
  }

  const senderId = channelMessage.sender.id.trim();
  if (senderId.length === 0) {
    return undefined;
  }

  return `${channelMessage.platform}:${senderId}`;
}

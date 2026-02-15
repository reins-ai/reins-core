import { ChannelError } from "../errors";
import type {
  Channel,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
} from "../types";
import { normalizeDiscordMessage, toDiscordEmbed, toDiscordMessage } from "./normalize";
import type { DiscordClient } from "./client";
import { DiscordGateway } from "./gateway";
import type { DiscordGatewayWebSocket } from "./gateway";
import type { DiscordEmbed, DiscordGatewayIdentifyProperties, DiscordMessage, DiscordUser } from "./types";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

type ReconnectTimer = ReturnType<typeof setTimeout>;

interface DiscordChannelClient {
  getCurrentUser(): Promise<DiscordUser>;
  sendTyping(channelId: string): Promise<unknown>;
  sendMessage(channelId: string, content: string): Promise<unknown>;
  sendEmbed(channelId: string, embed: DiscordEmbed): Promise<unknown>;
  uploadFile(channelId: string, file: { name: string; data: string; description?: string }): Promise<unknown>;
}

interface DiscordChannelGateway {
  readonly connected: boolean;
  readonly currentSequence: number | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onReady(handler: (event: { session_id: string; resume_gateway_url?: string }) => Promise<void> | void): () => void;
  onMessageCreate(handler: (message: DiscordMessage) => Promise<void> | void): () => void;
  onDisconnect(handler: (details: { code?: number; reason?: string; error?: string }) => Promise<void> | void): () => void;
  prepareResume(sessionId: string, sequence: number): void;
}

export interface DiscordChannelOptions {
  config: ChannelConfig;
  token: string;
  client: DiscordClient | DiscordChannelClient;
  gateway?: DiscordChannelGateway;
  gatewayFactory?: (options: { gatewayUrl?: string }) => DiscordChannelGateway;
  gatewayUrl?: string;
  intents?: number;
  identifyProperties?: DiscordGatewayIdentifyProperties;
  webSocketFactory?: (url: string) => DiscordGatewayWebSocket;
  normalizeMessageFn?: (message: DiscordMessage) => ChannelMessage | null;
  scheduleReconnectFn?: (callback: () => void, delayMs: number) => ReconnectTimer;
  clearReconnectFn?: (timer: ReconnectTimer) => void;
  nowFn?: () => number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

/**
 * Discord channel implementation with gateway lifecycle and resume-aware reconnection.
 */
export class DiscordChannel implements Channel {
  public readonly config: ChannelConfig;

  private readonly token: string;
  private readonly client: DiscordChannelClient;
  private readonly gatewayFactory?: (options: { gatewayUrl?: string }) => DiscordChannelGateway;
  private readonly injectedGateway?: DiscordChannelGateway;
  private readonly normalizeMessageFn: (message: DiscordMessage) => ChannelMessage | null;
  private readonly scheduleReconnectFn: (callback: () => void, delayMs: number) => ReconnectTimer;
  private readonly clearReconnectFn: (timer: ReconnectTimer) => void;
  private readonly nowFn: () => number;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly intents?: number;
  private readonly identifyProperties?: DiscordGatewayIdentifyProperties;
  private readonly webSocketFactory?: (url: string) => DiscordGatewayWebSocket;
  private readonly initialGatewayUrl?: string;

  private readonly handlers = new Set<ChannelMessageHandler>();

  private statusState: ChannelStatus = {
    state: "disconnected",
    uptimeMs: 0,
  };

  private gateway: DiscordChannelGateway | null = null;
  private gatewayUnsubscribers: Array<() => void> = [];
  private reconnectTimer: ReconnectTimer | null = null;
  private connectedAtMs: number | null = null;
  private reconnectAttempts = 0;
  private shouldRun = false;
  private isDisconnecting = false;
  private sessionId: string | null = null;
  private lastSequence: number | null = null;
  private resumeGatewayUrl: string | undefined;
  private activeGatewayUrl: string | undefined;

  constructor(options: DiscordChannelOptions) {
    const token = options.token.trim();
    if (token.length === 0) {
      throw new ChannelError("Discord bot token is required");
    }

    this.config = options.config;
    this.token = token;
    this.client = options.client;
    this.injectedGateway = options.gateway;
    this.gatewayFactory = options.gatewayFactory;
    this.initialGatewayUrl = options.gatewayUrl;
    this.intents = options.intents;
    this.identifyProperties = options.identifyProperties;
    this.webSocketFactory = options.webSocketFactory;
    this.normalizeMessageFn = options.normalizeMessageFn ?? normalizeDiscordMessage;
    this.scheduleReconnectFn = options.scheduleReconnectFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearReconnectFn = options.clearReconnectFn ?? ((timer) => {
      clearTimeout(timer);
    });
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? INITIAL_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS;
  }

  /**
   * Current channel status with live uptime while connected.
   */
  public get status(): ChannelStatus {
    if (this.connectedAtMs === null) {
      return {
        ...this.statusState,
        uptimeMs: 0,
      };
    }

    return {
      ...this.statusState,
      uptimeMs: Math.max(0, this.nowFn() - this.connectedAtMs),
    };
  }

  /**
   * Validates credentials and opens the Discord Gateway connection.
   */
  public async connect(): Promise<void> {
    if (this.shouldRun) {
      return;
    }

    this.shouldRun = true;
    this.isDisconnecting = false;
    this.reconnectAttempts = 0;
    this.updateStatus("connecting");

    try {
      await this.client.getCurrentUser();
      await this.connectGateway(false);
    } catch (error) {
      this.shouldRun = false;
      const connectError = toError(error);
      this.updateStatus("error", connectError.message);
      throw new ChannelError(`Failed to connect Discord channel ${this.config.id}: ${connectError.message}`);
    }
  }

  /**
   * Closes the Discord Gateway connection and resets runtime state.
   */
  public async disconnect(): Promise<void> {
    this.shouldRun = false;
    this.isDisconnecting = true;

    if (this.reconnectTimer !== null) {
      this.clearReconnectFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.gateway !== null) {
      await this.gateway.disconnect();
    }

    this.teardownGatewayListeners();
    this.gateway = null;
    this.connectedAtMs = null;
    this.reconnectAttempts = 0;
    this.sessionId = null;
    this.lastSequence = null;
    this.resumeGatewayUrl = undefined;
    this.activeGatewayUrl = undefined;
    this.updateStatus("disconnected");
    this.isDisconnecting = false;
  }

  /**
   * Sends an outbound normalized message through Discord REST endpoints.
   */
  public async send(message: ChannelMessage): Promise<void> {
    if (this.statusState.state !== "connected") {
      throw new ChannelError(`Discord channel ${this.config.id} is not connected`);
    }

    const sendAsEmbed = message.platformData?.send_as_embed === true;
    if (sendAsEmbed) {
      const embedMessage = toDiscordEmbed(message);
      if (embedMessage === null) {
        throw new ChannelError("Cannot send Discord embed without channel_id and text");
      }

      await this.client.sendEmbed(embedMessage.channelId, embedMessage.embed);
      return;
    }

    const outbound = toDiscordMessage(message);
    if (outbound === null) {
      throw new ChannelError("Cannot send Discord message without channel_id and sendable content");
    }

    if (outbound.chunks !== undefined) {
      for (const chunk of outbound.chunks) {
        await this.client.sendMessage(outbound.channelId, chunk);
      }
      return;
    }

    if (outbound.content !== undefined) {
      await this.client.sendMessage(outbound.channelId, outbound.content);
      return;
    }

    if (outbound.file !== undefined) {
      await this.client.uploadFile(outbound.channelId, {
        name: outbound.file.fileName ?? "attachment.bin",
        data: outbound.file.url,
        description: outbound.file.description,
      });
      return;
    }

    throw new ChannelError("Unsupported Discord outbound message payload");
  }

  /**
   * Registers a callback for inbound Discord MESSAGE_CREATE events.
   */
  public onMessage(handler: ChannelMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  public async sendTypingIndicator(destinationChannelId: string): Promise<void> {
    await this.client.sendTyping(destinationChannelId);
  }

  private getOrCreateGateway(gatewayUrl?: string): DiscordChannelGateway {
    if (this.injectedGateway !== undefined) {
      if (this.gateway === null) {
        this.gateway = this.injectedGateway;
        this.activeGatewayUrl = gatewayUrl;
        this.setupGatewayListeners(this.gateway);
      }

      return this.gateway;
    }

    const shouldRotateGateway = this.gatewayFactory !== undefined
      && this.gateway !== null
      && gatewayUrl !== undefined
      && gatewayUrl !== this.activeGatewayUrl;

    if (this.gateway !== null && !shouldRotateGateway) {
      return this.gateway;
    }

    this.teardownGatewayListeners();

    this.gateway = this.gatewayFactory?.({ gatewayUrl }) ?? new DiscordGateway({
      token: this.token,
      gatewayUrl: gatewayUrl ?? this.initialGatewayUrl,
      intents: this.intents,
      identifyProperties: this.identifyProperties,
      webSocketFactory: this.webSocketFactory,
    });
    this.activeGatewayUrl = gatewayUrl;
    this.setupGatewayListeners(this.gateway);
    return this.gateway;
  }

  private setupGatewayListeners(gateway: DiscordChannelGateway): void {
    const unsubscribeMessage = gateway.onMessageCreate(async (message) => {
      this.lastSequence = gateway.currentSequence;
      const normalized = this.normalizeMessageFn(message);
      if (normalized === null) {
        return;
      }

      for (const handler of this.handlers) {
        try {
          await handler(normalized);
        } catch (error) {
          const handlerError = toError(error);
          this.statusState.lastError = `Message handler failed: ${handlerError.message}`;
        }
      }
    });

    const unsubscribeReady = gateway.onReady((event) => {
      this.sessionId = event.session_id;
      if (event.resume_gateway_url !== undefined && event.resume_gateway_url.length > 0) {
        this.resumeGatewayUrl = event.resume_gateway_url;
      }

      this.connectedAtMs = this.nowFn();
      this.reconnectAttempts = 0;
      this.updateStatus("connected");
    });

    const unsubscribeDisconnect = gateway.onDisconnect((details) => {
      this.lastSequence = gateway.currentSequence;
      this.connectedAtMs = null;

      if (!this.shouldRun || this.isDisconnecting) {
        return;
      }

      const reason = details.error ?? details.reason ?? "Discord Gateway disconnected";
      this.scheduleReconnect(reason);
    });

    this.gatewayUnsubscribers = [unsubscribeMessage, unsubscribeReady, unsubscribeDisconnect];
  }

  private teardownGatewayListeners(): void {
    for (const unsubscribe of this.gatewayUnsubscribers) {
      unsubscribe();
    }
    this.gatewayUnsubscribers = [];
  }

  private async connectGateway(isReconnect: boolean): Promise<void> {
    const gatewayUrl = isReconnect ? this.resumeGatewayUrl : this.initialGatewayUrl;
    const gateway = this.getOrCreateGateway(gatewayUrl);

    const canResume = isReconnect && this.sessionId !== null && this.lastSequence !== null;
    if (canResume) {
      const sessionId = this.sessionId;
      const sequence = this.lastSequence;
      if (sessionId !== null && sequence !== null) {
        gateway.prepareResume(sessionId, sequence);
      }
    }

    await gateway.connect();
  }

  private scheduleReconnect(reason: string): void {
    if (!this.shouldRun) {
      return;
    }

    this.updateStatus("reconnecting", reason);
    if (this.reconnectTimer !== null) {
      return;
    }

    const delayMs = this.calculateReconnectDelayMs(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = this.scheduleReconnectFn(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delayMs);
  }

  private async reconnect(): Promise<void> {
    if (!this.shouldRun) {
      return;
    }

    try {
      await this.connectGateway(true);
    } catch (error) {
      const reconnectError = toError(error);
      this.scheduleReconnect(reconnectError.message);
    }
  }

  private calculateReconnectDelayMs(attempt: number): number {
    return Math.min(this.initialReconnectDelayMs * Math.pow(2, attempt), this.maxReconnectDelayMs);
  }

  private updateStatus(state: ChannelStatus["state"], lastError?: string): void {
    this.statusState = {
      state,
      lastError,
      uptimeMs: state === "connected" && this.connectedAtMs !== null
        ? Math.max(0, this.nowFn() - this.connectedAtMs)
        : 0,
    };
  }
}

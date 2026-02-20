import {
  ChannelError,
  DiscordChannel,
  DiscordClient,
  TelegramChannel,
  TelegramClient,
  type Channel,
  type ChannelMessage,
  type ChannelPlatform,
} from "../channels";

interface ChannelTokenRecord {
  platform: ChannelPlatform;
}

export interface ChannelRegistryLike {
  register(channel: Channel): void;
  get(id: string): Channel | undefined;
  list(): Channel[];
  remove(id: string): boolean;
  enable(id: string): boolean;
  disable(id: string): boolean;
}

export interface ConversationBridgeLike {
  routeInbound(
    channelMessage: ChannelMessage,
    sourceChannel: Channel,
  ): Promise<{
    conversationId: string;
    assistantMessageId: string;
    source: {
      channelId: string;
      platform: ChannelPlatform;
    };
  }>;
  routeOutbound(
    agentResponse: {
      conversationId: string;
      text: string;
      assistantMessageId?: string;
      metadata?: Record<string, unknown>;
    },
    sourceChannel: Channel,
  ): Promise<void>;
}

export interface ChannelCredentialStorageLike {
  saveToken(platform: ChannelPlatform, token: string): Promise<unknown>;
  getToken(platform: ChannelPlatform): Promise<string | null>;
  deleteToken(platform: ChannelPlatform): Promise<boolean>;
  listTokens(): Promise<ChannelTokenRecord[]>;
}

export interface ChannelHealthStatus {
  channelId: string;
  platform: ChannelPlatform;
  enabled: boolean;
  state: "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
  uptimeMs: number;
  healthy: boolean;
  lastError?: string;
  lastMessageAt?: string;
  checkedAt: string;
}

export interface ChannelStatusSummary {
  total: number;
  enabled: number;
  healthy: number;
  unhealthy: number;
}

export interface ChannelServiceStatusSnapshot {
  channels: ChannelHealthStatus[];
  summary: ChannelStatusSummary;
}

export interface ChannelDaemonServiceOptions {
  channelRegistry: ChannelRegistryLike;
  conversationBridge: ConversationBridgeLike;
  credentialStorage: ChannelCredentialStorageLike;
  onInboundAssistantPending?: (context: {
    conversationId: string;
    assistantMessageId: string;
    sourceChannelId: string;
    sourcePlatform: ChannelPlatform;
  }) => Promise<void> | void;
  channelFactory?: (platform: ChannelPlatform, channelId: string, token: string) => Channel;
  nowFn?: () => Date;
}

interface ChannelDiagnostics {
  lastMessageAt?: Date;
  lastError?: string;
}

function defaultChannelId(platform: ChannelPlatform): string {
  return platform;
}

function createDefaultChannel(platform: ChannelPlatform, channelId: string, token: string): Channel {
  if (platform === "telegram") {
    const client = new TelegramClient({ token });
    return new TelegramChannel({
      config: {
        id: channelId,
        platform,
        tokenReference: `channel:${platform}`,
        enabled: true,
      },
      client,
    });
  }

  const client = new DiscordClient({ token });
  return new DiscordChannel({
    config: {
      id: channelId,
      platform,
      tokenReference: `channel:${platform}`,
      enabled: true,
    },
    token,
    client,
  });
}

/**
 * Daemon orchestration layer for channel lifecycle and health visibility.
 */
export class ChannelDaemonService {
  private readonly channelRegistry: ChannelRegistryLike;
  private readonly conversationBridge: ConversationBridgeLike;
  private readonly credentialStorage: ChannelCredentialStorageLike;
  private readonly channelFactory: (platform: ChannelPlatform, channelId: string, token: string) => Channel;
  private readonly onInboundAssistantPending?: (context: {
    conversationId: string;
    assistantMessageId: string;
    sourceChannelId: string;
    sourcePlatform: ChannelPlatform;
  }) => Promise<void> | void;
  private readonly nowFn: () => Date;

  private readonly inboundUnsubscribers = new Map<string, () => void>();
  private readonly diagnosticsByChannelId = new Map<string, ChannelDiagnostics>();
  private readonly sourceChannelIdByConversationId = new Map<string, string>();
  private started = false;

  constructor(options: ChannelDaemonServiceOptions) {
    this.channelRegistry = options.channelRegistry;
    this.conversationBridge = options.conversationBridge;
    this.credentialStorage = options.credentialStorage;
    this.channelFactory = options.channelFactory ?? createDefaultChannel;
    this.onInboundAssistantPending = options.onInboundAssistantPending;
    this.nowFn = options.nowFn ?? (() => new Date());
  }

  /**
   * Auto-start enabled channels discovered from stored credentials.
   */
  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const tokenRecords = await this.credentialStorage.listTokens();
    for (const tokenRecord of tokenRecords) {
      const channelId = defaultChannelId(tokenRecord.platform);
      let channel = this.channelRegistry.get(channelId);

      if (!channel) {
        const token = await this.credentialStorage.getToken(tokenRecord.platform);
        if (!token) {
          continue;
        }

        channel = this.channelFactory(tokenRecord.platform, channelId, token);
        this.channelRegistry.register(channel);
      }

      if (channel.config.enabled) {
        await this.startChannel(channel);
      }
    }

    this.started = true;
  }

  /**
   * Stop all active channels and detach message handlers.
   */
  public async stop(): Promise<void> {
    const channels = this.channelRegistry.list();
    for (const channel of channels) {
      await this.stopChannel(channel);
    }

    this.inboundUnsubscribers.clear();
    this.started = false;
  }

  /**
   * Add a new channel token, register channel instance, and connect immediately.
   */
  public async addChannel(platform: ChannelPlatform, token: string, channelId?: string): Promise<ChannelHealthStatus> {
    const trimmedToken = token.trim();
    if (trimmedToken.length === 0) {
      throw new ChannelError("Channel token is required");
    }

    await this.credentialStorage.saveToken(platform, trimmedToken);

    const resolvedChannelId = (channelId ?? defaultChannelId(platform)).trim();
    if (resolvedChannelId.length === 0) {
      throw new ChannelError("Channel id is required");
    }

    const existingChannel = this.channelRegistry.get(resolvedChannelId);
    if (existingChannel) {
      await this.removeChannel(resolvedChannelId);
    }

    const channel = this.channelFactory(platform, resolvedChannelId, trimmedToken);
    this.channelRegistry.register(channel);
    this.channelRegistry.enable(resolvedChannelId);

    await this.startChannel(channel);
    return this.buildChannelHealthStatus(channel);
  }

  /**
   * Remove a channel by id, stopping active connections and deleting stored credentials.
   */
  public async removeChannel(channelId: string): Promise<boolean> {
    const channel = this.channelRegistry.get(channelId);
    if (!channel) {
      return false;
    }

    await this.stopChannel(channel);
    const removed = this.channelRegistry.remove(channelId);
    this.diagnosticsByChannelId.delete(channel.config.id);
    for (const [conversationId, sourceChannelId] of this.sourceChannelIdByConversationId.entries()) {
      if (sourceChannelId === channel.config.id) {
        this.sourceChannelIdByConversationId.delete(conversationId);
      }
    }
    await this.credentialStorage.deleteToken(channel.config.platform);
    return removed;
  }

  /**
   * Forward a completed assistant response to the channel that initiated
   * the conversation.
   */
  public async forwardAssistantResponse(
    conversationId: string,
    assistantText: string,
    assistantMessageId?: string,
  ): Promise<boolean> {
    const sourceChannelId = this.sourceChannelIdByConversationId.get(conversationId);
    if (!sourceChannelId) {
      return false;
    }

    const sourceChannel = this.channelRegistry.get(sourceChannelId);
    if (!sourceChannel || !sourceChannel.config.enabled) {
      return false;
    }

    if (assistantText.trim().length === 0) {
      return false;
    }

    try {
      await this.conversationBridge.routeOutbound(
        {
          conversationId,
          text: assistantText,
          assistantMessageId,
        },
        sourceChannel,
      );
      this.updateDiagnostics(sourceChannel.config.id, { lastError: undefined });
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateDiagnostics(sourceChannel.config.id, { lastError: errorMessage });
      throw new ChannelError(
        `Failed to forward assistant response for conversation ${conversationId}: ${errorMessage}`,
      );
    }
  }

  /**
   * Enable a configured channel and establish connection if daemon is active.
   */
  public async enableChannel(channelId: string): Promise<ChannelHealthStatus> {
    const channel = this.requireChannel(channelId);
    this.channelRegistry.enable(channelId);

    if (this.started) {
      await this.startChannel(channel);
    }

    return this.buildChannelHealthStatus(channel);
  }

  /**
   * Disable a configured channel and terminate active connection.
   */
  public async disableChannel(channelId: string): Promise<ChannelHealthStatus> {
    const channel = this.requireChannel(channelId);
    this.channelRegistry.disable(channelId);
    await this.stopChannel(channel);
    return this.buildChannelHealthStatus(channel);
  }

  /**
   * Return current health and status for a single channel.
   */
  public getChannelStatus(channelId: string): ChannelHealthStatus | undefined {
    const channel = this.channelRegistry.get(channelId);
    if (!channel) {
      return undefined;
    }

    return this.buildChannelHealthStatus(channel);
  }

  /**
   * List health and status details for all configured channels.
   */
  public listChannels(): ChannelHealthStatus[] {
    return this.channelRegistry.list().map((channel) => this.buildChannelHealthStatus(channel));
  }

  /**
   * Verify a channel is reachable and return its current health status.
   * Serves as a lightweight connectivity check for the /channels/:id/test endpoint.
   */
  public testChannel(channelId: string): ChannelHealthStatus {
    return this.buildChannelHealthStatus(this.requireChannel(channelId));
  }

  /**
   * Return aggregate channel health counters for daemon status views.
   */
  public getStatusSnapshot(): ChannelServiceStatusSnapshot {
    const channels = this.listChannels();
    const summary: ChannelStatusSummary = {
      total: channels.length,
      enabled: channels.filter((channel) => channel.enabled).length,
      healthy: channels.filter((channel) => channel.healthy).length,
      unhealthy: channels.filter((channel) => channel.enabled && !channel.healthy).length,
    };

    return {
      channels,
      summary,
    };
  }

  private requireChannel(channelId: string): Channel {
    const channel = this.channelRegistry.get(channelId);
    if (!channel) {
      throw new ChannelError(`Channel not found: ${channelId}`);
    }

    return channel;
  }

  private async startChannel(channel: Channel): Promise<void> {
    if (!channel.config.enabled) {
      return;
    }

    if (!this.inboundUnsubscribers.has(channel.config.id)) {
      const unsubscribe = channel.onMessage(async (message) => {
        this.updateDiagnostics(channel.config.id, {
          lastMessageAt: this.nowFn(),
        });

        if (typeof channel.sendTypingIndicator === "function") {
          try {
            await channel.sendTypingIndicator(message.channelId);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.updateDiagnostics(channel.config.id, {
              lastError: `Typing indicator failed: ${errorMessage}`,
            });
          }
        }

        try {
          const inboundResult = await this.conversationBridge.routeInbound(message, channel);
          this.sourceChannelIdByConversationId.set(
            inboundResult.conversationId,
            inboundResult.source.channelId,
          );
          if (this.onInboundAssistantPending) {
            await this.onInboundAssistantPending({
              conversationId: inboundResult.conversationId,
              assistantMessageId: inboundResult.assistantMessageId,
              sourceChannelId: inboundResult.source.channelId,
              sourcePlatform: inboundResult.source.platform,
            });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.updateDiagnostics(channel.config.id, {
            lastError: errorMessage,
          });
        }
      });

      this.inboundUnsubscribers.set(channel.config.id, unsubscribe);
    }

    if (channel.status.state === "connected") {
      return;
    }

    try {
      await channel.connect();
      this.updateDiagnostics(channel.config.id, { lastError: undefined });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateDiagnostics(channel.config.id, { lastError: errorMessage });
      throw new ChannelError(`Failed to start channel ${channel.config.id}: ${errorMessage}`);
    }
  }

  private async stopChannel(channel: Channel): Promise<void> {
    const unsubscribe = this.inboundUnsubscribers.get(channel.config.id);
    if (unsubscribe) {
      unsubscribe();
      this.inboundUnsubscribers.delete(channel.config.id);
    }

    if (channel.status.state === "disconnected") {
      return;
    }

    try {
      await channel.disconnect();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateDiagnostics(channel.config.id, { lastError: errorMessage });
      throw new ChannelError(`Failed to stop channel ${channel.config.id}: ${errorMessage}`);
    }
  }

  private updateDiagnostics(channelId: string, updates: Partial<ChannelDiagnostics>): void {
    const current = this.diagnosticsByChannelId.get(channelId) ?? {};
    this.diagnosticsByChannelId.set(channelId, {
      ...current,
      ...updates,
    });
  }

  private buildChannelHealthStatus(channel: Channel): ChannelHealthStatus {
    const diagnostics = this.diagnosticsByChannelId.get(channel.config.id);
    const lastError = diagnostics?.lastError ?? channel.status.lastError;

    return {
      channelId: channel.config.id,
      platform: channel.config.platform,
      enabled: channel.config.enabled,
      state: channel.status.state,
      uptimeMs: channel.status.uptimeMs,
      healthy: channel.config.enabled && channel.status.state === "connected",
      lastError,
      lastMessageAt: diagnostics?.lastMessageAt?.toISOString(),
      checkedAt: this.nowFn().toISOString(),
    };
  }
}

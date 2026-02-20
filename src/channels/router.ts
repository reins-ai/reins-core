import { generateId } from "../conversation/id";
import type {
  CreateOptions,
  SendMessageResult,
} from "../conversation/manager";
import { ChannelError } from "./errors";
import {
  chunkTelegramMessage,
  formatForDiscord,
  formatForTelegram,
} from "./formatting";
import type {
  Channel,
  ChannelAttachment,
  ChannelFormatting,
  ChannelMessage,
  ChannelPlatform,
  ChannelVoice,
} from "./types";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

export interface ChannelRouterConversationManager {
  create(options: CreateOptions): Promise<{ id: string }>;
  addMessage(
    conversationId: string,
    message: {
      role: "user" | "assistant" | "system" | "tool";
      content: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ id: string }>;
}

export interface ChannelRouterChannelRegistry {
  list(): Channel[];
}

export interface ChannelSourceAttribution {
  channelId: string;
  platform: ChannelPlatform;
}

export interface ChannelRouteContext {
  source: ChannelSourceAttribution;
  destinationChannelId: string;
}

export interface ChannelRouterOptions {
  conversationManager: ChannelRouterConversationManager;
  channelRegistry?: ChannelRouterChannelRegistry;
  broadcastResponses?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
  nowFn?: () => Date;
}

export interface RouteInboundResult extends SendMessageResult {
  source: ChannelSourceAttribution;
}

export interface AgentResponse {
  conversationId: string;
  text: string;
  assistantMessageId?: string;
  attachments?: ChannelAttachment[];
  formatting?: ChannelFormatting;
  voice?: ChannelVoice;
  metadata?: Record<string, unknown>;
}

/**
 * Bridges normalized channel messages into ConversationManager and
 * forwards assistant responses back to channel adapters.
 */
export class ChannelRouter {
  private readonly conversationManager: ChannelRouterConversationManager;
  private readonly channelRegistry?: ChannelRouterChannelRegistry;
  private readonly broadcastResponses: boolean;
  private readonly defaultProvider: string;
  private readonly defaultModel: string;
  private readonly nowFn: () => Date;

  private readonly routeContextByConversationId = new Map<string, ChannelRouteContext>();
  private readonly destinationByChannelId = new Map<string, string>();

  constructor(options: ChannelRouterOptions) {
    this.conversationManager = options.conversationManager;
    this.channelRegistry = options.channelRegistry;
    this.broadcastResponses = options.broadcastResponses ?? false;
    this.defaultProvider = options.defaultProvider ?? DEFAULT_PROVIDER;
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.nowFn = options.nowFn ?? (() => new Date());
  }

  /**
   * Routes an inbound channel message into the unified conversation context.
   */
  public async routeInbound(
    channelMessage: ChannelMessage,
    sourceChannel: Channel,
  ): Promise<RouteInboundResult> {
    const content = this.toConversationContent(channelMessage);
    if (content.length === 0) {
      throw new ChannelError("Cannot route inbound message without text content");
    }

    const timestamp = this.nowFn();
    const source: ChannelSourceAttribution = {
      channelId: sourceChannel.config.id,
      platform: sourceChannel.config.platform,
    };

    const conversationId =
      channelMessage.conversationId ??
      (await this.createConversationFromInboundMessage(channelMessage, content));

    const channelSourceMetadata = {
      channelSource: {
        channelId: source.channelId,
        platform: source.platform,
      },
      channelMessageId: channelMessage.id,
      channelDestinationId: channelMessage.channelId,
      senderId: channelMessage.sender.id,
    };

    const userMessage = await this.conversationManager.addMessage(conversationId, {
      role: "user",
      content,
      metadata: channelSourceMetadata,
    });

    const assistantMessage = await this.conversationManager.addMessage(conversationId, {
      role: "assistant",
      content: "",
      metadata: {
        ...channelSourceMetadata,
        provider: this.defaultProvider,
        model: this.defaultModel,
        status: "pending",
      },
    });

    this.routeContextByConversationId.set(conversationId, {
      source,
      destinationChannelId: channelMessage.channelId,
    });
    this.destinationByChannelId.set(source.channelId, channelMessage.channelId);

    return {
      conversationId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      timestamp,
      source,
    };
  }

  /**
   * Routes an assistant response to the originating channel or all active channels.
   */
  public async routeOutbound(agentResponse: AgentResponse, sourceChannel: Channel): Promise<void> {
    const routeContext = this.routeContextByConversationId.get(agentResponse.conversationId);
    const sourceDestination = this.destinationByChannelId.get(sourceChannel.config.id)
      ?? routeContext?.destinationChannelId;

    if (!sourceDestination) {
      throw new ChannelError(
        `No channel destination found for conversation ${agentResponse.conversationId}`,
      );
    }

    if (!this.broadcastResponses) {
      await this.sendToChannel(agentResponse, sourceChannel, sourceDestination);
      return;
    }

    const activeChannels = this.channelRegistry?.list() ?? [sourceChannel];
    const sendTasks: Promise<void>[] = [];

    for (const channel of activeChannels) {
      if (!channel.config.enabled || channel.status.state !== "connected") {
        continue;
      }

      const destination = this.destinationByChannelId.get(channel.config.id);
      if (!destination) {
        continue;
      }

      sendTasks.push(this.sendToChannel(agentResponse, channel, destination));
    }

    await Promise.all(sendTasks);
  }

  /**
   * Applies platform-specific formatting and sends the message to a channel.
   * Telegram messages are formatted as MarkdownV2 and chunked at 4096 chars.
   * Discord messages are formatted as Discord-compatible markdown.
   */
  private async sendToChannel(
    agentResponse: AgentResponse,
    channel: Channel,
    destinationChannelId: string,
  ): Promise<void> {
    const text = agentResponse.text ?? "";
    const platform = channel.config.platform;

    if (platform === "telegram" && text.length > 0) {
      const formatted = formatForTelegram(text);
      const chunks = chunkTelegramMessage(formatted);

      for (const chunk of chunks) {
        const outbound = this.toOutboundChannelMessage(
          { ...agentResponse, text: chunk },
          channel,
          destinationChannelId,
        );
        await channel.send(outbound);
      }
      return;
    }

    if (platform === "discord" && text.length > 0) {
      const formatted = formatForDiscord(text);
      const outbound = this.toOutboundChannelMessage(
        { ...agentResponse, text: formatted },
        channel,
        destinationChannelId,
      );
      await channel.send(outbound);
      return;
    }

    const outbound = this.toOutboundChannelMessage(
      agentResponse,
      channel,
      destinationChannelId,
    );
    await channel.send(outbound);
  }

  private toConversationContent(channelMessage: ChannelMessage): string {
    const text = channelMessage.text?.trim();
    if (text && text.length > 0) {
      return text;
    }

    const transcript = channelMessage.voice?.transcript?.trim();
    if (transcript && transcript.length > 0) {
      return transcript;
    }

    return "";
  }

  private async createConversationFromInboundMessage(
    channelMessage: ChannelMessage,
    content: string,
  ): Promise<string> {
    const titleBase = content.length > 0 ? content : `Message from ${channelMessage.platform}`;
    const createdConversation = await this.conversationManager.create({
      title: titleBase.slice(0, 50),
      model: this.defaultModel,
      provider: this.defaultProvider,
    });

    return createdConversation.id;
  }

  private toOutboundChannelMessage(
    agentResponse: AgentResponse,
    channel: Channel,
    destinationChannelId: string,
  ): ChannelMessage {
    return {
      id: generateId("msg"),
      platform: channel.config.platform,
      channelId: destinationChannelId,
      conversationId: agentResponse.conversationId,
      sender: {
        id: "reins-agent",
        displayName: "Reins",
        isBot: true,
      },
      timestamp: this.nowFn(),
      text: agentResponse.text,
      attachments: agentResponse.attachments,
      formatting: agentResponse.formatting,
      voice: agentResponse.voice,
      platformData: {
        ...(agentResponse.metadata ?? {}),
        source_channel_id: channel.config.id,
      },
    };
  }
}

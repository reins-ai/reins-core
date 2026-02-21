import type { Result } from "../result";
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

/**
 * Map a MIME type to a short file extension for transcription file names.
 */
function mimeExtensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/opus": "opus",
  };
  return map[mimeType] ?? "bin";
}

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

/**
 * Async function that transcribes an audio buffer and returns the text.
 * Injected into the router to enable voice message transcription.
 */
export type TranscribeFn = (
  buffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
) => Promise<Result<string, ChannelError>>;

export interface ChannelRouterOptions {
  conversationManager: ChannelRouterConversationManager;
  channelRegistry?: ChannelRouterChannelRegistry;
  broadcastResponses?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
  nowFn?: () => Date;
  /** Optional transcription function for voice messages. */
  transcribeFn?: TranscribeFn;
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
  private readonly transcribeFn?: TranscribeFn;

  private readonly routeContextByConversationId = new Map<string, ChannelRouteContext>();
  private readonly destinationByChannelId = new Map<string, string>();

  constructor(options: ChannelRouterOptions) {
    this.conversationManager = options.conversationManager;
    this.channelRegistry = options.channelRegistry;
    this.broadcastResponses = options.broadcastResponses ?? false;
    this.defaultProvider = options.defaultProvider ?? DEFAULT_PROVIDER;
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.nowFn = options.nowFn ?? (() => new Date());
    this.transcribeFn = options.transcribeFn;
  }

  /**
   * Guidance message returned when voice transcription is unavailable.
   */
  static readonly VOICE_GUIDANCE_MESSAGE =
    "Voice messages are not supported yet. " +
    "Add a GROQ_API_KEY to enable voice transcription.";

  /**
   * Routes an inbound channel message into the unified conversation context.
   *
   * When the message contains a voice payload without text or transcript,
   * the router attempts transcription via the injected `transcribeFn`.
   * If no transcription function is configured, a guidance reply is sent
   * back to the source channel.
   */
  public async routeInbound(
    channelMessage: ChannelMessage,
    sourceChannel: Channel,
  ): Promise<RouteInboundResult> {
    const message = await this.resolveVoiceContent(
      channelMessage,
      sourceChannel,
    );

    const content = this.toConversationContent(message);
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
          { ...agentResponse, text: chunk, formatting: { mode: "markdown_v2" } },
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

  /**
   * If the message has a voice payload but no text or transcript,
   * attempt transcription via the injected function. When transcription
   * is unavailable or fails, throw a ChannelError with guidance text
   * so the conversation bridge can relay it to the user.
   */
  private async resolveVoiceContent(
    channelMessage: ChannelMessage,
    _sourceChannel: Channel,
  ): Promise<ChannelMessage> {
    const hasText =
      (channelMessage.text?.trim().length ?? 0) > 0;
    const hasTranscript =
      (channelMessage.voice?.transcript?.trim().length ?? 0) > 0;

    if (!channelMessage.voice || hasText || hasTranscript) {
      return channelMessage;
    }

    if (!this.transcribeFn) {
      throw new ChannelError(ChannelRouter.VOICE_GUIDANCE_MESSAGE);
    }

    const voice = channelMessage.voice;
    const mimeType = voice.mimeType ?? "audio/ogg";
    const fileName = "voice." + mimeExtensionFromMime(mimeType);

    // Build a minimal buffer from the voice URL placeholder.
    // In production the caller (daemon service) downloads the file
    // before invoking the router. The transcribeFn receives the raw
    // audio buffer that was already downloaded by handleVoiceMessage.
    // Here we pass through the buffer that the caller attached to
    // platformData, or an empty buffer as a fallback.
    const audioBuffer =
      voice.platformData?.audioBuffer instanceof ArrayBuffer
        ? voice.platformData.audioBuffer
        : new ArrayBuffer(0);

    const result = await this.transcribeFn(audioBuffer, fileName, mimeType);
    if (!result.ok) {
      throw new ChannelError(
        `Voice transcription failed: ${result.error.message}`,
      );
    }

    return {
      ...channelMessage,
      voice: {
        ...voice,
        transcript: result.value,
      },
    };
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

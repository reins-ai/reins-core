import { Buffer } from "node:buffer";
import { ChannelError } from "../errors";
import { createLogger } from "../../logger";
import type { Logger } from "../../logger";
import type {
  Channel,
  ChannelAttachment,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
} from "../types";
import { normalizeTelegramMessage } from "./normalize";
import type { TelegramFile, TelegramMessage, TelegramUpdate } from "./types";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_SEND_RETRIES = 3;
const INITIAL_SEND_RETRY_DELAY_MS = 500;
const RATE_LIMIT_RETRY_DELAY_MS = 2_000;

type PollTimerHandle = ReturnType<typeof setTimeout>;

const log = createLogger("channels:telegram");

const DEFAULT_IMAGE_PROMPT = "What's in this image?";
const DEFAULT_DOCUMENT_PROMPT = "Please analyze this document.";

interface DownloadedTelegramFile {
  data: Uint8Array;
  contentType?: string;
}

export interface TelegramChannelClient {
  getMe(): Promise<unknown>;
  getUpdates(offset?: number): Promise<TelegramUpdate[]>;
  getFile(fileId: string): Promise<TelegramFile>;
  downloadFile(filePath: string): Promise<DownloadedTelegramFile>;
  sendMessage(chatId: string | number, text: string, options?: Record<string, unknown>): Promise<unknown>;
  sendPhoto(chatId: string | number, photo: string, options?: Record<string, unknown>): Promise<unknown>;
  sendDocument(chatId: string | number, document: string, options?: Record<string, unknown>): Promise<unknown>;
  sendVoice(chatId: string | number, voice: string, options?: Record<string, unknown>): Promise<unknown>;
  sendChatAction(chatId: string | number, action: "typing"): Promise<unknown>;
}

export interface TelegramChannelOptions {
  config: ChannelConfig;
  client: TelegramChannelClient;
  normalizeMessageFn?: (update: TelegramUpdate) => ChannelMessage | null;
  schedulePollFn?: (callback: () => void, delayMs: number) => PollTimerHandle;
  clearScheduledPollFn?: (timer: PollTimerHandle) => void;
  retrySendDelayFn?: (delayMs: number) => Promise<void>;
  logger?: Logger;
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
 * Telegram channel implementation using long-polling in the main event loop.
 */
export class TelegramChannel implements Channel {
  public readonly config: ChannelConfig;

  private readonly client: TelegramChannelClient;
  private readonly normalizeMessageFn: (update: TelegramUpdate) => ChannelMessage | null;
  private readonly schedulePollFn: (callback: () => void, delayMs: number) => PollTimerHandle;
  private readonly clearScheduledPollFn: (timer: PollTimerHandle) => void;
  private readonly retrySendDelayFn: (delayMs: number) => Promise<void>;
  private readonly log: Logger;
  private readonly nowFn: () => number;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;

  private readonly handlers = new Set<ChannelMessageHandler>();

  private statusState: ChannelStatus = {
    state: "disconnected",
    uptimeMs: 0,
  };

  private connectedAtMs: number | null = null;
  private shouldPoll = false;
  private pollTimer: PollTimerHandle | null = null;
  private reconnectAttempts = 0;
  private lastUpdateId: number | null = null;

  constructor(options: TelegramChannelOptions) {
    this.config = options.config;
    this.client = options.client;
    this.normalizeMessageFn = options.normalizeMessageFn ?? normalizeTelegramMessage;
    this.schedulePollFn = options.schedulePollFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearScheduledPollFn = options.clearScheduledPollFn ?? ((timer) => {
      clearTimeout(timer);
    });
    this.retrySendDelayFn = options.retrySendDelayFn ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.log = options.logger ?? log;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? INITIAL_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS;
  }

  /**
   * Current channel status with computed uptime while connected.
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
   * Validate Telegram credentials and start the long-polling loop.
   */
  public async connect(): Promise<void> {
    if (this.shouldPoll) {
      return;
    }

    this.shouldPoll = true;
    this.updateStatus("connecting");

    try {
      await this.client.getMe();
    } catch (error) {
      this.shouldPoll = false;
      const connectError = toError(error);
      this.updateStatus("error", connectError.message);
      throw new ChannelError(`Failed to connect Telegram channel ${this.config.id}: ${connectError.message}`);
    }

    this.reconnectAttempts = 0;
    this.connectedAtMs = this.nowFn();
    this.updateStatus("connected");
    this.scheduleNextPoll(0);
  }

  /**
   * Stop polling and reset runtime connection state.
   */
  public async disconnect(): Promise<void> {
    this.shouldPoll = false;

    if (this.pollTimer !== null) {
      this.clearScheduledPollFn(this.pollTimer);
      this.pollTimer = null;
    }

    this.reconnectAttempts = 0;
    this.connectedAtMs = null;
    this.updateStatus("disconnected");
  }

  /**
   * Send an outbound channel message through Telegram Bot API.
   */
  public async send(message: ChannelMessage): Promise<void> {
    if (!this.shouldPoll && this.statusState.state === "disconnected") {
      throw new ChannelError(`Telegram channel ${this.config.id} is not connected`);
    }

    const chatId = message.platformData?.chat_id;
    if (chatId !== undefined && chatId !== null) {
      await this.sendToChat(chatId as number | string, message);
      return;
    }

    const channelIdAsNumber = Number(message.channelId);
    const fallbackChatId = Number.isFinite(channelIdAsNumber) ? channelIdAsNumber : message.channelId;
    await this.sendToChat(fallbackChatId, message);
  }

  /**
   * Register a handler for inbound normalized Telegram messages.
   */
  public onMessage(handler: ChannelMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  public async sendTypingIndicator(destinationChannelId: string): Promise<void> {
    const parsed = Number(destinationChannelId);
    const chatId = Number.isFinite(parsed) ? parsed : destinationChannelId;
    await this.client.sendChatAction(chatId, "typing");
  }

  private async sendToChat(chatId: number | string, message: ChannelMessage): Promise<void> {
    if (message.voice?.platformData?.file_id !== undefined) {
      await this.sendWithRetry(() => this.client.sendVoice(chatId, String(message.voice!.platformData!.file_id)));
      return;
    }

    if (message.attachments !== undefined && message.attachments.length > 0) {
      const attachment = message.attachments[0]!;
      const fileRef =
        typeof attachment.platformData?.file_id === "string"
          ? attachment.platformData.file_id
          : attachment.url;

      if (fileRef === undefined) {
        throw new ChannelError("Cannot send attachment without Telegram file_id or URL");
      }

      if (attachment.type === "image") {
        await this.sendWithRetry(() => this.client.sendPhoto(chatId, fileRef, {
          caption: message.text,
        }));
        return;
      }

      await this.sendWithRetry(() => this.client.sendDocument(chatId, fileRef, {
        caption: message.text,
      }));
      return;
    }

    if (message.text === undefined || message.text.length === 0) {
      throw new ChannelError("Cannot send Telegram message without text, voice, or attachment");
    }

    const parseMode = message.formatting?.mode === "markdown_v2" ? "MarkdownV2" : undefined;
    try {
      await this.sendWithRetry(() => this.client.sendMessage(chatId, message.text!, parseMode !== undefined ? { parseMode } : undefined));
    } catch (sendError) {
      const typedSendError = toError(sendError);
      if (parseMode !== undefined && this.isMarkdownV2ParseError(typedSendError)) {
        this.log.warn("telegram send: MarkdownV2 rejected, retrying as plain text", {
          chatId,
          error: typedSendError.message,
        });
        await this.sendWithRetry(() => this.client.sendMessage(chatId, message.text!));
      } else {
        throw typedSendError;
      }
    }
  }

  private isTransientError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return /429|5\d{2}|etimedout|econnreset|econnrefused|network|timeout/.test(message);
  }

  private isMarkdownV2ParseError(error: Error): boolean {
    return error.message.includes("400");
  }

  private async sendWithRetry(fn: () => Promise<unknown>): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        const sendError = toError(error);
        attempt += 1;
        if (!this.isTransientError(sendError) || attempt >= MAX_SEND_RETRIES) {
          throw sendError;
        }
        const baseDelay = sendError.message.includes("429")
          ? RATE_LIMIT_RETRY_DELAY_MS
          : INITIAL_SEND_RETRY_DELAY_MS;
        const delay = baseDelay * Math.pow(2, attempt - 1);
        await this.retrySendDelayFn(delay);
      }
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.shouldPoll) {
      return;
    }

    this.pollTimer = this.schedulePollFn(() => {
      this.pollTimer = null;
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (!this.shouldPoll) {
      return;
    }

    try {
      const offset = this.lastUpdateId === null ? undefined : this.lastUpdateId + 1;
      const updates = await this.client.getUpdates(offset);

      if (!this.shouldPoll) {
        return;
      }

      if (this.statusState.state === "reconnecting") {
        this.connectedAtMs = this.nowFn();
      }

      this.updateStatus("connected");
      this.reconnectAttempts = 0;

      await this.dispatchUpdates(updates);
      this.scheduleNextPoll(0);
    } catch (error) {
      if (!this.shouldPoll) {
        return;
      }

      const pollError = toError(error);
      this.connectedAtMs = null;
      this.updateStatus("reconnecting", pollError.message);

      const delayMs = this.calculateReconnectDelayMs(this.reconnectAttempts);
      this.reconnectAttempts += 1;
      this.scheduleNextPoll(delayMs);
    }
  }

  private async dispatchUpdates(updates: TelegramUpdate[]): Promise<void> {
    for (const update of updates) {
      this.lastUpdateId = this.lastUpdateId === null
        ? update.update_id
        : Math.max(this.lastUpdateId, update.update_id);

      const normalizedMessage = this.normalizeMessageFn(update);
      if (normalizedMessage === null) {
        continue;
      }

      const enrichedMessage = await this.enrichInboundMedia(update, normalizedMessage);

      const handlers = Array.from(this.handlers);
      for (let handlerIndex = 0; handlerIndex < handlers.length; handlerIndex += 1) {
        const handler = handlers[handlerIndex]!;
        try {
          await handler(enrichedMessage);
        } catch (error) {
          const handlerError = toError(error);
          this.log.warn("message handler failed", {
            updateId: update.update_id,
            handlerIndex,
            error: handlerError.message,
          });
          this.statusState.lastError = `Message handler failed: ${handlerError.message}`;
        }
      }
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

  private async enrichInboundMedia(update: TelegramUpdate, message: ChannelMessage): Promise<ChannelMessage> {
    const sourceMessage = this.extractTelegramMessage(update);
    if (sourceMessage === undefined) {
      return message;
    }

    let attachments = message.attachments;

    if (sourceMessage.photo !== undefined && sourceMessage.photo.length > 0) {
      const largestPhoto = sourceMessage.photo[sourceMessage.photo.length - 1];
      if (largestPhoto !== undefined) {
        this.log.debug("processing inbound photo attachment", {
          channelId: this.config.id,
          fileId: largestPhoto.file_id,
        });
        attachments = await this.withResolvedAttachmentData(
          attachments,
          largestPhoto.file_id,
          "image/jpeg",
          "image",
        );
      }
    }

    if (sourceMessage.document !== undefined) {
      this.log.debug("processing inbound document attachment", {
        channelId: this.config.id,
        fileId: sourceMessage.document.file_id,
        mimeType: sourceMessage.document.mime_type,
      });
      attachments = await this.withResolvedAttachmentData(
        attachments,
        sourceMessage.document.file_id,
        sourceMessage.document.mime_type,
        "file",
      );
    }

    if (message.text !== undefined && message.text.trim().length > 0) {
      return {
        ...message,
        attachments,
      };
    }

    const fallbackText = this.buildFallbackPrompt(sourceMessage, attachments);
    if (fallbackText === undefined) {
      return {
        ...message,
        attachments,
      };
    }

    this.log.info("using fallback prompt for media message without caption", {
      channelId: this.config.id,
      updateId: update.update_id,
      fallbackPrompt: fallbackText,
    });

    return {
      ...message,
      attachments,
      text: fallbackText,
    };
  }

  private async withResolvedAttachmentData(
    attachments: ChannelAttachment[] | undefined,
    fileId: string,
    fallbackMimeType: string | undefined,
    attachmentType: "image" | "file",
  ): Promise<ChannelAttachment[] | undefined> {
    if (attachments === undefined || attachments.length === 0) {
      return attachments;
    }

    const targetIndex = attachments.findIndex(
      (attachment) => attachment.platformData?.file_id === fileId,
    );
    if (targetIndex < 0) {
      return attachments;
    }

    try {
      const resolved = await this.resolveTelegramFileDataUrl(fileId, fallbackMimeType);
      const nextAttachments = [...attachments];
      const existing = nextAttachments[targetIndex]!;
      nextAttachments[targetIndex] = {
        ...existing,
        type: attachmentType,
        url: resolved.dataUrl,
        mimeType: resolved.mimeType,
      };

      return nextAttachments;
    } catch (error) {
      const resolvedError = toError(error);
      this.log.warn("failed to resolve telegram file for inbound media", {
        channelId: this.config.id,
        fileId,
        error: resolvedError.message,
      });
      return attachments;
    }
  }

  private async resolveTelegramFileDataUrl(
    fileId: string,
    fallbackMimeType: string | undefined,
  ): Promise<{ dataUrl: string; mimeType: string }> {
    const fileMeta = await this.client.getFile(fileId);
    if (fileMeta.file_path === undefined || fileMeta.file_path.length === 0) {
      throw new ChannelError(`Telegram file metadata for ${fileId} does not include file_path`);
    }

    const downloaded = await this.client.downloadFile(fileMeta.file_path);
    if (downloaded.data.length === 0) {
      throw new ChannelError(`Telegram file ${fileId} downloaded with empty payload`);
    }

    const mimeType = downloaded.contentType === undefined || downloaded.contentType === "application/octet-stream"
      ? (fallbackMimeType ?? downloaded.contentType ?? "application/octet-stream")
      : downloaded.contentType;
    const base64 = Buffer.from(downloaded.data).toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;

    this.log.debug("resolved telegram file to data url", {
      channelId: this.config.id,
      fileId,
      mimeType,
      sizeBytes: downloaded.data.length,
    });

    return { dataUrl, mimeType };
  }

  private buildFallbackPrompt(
    sourceMessage: TelegramMessage,
    attachments: ChannelAttachment[] | undefined,
  ): string | undefined {
    if (attachments === undefined || attachments.length === 0) {
      return undefined;
    }

    if (sourceMessage.photo !== undefined && sourceMessage.photo.length > 0) {
      return DEFAULT_IMAGE_PROMPT;
    }

    if (sourceMessage.document !== undefined) {
      const mimeType = sourceMessage.document.mime_type ?? "";
      if (mimeType.startsWith("image/")) {
        return DEFAULT_IMAGE_PROMPT;
      }
      return DEFAULT_DOCUMENT_PROMPT;
    }

    return undefined;
  }

  private extractTelegramMessage(update: TelegramUpdate): TelegramMessage | undefined {
    return update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
  }
}

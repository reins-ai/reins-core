import { ChannelError } from "../errors";
import type {
  Channel,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
} from "../types";
import { normalizeTelegramMessage } from "./normalize";
import type { TelegramUpdate } from "./types";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

type PollTimerHandle = ReturnType<typeof setTimeout>;

export interface TelegramChannelClient {
  getMe(): Promise<unknown>;
  getUpdates(offset?: number): Promise<TelegramUpdate[]>;
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
      await this.client.sendVoice(chatId, String(message.voice.platformData.file_id));
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
        await this.client.sendPhoto(chatId, fileRef, {
          caption: message.text,
        });
        return;
      }

      await this.client.sendDocument(chatId, fileRef, {
        caption: message.text,
      });
      return;
    }

    if (message.text === undefined || message.text.length === 0) {
      throw new ChannelError("Cannot send Telegram message without text, voice, or attachment");
    }

    await this.client.sendMessage(chatId, message.text);
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

      for (const handler of this.handlers) {
        try {
          await handler(normalizedMessage);
        } catch (error) {
          const handlerError = toError(error);
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
}

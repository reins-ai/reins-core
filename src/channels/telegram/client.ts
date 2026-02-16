import { ChannelError } from "../errors";
import type {
  TelegramApiError,
  TelegramApiResponse,
  TelegramChatAction,
  TelegramClientOptions,
  TelegramGetUpdatesOptions,
  TelegramMessage,
  TelegramSendMediaOptions,
  TelegramSendMessageOptions,
  TelegramUpdate,
  TelegramUser,
} from "./types";

const DEFAULT_BASE_URL = "https://api.telegram.org";
const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const DEFAULT_MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function toRetryDelayMs(retryAfterSeconds: number | null, attempt: number): number {
  const exponentialDelay = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  if (retryAfterSeconds === null) {
    return exponentialDelay;
  }

  return Math.max(Math.min(retryAfterSeconds * 1_000, MAX_BACKOFF_MS), exponentialDelay);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseRetryAfterFromHeaders(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function parseApiError(value: unknown): TelegramApiError | null {
  const data = asObject(value);
  if (data === null || data.ok !== false) {
    return null;
  }

  const errorCode = data.error_code;
  const description = data.description;
  if (typeof errorCode !== "number" || typeof description !== "string") {
    return null;
  }

  const parameters = asObject(data.parameters);
  const retryAfter = parameters?.retry_after;
  const migrateToChatId = parameters?.migrate_to_chat_id;

  return {
    ok: false,
    error_code: errorCode,
    description,
    parameters:
      parameters === null
        ? undefined
        : {
            retry_after: typeof retryAfter === "number" ? retryAfter : undefined,
            migrate_to_chat_id: typeof migrateToChatId === "number" ? migrateToChatId : undefined,
          },
  };
}

function parseRetryAfterFromApiError(apiError: TelegramApiError | null): number | null {
  const retryAfter = apiError?.parameters?.retry_after;
  if (retryAfter === undefined || !Number.isFinite(retryAfter) || retryAfter <= 0) {
    return null;
  }

  return retryAfter;
}

function isTelegramApiResponse<T>(value: unknown): value is TelegramApiResponse<T> {
  const data = asObject(value);
  return data !== null && typeof data.ok === "boolean";
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function buildErrorMessage(method: string, status: number, apiError: TelegramApiError | null): string {
  if (apiError !== null) {
    return `Telegram API ${method} failed (${apiError.error_code}): ${apiError.description}`;
  }

  return `Telegram API ${method} failed with status ${status}`;
}

/**
 * Lightweight Telegram Bot API client using native fetch.
 */
export class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly pollTimeoutSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (delayMs: number) => Promise<void>;
  private readonly nowFn: () => number;

  private rateLimitUntilMs = 0;

  constructor(options: TelegramClientOptions) {
    const token = options.token.trim();
    if (token.length === 0) {
      throw new ChannelError("Telegram bot token is required");
    }

    this.token = token;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn =
      options.sleepFn ??
      ((delayMs: number) => new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      }));
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  /**
   * Validate bot token and fetch basic bot profile information.
   */
  public async getMe(): Promise<TelegramUser> {
    return this.request<TelegramUser>("getMe", undefined);
  }

  /**
   * Fetch updates using Telegram long-polling.
   */
  public async getUpdates(offset?: number, options: TelegramGetUpdatesOptions = {}): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = {
      timeout: options.timeoutSeconds ?? this.pollTimeoutSeconds,
    };

    if (offset !== undefined) {
      payload.offset = offset;
    }

    if (options.limit !== undefined) {
      payload.limit = options.limit;
    }

    if (options.allowedUpdates !== undefined) {
      payload.allowed_updates = options.allowedUpdates;
    }

    const timeoutSeconds = typeof payload.timeout === "number" ? payload.timeout : this.pollTimeoutSeconds;
    const timeoutMs = Math.max(this.requestTimeoutMs, (timeoutSeconds + 5) * 1_000);

    return this.request<TelegramUpdate[]>("getUpdates", payload, timeoutMs);
  }

  /**
   * Send a text message to a Telegram chat.
   */
  public async sendMessage(
    chatId: string | number,
    text: string,
    options: TelegramSendMessageOptions = {},
  ): Promise<TelegramMessage> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };

    if (options.parseMode !== undefined) {
      payload.parse_mode = options.parseMode;
    }

    if (options.disableWebPagePreview !== undefined) {
      payload.disable_web_page_preview = options.disableWebPagePreview;
    }

    if (options.disableNotification !== undefined) {
      payload.disable_notification = options.disableNotification;
    }

    if (options.replyToMessageId !== undefined) {
      payload.reply_to_message_id = options.replyToMessageId;
    }

    return this.request<TelegramMessage>("sendMessage", payload);
  }

  /**
   * Send a photo by Telegram file ID or URL.
   */
  public async sendPhoto(
    chatId: string | number,
    photo: string,
    options: TelegramSendMediaOptions = {},
  ): Promise<TelegramMessage> {
    return this.sendMedia("sendPhoto", chatId, "photo", photo, options);
  }

  /**
   * Send a document by Telegram file ID or URL.
   */
  public async sendDocument(
    chatId: string | number,
    document: string,
    options: TelegramSendMediaOptions = {},
  ): Promise<TelegramMessage> {
    return this.sendMedia("sendDocument", chatId, "document", document, options);
  }

  /**
   * Send a voice message by Telegram file ID or URL.
   */
  public async sendVoice(
    chatId: string | number,
    voice: string,
    options: TelegramSendMediaOptions = {},
  ): Promise<TelegramMessage> {
    return this.sendMedia("sendVoice", chatId, "voice", voice, options);
  }

  /**
   * Send chat action (for example `typing`) to show user activity while
   * processing a response.
   */
  public async sendChatAction(chatId: string | number, action: TelegramChatAction): Promise<boolean> {
    return this.request<boolean>("sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  private async sendMedia(
    method: "sendPhoto" | "sendDocument" | "sendVoice",
    chatId: string | number,
    field: "photo" | "document" | "voice",
    mediaValue: string,
    options: TelegramSendMediaOptions,
  ): Promise<TelegramMessage> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      [field]: mediaValue,
    };

    if (options.caption !== undefined) {
      payload.caption = options.caption;
    }

    if (options.parseMode !== undefined) {
      payload.parse_mode = options.parseMode;
    }

    if (options.disableNotification !== undefined) {
      payload.disable_notification = options.disableNotification;
    }

    if (options.replyToMessageId !== undefined) {
      payload.reply_to_message_id = options.replyToMessageId;
    }

    return this.request<TelegramMessage>(method, payload);
  }

  private async request<T>(method: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.waitForRateLimit();

      try {
        const response = await this.executeHttpRequest(method, payload, timeoutMs);
        const responseBody = await this.parseResponseBody(response);
        const apiError = parseApiError(responseBody);

        if (!response.ok || apiError !== null) {
          const status = apiError?.error_code ?? response.status;
          const retryAfterSeconds =
            parseRetryAfterFromApiError(apiError) ?? parseRetryAfterFromHeaders(response);

          if (status === 429 && retryAfterSeconds !== null) {
            this.rateLimitUntilMs = Math.max(
              this.rateLimitUntilMs,
              this.nowFn() + retryAfterSeconds * 1_000,
            );
          }

          if (isRetriableStatus(status) && attempt < this.maxRetries) {
            await this.sleepFn(toRetryDelayMs(retryAfterSeconds, attempt));
            continue;
          }

          throw new ChannelError(buildErrorMessage(method, status, apiError));
        }

        if (!isTelegramApiResponse<T>(responseBody)) {
          throw new ChannelError(`Telegram API ${method} returned invalid response payload`);
        }

        if (!responseBody.ok) {
          throw new ChannelError(`Telegram API ${method} returned error response`);
        }

        return responseBody.result;
      } catch (error) {
        if (error instanceof ChannelError) {
          throw error;
        }

        if (attempt >= this.maxRetries) {
          throw new ChannelError(
            `Telegram API ${method} request failed after ${this.maxRetries + 1} attempts`,
            error instanceof Error ? error : undefined,
          );
        }

        await this.sleepFn(toRetryDelayMs(null, attempt));
      }
    }

    throw new ChannelError(`Telegram API ${method} exceeded retry limit`);
  }

  private async waitForRateLimit(): Promise<void> {
    const now = this.nowFn();
    if (now >= this.rateLimitUntilMs) {
      return;
    }

    await this.sleepFn(this.rateLimitUntilMs - now);
  }

  private async executeHttpRequest(
    method: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs ?? this.requestTimeoutMs);

    try {
      const response = await this.fetchFn(this.buildMethodUrl(method), {
        method: payload === undefined ? "GET" : "POST",
        headers: payload === undefined ? undefined : { "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async parseResponseBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type");
    if (contentType !== null && contentType.toLowerCase().includes("application/json")) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }

    try {
      const text = await response.text();
      if (text.length === 0) {
        return null;
      }
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private buildMethodUrl(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }
}

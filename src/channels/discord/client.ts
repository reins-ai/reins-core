import { ChannelError } from "../errors";
import { DiscordGateway } from "./gateway";
import type { DiscordGatewayWebSocket } from "./gateway";
import type {
  DiscordApiError,
  DiscordClientOptions,
  DiscordEmbed,
  DiscordGatewayReadyEvent,
  DiscordMessage,
  DiscordUser,
  DiscordUploadFileInput,
} from "./types";

const DEFAULT_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 4;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

interface DiscordBucketState {
  limit: number | null;
  remaining: number | null;
  resetAtMs: number | null;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function toExponentialBackoffMs(attempt: number): number {
  return Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseDiscordApiError(value: unknown): DiscordApiError | null {
  const payload = asObject(value);
  if (payload === null) {
    return null;
  }

  if (typeof payload.message !== "string" || typeof payload.code !== "number") {
    return null;
  }

  return {
    message: payload.message,
    code: payload.code,
    retry_after: typeof payload.retry_after === "number" ? payload.retry_after : undefined,
    global: payload.global === true,
  };
}

function parsePositiveNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function parseRetryDelayMs(response: Response, body: unknown): number | null {
  const headerRetryAfter = parsePositiveNumber(response.headers.get("retry-after"));
  if (headerRetryAfter !== null) {
    return headerRetryAfter * 1_000;
  }

  const payload = asObject(body);
  const payloadRetryAfter = payload?.retry_after;
  if (typeof payloadRetryAfter === "number" && Number.isFinite(payloadRetryAfter) && payloadRetryAfter >= 0) {
    return payloadRetryAfter * 1_000;
  }

  return null;
}

/**
 * Discord Bot API client for REST messaging endpoints and Gateway events.
 */
export class DiscordClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (delayMs: number) => Promise<void>;
  private readonly nowFn: () => number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;

  private readonly gateway: DiscordGateway;

  private readonly routeToBucket = new Map<string, string>();
  private readonly bucketState = new Map<string, DiscordBucketState>();

  private globalRateLimitUntilMs = 0;

  constructor(options: DiscordClientOptions) {
    const token = options.token.trim();
    if (token.length === 0) {
      throw new ChannelError("Discord bot token is required");
    }

    this.token = token;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? ((delayMs: number) => new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    }));
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    this.gateway = new DiscordGateway({
      token,
      gatewayUrl: options.gatewayUrl,
      intents: options.intents,
      identifyProperties: options.gatewayIdentifyProperties,
      webSocketFactory: options.webSocketFactory as ((url: string) => DiscordGatewayWebSocket) | undefined,
    });
  }

  /**
   * Validates bot token by fetching the current bot user profile.
   */
  public async getCurrentUser(): Promise<DiscordUser> {
    return this.requestJson<DiscordUser>("/users/@me", {
      method: "GET",
    });
  }

  /**
   * Opens the Discord Gateway websocket and begins receiving events.
   */
  public async connectGateway(): Promise<void> {
    await this.gateway.connect();
  }

  /**
   * Closes the Discord Gateway websocket.
   */
  public async disconnectGateway(): Promise<void> {
    await this.gateway.disconnect();
  }

  /**
   * Subscribes to incoming `MESSAGE_CREATE` dispatch events.
   */
  public onMessageCreate(handler: (message: DiscordMessage) => Promise<void> | void): () => void {
    return this.gateway.onMessageCreate(handler);
  }

  /**
   * Subscribes to incoming `READY` dispatch events.
   */
  public onReady(handler: (event: DiscordGatewayReadyEvent) => Promise<void> | void): () => void {
    return this.gateway.onReady(handler);
  }

  /**
   * Sends a plain text message to a Discord channel.
   */
  public async sendMessage(channelId: string, content: string): Promise<DiscordMessage> {
    return this.requestJson<DiscordMessage>(`/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
  }

  /**
   * Sends an embed payload to a Discord channel.
   */
  public async sendEmbed(channelId: string, embed: DiscordEmbed): Promise<DiscordMessage> {
    return this.requestJson<DiscordMessage>(`/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ embeds: [embed] }),
    });
  }

  /**
   * Uploads a file attachment to a Discord channel.
   */
  public async uploadFile(channelId: string, file: DiscordUploadFileInput): Promise<DiscordMessage> {
    const formData = new FormData();
    const blobPart = typeof file.data === "string"
      ? file.data
      : file.data instanceof ArrayBuffer
        ? file.data
        : file.data instanceof Uint8Array
          ? (() => {
              const copy = new Uint8Array(file.data.byteLength);
              copy.set(file.data);
              return copy.buffer;
            })()
          : file.data;

    const blob = file.data instanceof Blob
      ? file.data
      : new Blob([blobPart], file.contentType === undefined ? undefined : { type: file.contentType });

    formData.append("files[0]", blob, file.name);

    if (file.description !== undefined) {
      formData.append("payload_json", JSON.stringify({ attachments: [{ id: 0, description: file.description }] }));
    }

    return this.requestJson<DiscordMessage>(`/channels/${channelId}/messages`, {
      method: "POST",
      body: formData,
    });
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.waitForRateLimit(path);

      let response: Response;
      let body: unknown;
      try {
        response = await this.executeHttpRequest(path, init);
        body = await this.parseResponseBody(response);
      } catch (error) {
        if (attempt >= this.maxRetries) {
          throw new ChannelError(
            `Discord API request to ${path} failed after ${this.maxRetries + 1} attempts`,
            error instanceof Error ? error : undefined,
          );
        }

        await this.sleepFn(toExponentialBackoffMs(attempt));
        continue;
      }

      this.updateRateLimitState(path, response, body);

      if (response.status === 429) {
        const retryDelayMs = parseRetryDelayMs(response, body) ?? toExponentialBackoffMs(attempt);
        if (attempt < this.maxRetries) {
          await this.sleepFn(retryDelayMs);
          continue;
        }
      }

      if (!response.ok) {
        if (isRetriableStatus(response.status) && attempt < this.maxRetries) {
          await this.sleepFn(toExponentialBackoffMs(attempt));
          continue;
        }

        const apiError = parseDiscordApiError(body);
        if (apiError !== null) {
          throw new ChannelError(
            `Discord API request to ${path} failed (${response.status}): ${apiError.message}`,
          );
        }

        throw new ChannelError(`Discord API request to ${path} failed with status ${response.status}`);
      }

      return body as T;
    }

    throw new ChannelError(`Discord API request to ${path} exceeded retry limit`);
  }

  private async waitForRateLimit(route: string): Promise<void> {
    const now = this.nowFn();
    if (now < this.globalRateLimitUntilMs) {
      await this.sleepFn(this.globalRateLimitUntilMs - now);
      return;
    }

    const bucketId = this.routeToBucket.get(route);
    if (bucketId === undefined) {
      return;
    }

    const bucket = this.bucketState.get(bucketId);
    if (bucket === undefined || bucket.remaining === null || bucket.resetAtMs === null) {
      return;
    }

    if (bucket.remaining > 0) {
      return;
    }

    const nowAfterGlobal = this.nowFn();
    if (nowAfterGlobal < bucket.resetAtMs) {
      await this.sleepFn(bucket.resetAtMs - nowAfterGlobal);
    }
  }

  private updateRateLimitState(route: string, response: Response, body: unknown): void {
    const bucketIdFromHeader = response.headers.get("x-ratelimit-bucket");
    const routeBucketId = bucketIdFromHeader ?? this.routeToBucket.get(route);
    if (bucketIdFromHeader !== null) {
      this.routeToBucket.set(route, bucketIdFromHeader);
    }

    if (routeBucketId !== null && routeBucketId !== undefined) {
      const previousState = this.bucketState.get(routeBucketId);
      const limit = parsePositiveNumber(response.headers.get("x-ratelimit-limit"));
      const remaining = parsePositiveNumber(response.headers.get("x-ratelimit-remaining"));
      const resetAfterSeconds = parsePositiveNumber(response.headers.get("x-ratelimit-reset-after"));
      const resetUnixSeconds = parsePositiveNumber(response.headers.get("x-ratelimit-reset"));
      const resetAtMs = resetAfterSeconds !== null
        ? this.nowFn() + resetAfterSeconds * 1_000
        : resetUnixSeconds !== null
          ? resetUnixSeconds * 1_000
          : previousState?.resetAtMs ?? null;

      this.bucketState.set(routeBucketId, {
        limit: limit ?? previousState?.limit ?? null,
        remaining: remaining ?? previousState?.remaining ?? null,
        resetAtMs,
      });
    }

    const isGlobalRateLimit = response.headers.get("x-ratelimit-global") === "true";
    if (isGlobalRateLimit) {
      const retryDelayMs = parseRetryDelayMs(response, body) ?? 1_000;
      this.globalRateLimitUntilMs = Math.max(this.globalRateLimitUntilMs, this.nowFn() + retryDelayMs);
      return;
    }

    if (response.status === 429) {
      const payload = asObject(body);
      const payloadGlobal = payload?.global === true;
      const retryDelayMs = parseRetryDelayMs(response, body);
      if (payloadGlobal && retryDelayMs !== null) {
        this.globalRateLimitUntilMs = Math.max(this.globalRateLimitUntilMs, this.nowFn() + retryDelayMs);
      }
    }
  }

  private async executeHttpRequest(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bot ${this.token}`);

      return await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
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
}

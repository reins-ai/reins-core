import { err, ok, type Result } from "../../result";
import { createStdoutStreamRenderer, type StdoutLike, type StdoutStreamRenderer } from "../stdout-stream";
import { DAEMON_PORT } from "../../config/defaults";

type FetchFn = typeof fetch;

interface WebSocketMessageLike {
  data: string | ArrayBuffer | ArrayBufferView;
}

interface WebSocketCloseLike {
  code: number;
  reason: string;
}

interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: (event: WebSocketCloseLike) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: WebSocketMessageLike) => void): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(type: "close", listener: (event: WebSocketCloseLike) => void): void;
  removeEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: WebSocketMessageLike) => void): void;
}

type WebSocketFactory = (url: string) => WebSocketLike;

type OneshotErrorCode = "DAEMON_UNAVAILABLE" | "STREAM_INTERRUPTED" | "PROVIDER_ERROR" | "TIMEOUT" | "INVALID_RESPONSE";

interface OneshotError {
  code: OneshotErrorCode;
  message: string;
}

interface SendMessageResponse {
  conversationId: string;
  assistantMessageId: string;
}

type StreamEvent =
  | {
      type: "start";
      conversationId: string;
      messageId: string;
      timestamp: string;
    }
  | {
      type: "delta";
      conversationId: string;
      messageId: string;
      delta: string;
      timestamp: string;
    }
  | {
      type: "complete";
      conversationId: string;
      messageId: string;
      content: string;
      timestamp: string;
    }
  | {
      type: "error";
      conversationId: string;
      messageId: string;
      error: {
        message?: string;
      };
      timestamp: string;
    };

interface StreamEnvelope {
  type: "stream-event";
  event: StreamEvent;
}

interface OneshotStreamResult {
  completed: boolean;
  content: string;
}

interface OneshotQueryClient {
  sendMessage(query: string, model: string | undefined): Promise<Result<SendMessageResponse, OneshotError>>;
  streamMessage(conversationId: string, assistantMessageId: string): Promise<Result<OneshotStreamResult, OneshotError>>;
  close(): void;
}

export interface OneshotOptions {
  model?: string;
  stream?: boolean;
  timeoutSeconds?: number;
}

interface OneshotDeps {
  fetchImpl?: FetchFn;
  webSocketFactory?: WebSocketFactory;
  stdout?: StdoutLike;
  stderrWrite?: (text: string) => void;
  rendererFactory?: (stdout: StdoutLike) => StdoutStreamRenderer;
}

interface NormalizedOneshotOptions {
  model?: string;
  stream: boolean;
  timeoutSeconds: number;
}

const DEFAULT_HTTP_BASE_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const DEFAULT_TIMEOUT_SECONDS = 60;

function toWsUrl(httpBaseUrl: string): string {
  if (httpBaseUrl.startsWith("https://")) {
    return `wss://${httpBaseUrl.slice("https://".length)}`;
  }

  if (httpBaseUrl.startsWith("http://")) {
    return `ws://${httpBaseUrl.slice("http://".length)}`;
  }

  return httpBaseUrl;
}

function isSendMessageResponse(value: unknown): value is SendMessageResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Partial<SendMessageResponse>;
  return typeof payload.conversationId === "string" && typeof payload.assistantMessageId === "string";
}

function mapFetchError(error: unknown, timeoutMs: number): OneshotError {
  if (error instanceof Error && error.name === "AbortError") {
    return {
      code: "TIMEOUT",
      message: `Request timed out after ${Math.round(timeoutMs / 1000)}s`,
    };
  }

  return {
    code: "DAEMON_UNAVAILABLE",
    message: `Daemon is not running on localhost:${DAEMON_PORT}`,
  };
}

async function postJson(
  fetchImpl: FetchFn,
  baseUrl: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Result<unknown, OneshotError>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status >= 500) {
        return err({
          code: "DAEMON_UNAVAILABLE",
          message: `Daemon request failed (${response.status})`,
        });
      }

      return err({
        code: "PROVIDER_ERROR",
        message: `Daemon rejected query (${response.status})`,
      });
    }

    try {
      const payload = (await response.json()) as unknown;
      return ok(payload);
    } catch {
      return err({
        code: "INVALID_RESPONSE",
        message: `Daemon returned invalid JSON (${path})`,
      });
    }
  } catch (fetchError) {
    return err(mapFetchError(fetchError, timeoutMs));
  } finally {
    clearTimeout(timeout);
  }
}

function decodeMessageData(data: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof data === "string") {
    return data;
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }

  return new TextDecoder().decode(new Uint8Array(data));
}

function parseStreamEvent(payload: unknown): StreamEvent | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if ((payload as { type?: unknown }).type === "stream-event") {
    const event = (payload as StreamEnvelope).event;
    return event ?? null;
  }

  const event = payload as Partial<StreamEvent>;
  if (
    typeof event.type === "string" &&
    typeof event.conversationId === "string" &&
    typeof event.messageId === "string" &&
    typeof event.timestamp === "string"
  ) {
    return event as StreamEvent;
  }

  return null;
}

function createQueryClient(options: {
  fetchImpl: FetchFn;
  webSocketFactory: WebSocketFactory;
  baseUrl: string;
  timeoutMs: number;
  renderer: StdoutStreamRenderer;
  stream: boolean;
}): OneshotQueryClient {
  let socket: WebSocketLike | null = null;

  return {
    async sendMessage(query: string, model: string | undefined): Promise<Result<SendMessageResponse, OneshotError>> {
      const response = await postJson(options.fetchImpl, options.baseUrl, "/messages", { content: query, model }, options.timeoutMs);
      if (!response.ok) {
        return response;
      }

      if (!isSendMessageResponse(response.value)) {
        return err({
          code: "INVALID_RESPONSE",
          message: "Daemon message response did not include conversation identifiers",
        });
      }

      return ok(response.value);
    },

    async streamMessage(conversationId: string, assistantMessageId: string): Promise<Result<OneshotStreamResult, OneshotError>> {
      const wsUrl = toWsUrl(options.baseUrl);
      const socketResult = await new Promise<Result<WebSocketLike, OneshotError>>((resolve) => {
        const ws = options.webSocketFactory(wsUrl);
        let settled = false;

        const onOpen = (): void => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(connectTimeout);
          ws.removeEventListener("error", onError);
          ws.removeEventListener("close", onClose);
          resolve(ok(ws));
        };

        const onError = (): void => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(connectTimeout);
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("close", onClose);
          resolve(
            err({
              code: "DAEMON_UNAVAILABLE",
              message: "Unable to connect to daemon streaming channel",
            }),
          );
        };

        const onClose = (event: WebSocketCloseLike): void => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(connectTimeout);
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("error", onError);
          resolve(
            err({
              code: "DAEMON_UNAVAILABLE",
              message: `Daemon closed streaming channel (${event.code})`,
            }),
          );
        };

        const connectTimeout = setTimeout(() => {
          if (settled) {
            return;
          }

          settled = true;
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("error", onError);
          ws.removeEventListener("close", onClose);
          ws.close(4000, "oneshot-connect-timeout");
          resolve(
            err({
              code: "TIMEOUT",
              message: `Timed out waiting for daemon stream (${Math.round(options.timeoutMs / 1000)}s)`,
            }),
          );
        }, options.timeoutMs);

        ws.addEventListener("open", onOpen);
        ws.addEventListener("error", onError);
        ws.addEventListener("close", onClose);
      });

      if (!socketResult.ok) {
        return socketResult;
      }

      socket = socketResult.value;

      return new Promise<Result<OneshotStreamResult, OneshotError>>((resolve) => {
        let settled = false;
        let sawComplete = false;
        let aggregated = "";
        let writeQueue = Promise.resolve();

        const finish = (result: Result<OneshotStreamResult, OneshotError>): void => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(streamTimeout);
          socket?.removeEventListener("message", onMessage);
          socket?.removeEventListener("close", onClose);
          socket?.removeEventListener("error", onError);
          resolve(result);
        };

        const onMessage = (event: WebSocketMessageLike): void => {
          const text = decodeMessageData(event.data);

          let payload: unknown;
          try {
            payload = JSON.parse(text);
          } catch {
            return;
          }

          const streamEvent = parseStreamEvent(payload);
          if (!streamEvent) {
            return;
          }

          if (streamEvent.conversationId !== conversationId || streamEvent.messageId !== assistantMessageId) {
            return;
          }

          if (streamEvent.type === "delta") {
            aggregated += streamEvent.delta;
            if (options.stream) {
              writeQueue = writeQueue.then(async () => {
                await options.renderer.writeChunk(streamEvent.delta);
              });
              writeQueue = writeQueue.catch(() => {
                finish(
                  err({
                    code: "STREAM_INTERRUPTED",
                    message: "Failed writing stream output to stdout",
                  }),
                );
              });
            }
            return;
          }

          if (streamEvent.type === "complete") {
            sawComplete = true;
            if (!options.stream) {
              aggregated = streamEvent.content;
            }

            void writeQueue.then(() => {
              finish(
                ok({
                  completed: true,
                  content: aggregated,
                }),
              );
            });
            return;
          }

          if (streamEvent.type === "error") {
            finish(
              err({
                code: "PROVIDER_ERROR",
                message: streamEvent.error.message ?? "Provider failed while generating response",
              }),
            );
          }
        };

        const onClose = (): void => {
          if (sawComplete) {
            finish(
              ok({
                completed: true,
                content: aggregated,
              }),
            );
            return;
          }

          finish(
            err({
              code: "STREAM_INTERRUPTED",
              message: "Daemon stream interrupted before completion",
            }),
          );
        };

        const onError = (): void => {
          finish(
            err({
              code: "STREAM_INTERRUPTED",
              message: "Daemon stream connection errored",
            }),
          );
        };

        const streamTimeout = setTimeout(() => {
          finish(
            err({
              code: "TIMEOUT",
              message: `Timed out waiting for response stream (${Math.round(options.timeoutMs / 1000)}s)`,
            }),
          );
          socket?.close(4001, "oneshot-stream-timeout");
        }, options.timeoutMs);

        socket?.addEventListener("message", onMessage);
        socket?.addEventListener("close", onClose);
        socket?.addEventListener("error", onError);

        socket?.send(
          JSON.stringify({
            type: "stream.subscribe",
            conversationId,
            assistantMessageId,
          }),
        );
      });
    },

    close(): void {
      socket?.close(1000, "oneshot-complete");
      socket = null;
    },
  };
}

function normalizeOptions(options: OneshotOptions | undefined): NormalizedOneshotOptions {
  return {
    model: options?.model,
    stream: options?.stream ?? true,
    timeoutSeconds: options?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
  };
}

export async function runOneshot(query: string, options: OneshotOptions = {}, deps: OneshotDeps = {}): Promise<number> {
  const normalized = normalizeOptions(options);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const webSocketFactory = deps.webSocketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const stdout = deps.stdout ?? process.stdout;
  const stderrWrite = deps.stderrWrite ?? process.stderr.write.bind(process.stderr);
  const rendererFactory = deps.rendererFactory ?? createStdoutStreamRenderer;
  const renderer = rendererFactory(stdout);
  const timeoutMs = Math.max(1, Math.round(normalized.timeoutSeconds * 1000));

  const client = createQueryClient({
    fetchImpl,
    webSocketFactory,
    baseUrl: DEFAULT_HTTP_BASE_URL,
    timeoutMs,
    renderer,
    stream: normalized.stream,
  });

  try {
    const sendResult = await client.sendMessage(query, normalized.model);
    if (!sendResult.ok) {
      stderrWrite(`[reins] ${sendResult.error.message}\n`);
      return 1;
    }

    const streamResult = await client.streamMessage(sendResult.value.conversationId, sendResult.value.assistantMessageId);
    if (!streamResult.ok) {
      stderrWrite(`[reins] ${streamResult.error.message}\n`);
      return 1;
    }

    if (!normalized.stream) {
      await renderer.writeChunk(streamResult.value.content);
    }

    await renderer.writeChunk("\n");
    await renderer.complete();
    return 0;
  } finally {
    client.close();
  }
}

import { CdpError } from "./errors";
import type { CdpCommand, CdpEvent, CdpMethod, CdpResponse } from "./types";

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface CdpMessageEventLike {
  data: unknown;
}

interface CdpCloseEventLike {
  code: number;
  reason: string;
}

interface CdpErrorEventLike {
  error?: unknown;
}

type OpenListener = () => void;
type MessageListener = (event: CdpMessageEventLike) => void;
type CloseListener = (event: CdpCloseEventLike) => void;
type ErrorListener = (event: CdpErrorEventLike) => void;

interface CdpWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: OpenListener): void;
  addEventListener(type: "message", listener: MessageListener): void;
  addEventListener(type: "close", listener: CloseListener): void;
  addEventListener(type: "error", listener: ErrorListener): void;
  removeEventListener(type: "open", listener: OpenListener): void;
  removeEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "close", listener: CloseListener): void;
  removeEventListener(type: "error", listener: ErrorListener): void;
}

interface PendingCommand {
  method: CdpMethod;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: TimeoutHandle;
}

interface VersionResponse {
  webSocketDebuggerUrl: string;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

interface CdpClientDependencies {
  fetchFn?: (input: string) => Promise<FetchResponseLike>;
  webSocketFactory?: (url: string) => CdpWebSocket;
  setTimeoutFn?: (handler: () => void, timeoutMs: number) => TimeoutHandle;
  clearTimeoutFn?: (timer: TimeoutHandle) => void;
}

export interface CdpClientOptions extends CdpClientDependencies {
  port: number;
  timeout?: number;
  commandTimeout?: number;
}

type CdpListener = (params: Record<string, unknown>) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function decodeMessageData(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }

  return null;
}

export class CdpClient {
  private readonly port: number;
  private readonly timeout: number;
  private readonly commandTimeout: number;
  private readonly fetchFn: (input: string) => Promise<FetchResponseLike>;
  private readonly webSocketFactory: (url: string) => CdpWebSocket;
  private readonly setTimeoutFn: (handler: () => void, timeoutMs: number) => TimeoutHandle;
  private readonly clearTimeoutFn: (timer: TimeoutHandle) => void;

  private socket: CdpWebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private isDisconnectRequested = false;
  private permanentlyDisconnected = false;
  private nextId = 1;
  private currentSessionId: string | undefined;

  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Map<string, Set<CdpListener>>();
  private readonly enabledDomains = new Map<CdpMethod, Record<string, unknown> | undefined>();

  constructor(options: CdpClientOptions) {
    this.port = options.port;
    this.timeout = options.timeout ?? 5_000;
    this.commandTimeout = options.commandTimeout ?? 30_000;
    this.fetchFn = options.fetchFn ?? (fetch as unknown as (input: string) => Promise<FetchResponseLike>);
    this.webSocketFactory = options.webSocketFactory ?? ((url: string) => new WebSocket(url) as unknown as CdpWebSocket);
    this.setTimeoutFn = options.setTimeoutFn ?? ((handler: () => void, timeoutMs: number) => setTimeout(handler, timeoutMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timer: TimeoutHandle) => {
      clearTimeout(timer);
    });
  }

  public get isConnected(): boolean {
    return this.socket !== null;
  }

  public get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  public async connect(): Promise<void> {
    if (this.socket !== null) {
      return;
    }

    if (this.connectPromise !== null) {
      return this.connectPromise;
    }

    this.isDisconnectRequested = false;
    this.permanentlyDisconnected = false;

    this.connectPromise = this.connectInternal();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  public async disconnect(): Promise<void> {
    this.isDisconnectRequested = true;
    this.permanentlyDisconnected = true;
    this.currentSessionId = undefined;

    this.rejectAllPending("CDP WebSocket closed unexpectedly");

    if (this.socket !== null) {
      this.unbindSocket(this.socket);
      this.socket.close(1000, "Client disconnect");
      this.socket = null;
    }
  }

  public async send<T = unknown>(
    method: CdpMethod,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    if (method.endsWith(".enable")) {
      this.enabledDomains.set(method, params);
    }

    if (this.socket === null) {
      if (this.permanentlyDisconnected) {
        throw new CdpError("CDP client is disconnected and reconnect attempts were exhausted");
      }
      throw new CdpError("CDP client is not connected");
    }

    const id = this.nextId;
    this.nextId += 1;

    const command: CdpCommand = {
      id,
      method,
      params,
      sessionId,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = this.setTimeoutFn(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP command timed out: ${method}`, { cdpCode: -32603 }));
      }, this.commandTimeout);

      const pendingCommand: PendingCommand = {
        method,
        resolve: (result) => {
          if (method === "Target.attachToTarget") {
            const maybeResult = result as { sessionId?: unknown };
            if (typeof maybeResult.sessionId === "string") {
              this.currentSessionId = maybeResult.sessionId;
            }
          }
          resolve(result as T);
        },
        reject,
        timer,
      };

      this.pending.set(id, pendingCommand);

      try {
        this.socket?.send(JSON.stringify(command));
      } catch (error) {
        this.clearTimeoutFn(timer);
        this.pending.delete(id);
        reject(
          new CdpError(`Failed to send CDP command: ${method}`, {
            cause: error instanceof Error ? error : undefined,
          }),
        );
      }
    });
  }

  public on(event: string, listener: CdpListener): () => void {
    let eventListeners = this.listeners.get(event);
    if (eventListeners === undefined) {
      eventListeners = new Set<CdpListener>();
      this.listeners.set(event, eventListeners);
    }

    eventListeners.add(listener);

    return () => {
      const existing = this.listeners.get(event);
      if (existing === undefined) {
        return;
      }

      existing.delete(listener);
      if (existing.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  private async connectInternal(): Promise<void> {
    const wsUrl = await this.discoverBrowserWebSocketUrl();
    await this.openSocket(wsUrl);
    this.emit("connected", {});
  }

  private async discoverBrowserWebSocketUrl(): Promise<string> {
    const endpoint = `http://127.0.0.1:${this.port}/json/version`;
    const response = await this.fetchFn(endpoint);
    if (!response.ok) {
      throw new CdpError(
        `Failed to discover CDP WebSocket URL (${response.status} ${response.statusText})`,
      );
    }

    const payload = (await response.json()) as VersionResponse;
    if (typeof payload.webSocketDebuggerUrl !== "string" || payload.webSocketDebuggerUrl.length === 0) {
      throw new CdpError("Invalid CDP discovery response: missing webSocketDebuggerUrl");
    }

    return payload.webSocketDebuggerUrl;
  }

  private async openSocket(url: string): Promise<void> {
    const socket = this.webSocketFactory(url);

    await this.waitForOpen(socket);

    this.socket = socket;
    this.bindSocket(socket);
  }

  private async waitForOpen(socket: CdpWebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = this.setTimeoutFn(() => {
        cleanup();
        reject(new CdpError(`CDP WebSocket connection timed out after ${this.timeout}ms`));
      }, this.timeout);

      const onOpen: OpenListener = () => {
        cleanup();
        resolve();
      };

      const onError: ErrorListener = (event) => {
        cleanup();
        reject(new CdpError(`CDP WebSocket connection failed: ${toErrorMessage(event.error)}`));
      };

      const onClose: CloseListener = (event) => {
        cleanup();
        reject(new CdpError(`CDP WebSocket closed before open (${event.code} ${event.reason})`));
      };

      const cleanup = (): void => {
        this.clearTimeoutFn(timeout);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
  }

  private bindSocket(socket: CdpWebSocket): void {
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleError);
  }

  private unbindSocket(socket: CdpWebSocket): void {
    socket.removeEventListener("message", this.handleMessage);
    socket.removeEventListener("close", this.handleClose);
    socket.removeEventListener("error", this.handleError);
  }

  private readonly handleMessage: MessageListener = (event) => {
    const rawData = decodeMessageData(event.data);
    if (rawData === null) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return;
    }

    if (!isRecord(parsed)) {
      return;
    }

    const idValue = parsed.id;
    if (typeof idValue === "number") {
      this.handleResponse({
        id: idValue,
        result: parsed.result,
        error: isRecord(parsed.error) && typeof parsed.error.code === "number" && typeof parsed.error.message === "string"
          ? {
              code: parsed.error.code,
              message: parsed.error.message,
            }
          : undefined,
      });
      return;
    }

    if (typeof parsed.method === "string") {
      const cdpEvent: CdpEvent = {
        method: parsed.method,
        params: isRecord(parsed.params) ? parsed.params : {},
      };

      this.emit(cdpEvent.method, cdpEvent.params);
    }
  };

  private handleResponse(response: CdpResponse): void {
    const pending = this.pending.get(response.id);
    if (pending === undefined) {
      return;
    }

    this.clearTimeoutFn(pending.timer);
    this.pending.delete(response.id);

    if (response.error !== undefined) {
      pending.reject(new CdpError(response.error.message, { cdpCode: response.error.code }));
      return;
    }

    pending.resolve(response.result);
  }

  private readonly handleClose: CloseListener = () => {
    if (this.socket !== null) {
      this.unbindSocket(this.socket);
      this.socket = null;
    }

    this.currentSessionId = undefined;
    this.rejectAllPending("CDP WebSocket closed unexpectedly");

    if (this.isDisconnectRequested) {
      return;
    }

    if (this.reconnectPromise === null) {
      this.reconnectPromise = this.reconnect();
      void this.reconnectPromise.finally(() => {
        this.reconnectPromise = null;
      });
    }
  };

  private readonly handleError: ErrorListener = () => {
    this.emit("socket_error", {});
  };

  private async reconnect(): Promise<void> {
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const attemptNumber = attempt + 1;
      const delayMs = 250 + attempt * 250;
      this.emit("reconnecting", {
        attempt: attemptNumber,
        maxAttempts,
        delayMs,
      });

      await this.sleep(delayMs);

      try {
        const wsUrl = await this.discoverBrowserWebSocketUrl();
        await this.openSocket(wsUrl);
        await this.reEnableDomains();
        this.permanentlyDisconnected = false;
        this.emit("reconnected", {
          attempt: attemptNumber,
        });
        return;
      } catch {
        continue;
      }
    }

    this.permanentlyDisconnected = true;
    this.emit("disconnected", {});
  }

  private async reEnableDomains(): Promise<void> {
    const domains = Array.from(this.enabledDomains.entries());
    for (const [method, params] of domains) {
      await this.send(method, params);
    }
  }

  private sleep(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.setTimeoutFn(() => {
        this.clearTimeoutFn(timer);
        resolve();
      }, timeoutMs);
    });
  }

  private rejectAllPending(message: string): void {
    for (const [id, pending] of this.pending) {
      this.clearTimeoutFn(pending.timer);
      pending.reject(new CdpError(message));
      this.pending.delete(id);
    }
  }

  private emit(event: string, params: Record<string, unknown>): void {
    const listeners = this.listeners.get(event);
    if (listeners === undefined) {
      return;
    }

    for (const listener of listeners) {
      listener(params);
    }
  }
}

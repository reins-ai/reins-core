import { ChannelError } from "../errors";
import {
  DEFAULT_DISCORD_GATEWAY_INTENTS,
  DISCORD_GATEWAY_OPCODES,
  type DiscordGatewayHelloData,
  type DiscordGatewayIdentifyProperties,
  type DiscordGatewayPayload,
  type DiscordGatewayReadyEvent,
  type DiscordMessage,
} from "./types";

const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

type IntervalHandle = ReturnType<typeof setInterval>;

interface GatewayMessageEventLike {
  data: unknown;
}

interface GatewayCloseEventLike {
  code: number;
  reason: string;
}

interface GatewayErrorEventLike {
  error?: unknown;
}

type OpenListener = () => void;
type MessageListener = (event: GatewayMessageEventLike) => void;
type CloseListener = (event: GatewayCloseEventLike) => void;
type ErrorListener = (event: GatewayErrorEventLike) => void;

export interface DiscordGatewayWebSocket {
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

export interface DiscordGatewayOptions {
  token: string;
  gatewayUrl?: string;
  intents?: number;
  identifyProperties?: DiscordGatewayIdentifyProperties;
  webSocketFactory?: (url: string) => DiscordGatewayWebSocket;
  scheduleHeartbeatFn?: (callback: () => void, intervalMs: number) => IntervalHandle;
  clearHeartbeatFn?: (timer: IntervalHandle) => void;
}

export type DiscordGatewayMessageHandler = (message: DiscordMessage) => Promise<void> | void;
export type DiscordGatewayReadyHandler = (event: DiscordGatewayReadyEvent) => Promise<void> | void;
export type DiscordGatewayDisconnectHandler = (details: { code?: number; reason?: string; error?: string }) =>
  Promise<void> | void;

function toDefaultIdentifyProperties(): DiscordGatewayIdentifyProperties {
  return {
    os: "linux",
    browser: "reins",
    device: "reins",
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function decodeGatewayMessageData(data: unknown): string | null {
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

/**
 * Handles Discord Gateway WebSocket lifecycle and protocol events.
 */
export class DiscordGateway {
  private readonly token: string;
  private readonly gatewayUrl: string;
  private readonly intents: number;
  private readonly identifyProperties: DiscordGatewayIdentifyProperties;
  private readonly webSocketFactory: (url: string) => DiscordGatewayWebSocket;
  private readonly scheduleHeartbeatFn: (callback: () => void, intervalMs: number) => IntervalHandle;
  private readonly clearHeartbeatFn: (timer: IntervalHandle) => void;

  private readonly messageHandlers = new Set<DiscordGatewayMessageHandler>();
  private readonly readyHandlers = new Set<DiscordGatewayReadyHandler>();
  private readonly disconnectHandlers = new Set<DiscordGatewayDisconnectHandler>();

  private socket: DiscordGatewayWebSocket | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private heartbeatTimer: IntervalHandle | null = null;
  private resumeSession: { sessionId: string; sequence: number } | null = null;
  private isDisconnecting = false;

  constructor(options: DiscordGatewayOptions) {
    const token = options.token.trim();
    if (token.length === 0) {
      throw new ChannelError("Discord bot token is required");
    }

    this.token = token;
    this.gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
    this.intents = options.intents ?? DEFAULT_DISCORD_GATEWAY_INTENTS;
    this.identifyProperties = options.identifyProperties ?? toDefaultIdentifyProperties();
    this.webSocketFactory = options.webSocketFactory ?? ((url: string) => new WebSocket(url) as unknown as DiscordGatewayWebSocket);
    this.scheduleHeartbeatFn = options.scheduleHeartbeatFn ?? ((callback: () => void, intervalMs: number) => setInterval(callback, intervalMs));
    this.clearHeartbeatFn = options.clearHeartbeatFn ?? ((timer: IntervalHandle) => {
      clearInterval(timer);
    });
  }

  /**
   * Indicates whether the gateway socket is currently open.
   */
  public get connected(): boolean {
    return this.socket !== null;
  }

  /**
   * Returns the active Discord Gateway session id when available.
   */
  public get currentSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Returns the latest gateway sequence number for session resume.
   */
  public get currentSequence(): number | null {
    return this.sequence;
  }

  /**
   * Opens a Discord Gateway connection and registers event listeners.
   */
  public async connect(): Promise<void> {
    if (this.socket !== null) {
      return;
    }

    const socket = this.webSocketFactory(this.gatewayUrl);

    await new Promise<void>((resolve, reject) => {
      const onOpen: OpenListener = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        resolve();
      };

      const onError: ErrorListener = (event) => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        reject(new ChannelError(`Discord Gateway connection failed: ${toErrorMessage(event.error)}`));
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });

    this.socket = socket;
    socket.addEventListener("message", this.handleSocketMessage);
    socket.addEventListener("close", this.handleSocketClose);
    socket.addEventListener("error", this.handleSocketError);
  }

  /**
   * Closes the active Discord Gateway socket and clears heartbeat timers.
   */
  public async disconnect(): Promise<void> {
    if (this.socket === null) {
      return;
    }

    this.isDisconnecting = true;
    this.stopHeartbeat();

    this.socket.removeEventListener("message", this.handleSocketMessage);
    this.socket.removeEventListener("close", this.handleSocketClose);
    this.socket.removeEventListener("error", this.handleSocketError);
    this.socket.close(1000, "Client disconnect");
    this.socket = null;
    this.sequence = null;
    this.sessionId = null;
    this.resumeSession = null;
    this.isDisconnecting = false;
  }

  /**
   * Registers an inbound handler for `MESSAGE_CREATE` dispatch events.
   */
  public onMessageCreate(handler: DiscordGatewayMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * Registers an inbound handler for the `READY` dispatch event.
   */
  public onReady(handler: DiscordGatewayReadyHandler): () => void {
    this.readyHandlers.add(handler);
    return () => {
      this.readyHandlers.delete(handler);
    };
  }

  /**
   * Registers a handler for socket close or error events.
   */
  public onDisconnect(handler: DiscordGatewayDisconnectHandler): () => void {
    this.disconnectHandlers.add(handler);
    return () => {
      this.disconnectHandlers.delete(handler);
    };
  }

  /**
   * Instructs the next HELLO handshake to resume an existing session.
   */
  public prepareResume(sessionId: string, sequence: number): void {
    this.resumeSession = {
      sessionId,
      sequence,
    };
  }

  private readonly handleSocketMessage: MessageListener = (event) => {
    const jsonString = decodeGatewayMessageData(event.data);
    if (jsonString === null) {
      return;
    }

    let payload: DiscordGatewayPayload<unknown>;
    try {
      payload = JSON.parse(jsonString) as DiscordGatewayPayload<unknown>;
    } catch {
      return;
    }

    if (payload.s !== null) {
      this.sequence = payload.s;
    }

    if (payload.op === DISCORD_GATEWAY_OPCODES.HELLO) {
      this.handleHello(payload.d as DiscordGatewayHelloData);
      return;
    }

    if (payload.op === DISCORD_GATEWAY_OPCODES.RECONNECT) {
      this.socket?.close(4000, "Discord requested reconnect");
      return;
    }

    if (payload.op === DISCORD_GATEWAY_OPCODES.INVALID_SESSION) {
      this.resumeSession = null;
      this.sequence = null;
      this.sessionId = null;
      this.sendIdentify();
      return;
    }

    if (payload.op === DISCORD_GATEWAY_OPCODES.HEARTBEAT) {
      this.sendHeartbeat();
      return;
    }

    if (payload.op !== DISCORD_GATEWAY_OPCODES.DISPATCH) {
      return;
    }

    if (payload.t === "READY") {
      const ready = payload.d as DiscordGatewayReadyEvent;
      this.sessionId = ready.session_id;
      void this.emitReady(ready);
      return;
    }

    if (payload.t === "MESSAGE_CREATE") {
      void this.emitMessage(payload.d as DiscordMessage);
    }
  };

  private readonly handleSocketClose: CloseListener = () => {
    this.stopHeartbeat();
    this.socket = null;

    if (!this.isDisconnecting) {
      void this.emitDisconnect({
        code: 1006,
        reason: "Socket closed",
      });
    }
  };

  private readonly handleSocketError: ErrorListener = () => {
    this.stopHeartbeat();
    void this.emitDisconnect({
      error: "Discord Gateway socket error",
    });
  };

  private handleHello(hello: DiscordGatewayHelloData): void {
    if (!Number.isFinite(hello.heartbeat_interval) || hello.heartbeat_interval <= 0) {
      throw new ChannelError("Discord Gateway HELLO payload is missing heartbeat interval");
    }

    this.startHeartbeat(hello.heartbeat_interval);

    if (this.resumeSession !== null) {
      this.sendResume(this.resumeSession.sessionId, this.resumeSession.sequence);
      this.resumeSession = null;
      return;
    }

    this.sendIdentify();
  }

  private sendResume(sessionId: string, sequence: number): void {
    this.sendPayload({
      op: DISCORD_GATEWAY_OPCODES.RESUME,
      d: {
        token: this.token,
        session_id: sessionId,
        seq: sequence,
      },
    });
  }

  private sendIdentify(): void {
    this.sendPayload({
      op: DISCORD_GATEWAY_OPCODES.IDENTIFY,
      d: {
        token: this.token,
        intents: this.intents,
        properties: this.identifyProperties,
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.sendHeartbeat();
    this.heartbeatTimer = this.scheduleHeartbeatFn(() => {
      this.sendHeartbeat();
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.clearHeartbeatFn(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    this.sendPayload({
      op: DISCORD_GATEWAY_OPCODES.HEARTBEAT,
      d: this.sequence,
    });
  }

  private sendPayload(payload: { op: number; d: unknown }): void {
    if (this.socket === null) {
      throw new ChannelError("Discord Gateway is not connected");
    }

    this.socket.send(JSON.stringify(payload));
  }

  private async emitMessage(message: DiscordMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      await handler(message);
    }
  }

  private async emitReady(event: DiscordGatewayReadyEvent): Promise<void> {
    for (const handler of this.readyHandlers) {
      await handler(event);
    }
  }

  private async emitDisconnect(details: { code?: number; reason?: string; error?: string }): Promise<void> {
    for (const handler of this.disconnectHandlers) {
      await handler(details);
    }
  }
}

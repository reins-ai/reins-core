import { createLogger } from "../logger";
import type { TypedEventBus } from "./event-bus";
import { harnessEventTypes, type EventEnvelope, type HarnessEventMap, type HarnessEventType } from "./events";

const log = createLogger("harness:event-transport");

const DEFAULT_REPLAY_LIMIT = 256;

export interface TransportFrame {
  id: number;
  event: string;
  data: string;
  timestamp: number;
}

export interface EventTransportAdapterOptions {
  eventBus: TypedEventBus<HarnessEventMap>;
  replayLimit?: number;
  now?: () => number;
}

type FrameHandler = (frame: TransportFrame) => void;

export class EventTransportAdapter {
  private readonly eventBus: TypedEventBus<HarnessEventMap>;
  private readonly replayLimit: number;
  private readonly now: () => number;
  private readonly frameHandlers = new Set<FrameHandler>();
  private readonly replayBuffer: TransportFrame[] = [];
  private readonly subscriptions: Array<() => void> = [];
  private sequenceId = 0;
  private started = false;

  public constructor(options: EventTransportAdapterOptions) {
    this.eventBus = options.eventBus;
    this.replayLimit = this.normalizeReplayLimit(options.replayLimit);
    this.now = options.now ?? Date.now;
  }

  public start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    for (const eventType of harnessEventTypes) {
      const unsubscribe = this.eventBus.on(eventType, (event) => {
        this.handleHarnessEvent(eventType, event as EventEnvelope<typeof eventType, HarnessEventMap[typeof eventType]>);
      });
      this.subscriptions.push(unsubscribe);
    }
  }

  public stop(): void {
    if (!this.started) {
      return;
    }

    while (this.subscriptions.length > 0) {
      const unsubscribe = this.subscriptions.pop();
      unsubscribe?.();
    }

    this.started = false;
  }

  public getReplayBuffer(sinceSequenceId?: number): TransportFrame[] {
    if (typeof sinceSequenceId !== "number") {
      return [...this.replayBuffer];
    }

    return this.replayBuffer.filter((frame) => frame.id > sinceSequenceId);
  }

  public onFrame(handler: FrameHandler): () => void {
    this.frameHandlers.add(handler);
    return () => {
      this.frameHandlers.delete(handler);
    };
  }

  public static toSSE(frame: TransportFrame): string {
    const dataLines = frame.data.split(/\r?\n/);
    const lines = [`id: ${frame.id}`, `event: ${frame.event}`, ...dataLines.map((line) => `data: ${line}`)];
    return `${lines.join("\n")}\n\n`;
  }

  public static fromSSE(sse: string): TransportFrame | null {
    const firstBlock = sse
      .split(/\r?\n\r?\n/)
      .map((block) => block.trim())
      .find((block) => block.length > 0);

    if (!firstBlock) {
      return null;
    }

    const dataLines: string[] = [];
    let id: number | null = null;
    let event: string | null = null;

    for (const line of firstBlock.split(/\r?\n/)) {
      if (line.startsWith("id:")) {
        const parsedId = Number.parseInt(line.slice(3).trim(), 10);
        if (!Number.isFinite(parsedId)) {
          return null;
        }
        id = parsedId;
        continue;
      }

      if (line.startsWith("event:")) {
        const eventName = line.slice(6).trim();
        if (eventName.length === 0) {
          return null;
        }
        event = eventName;
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (id === null || event === null || dataLines.length === 0) {
      return null;
    }

    const data = dataLines.join("\n");
    return {
      id,
      event,
      data,
      timestamp: EventTransportAdapter.extractTimestamp(data) ?? Date.now(),
    };
  }

  private static extractTimestamp(data: string): number | null {
    try {
      const parsed = JSON.parse(data) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "timestamp" in parsed &&
        typeof (parsed as { timestamp: unknown }).timestamp === "number"
      ) {
        return (parsed as { timestamp: number }).timestamp;
      }
    } catch {
      return null;
    }

    return null;
  }

  private handleHarnessEvent<TEventType extends HarnessEventType>(
    eventType: TEventType,
    event: EventEnvelope<TEventType, HarnessEventMap[TEventType]>,
  ): void {
    const frame: TransportFrame = {
      id: this.nextSequenceId(),
      event: eventType,
      data: this.serializePayload(event.payload),
      timestamp: typeof event.timestamp === "number" ? event.timestamp : this.now(),
    };

    this.replayBuffer.push(frame);
    if (this.replayBuffer.length > this.replayLimit) {
      this.replayBuffer.splice(0, this.replayBuffer.length - this.replayLimit);
    }

    for (const handler of this.frameHandlers) {
      try {
        handler(frame);
      } catch (e) {
        // Expected: frame handler failures must not stop transport fan-out
        log.debug("frame handler error", { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private nextSequenceId(): number {
    this.sequenceId += 1;
    return this.sequenceId;
  }

  private serializePayload(payload: HarnessEventMap[HarnessEventType]): string {
    return JSON.stringify(payload, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }

      if (typeof value === "bigint") {
        return value.toString();
      }

      return value;
    });
  }

  private normalizeReplayLimit(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return DEFAULT_REPLAY_LIMIT;
    }

    return Math.max(1, Math.floor(value));
  }
}

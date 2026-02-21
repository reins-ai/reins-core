import { createLogger } from "../logger";
import {
  createEventId,
  HARNESS_EVENT_VERSION,
  type EventEnvelope,
  type HarnessEventMap,
} from "./events";

const log = createLogger("harness:event-bus");

type EventMap = object;
type EventKey<TEventMap extends EventMap> = Extract<keyof TEventMap, string>;

export type EventHandler<TEventMap extends EventMap, TKey extends EventKey<TEventMap>> = (
  event: EventEnvelope<TKey, TEventMap[TKey]>,
) => void | Promise<void>;

type GenericHandler = (event: EventEnvelope<string, unknown>) => void | Promise<void>;

export interface TypedEventBusOptions {
  version?: number;
  now?: () => number;
  createEventId?: () => string;
}

export class TypedEventBus<TEventMap extends EventMap> {
  private readonly handlers = new Map<EventKey<TEventMap>, Set<GenericHandler>>();
  private readonly version: number;
  private readonly now: () => number;
  private readonly createEventId: () => string;

  constructor(options: TypedEventBusOptions = {}) {
    this.version = options.version ?? HARNESS_EVENT_VERSION;
    this.now = options.now ?? Date.now;
    this.createEventId = options.createEventId ?? createEventId;
  }

  public on<TKey extends EventKey<TEventMap>>(
    type: TKey,
    handler: EventHandler<TEventMap, TKey>,
  ): () => void {
    const registeredHandlers = this.handlers.get(type) ?? new Set<GenericHandler>();
    registeredHandlers.add(handler as GenericHandler);
    this.handlers.set(type, registeredHandlers);

    return () => {
      this.off(type, handler);
    };
  }

  public off<TKey extends EventKey<TEventMap>>(type: TKey, handler: EventHandler<TEventMap, TKey>): void {
    const registeredHandlers = this.handlers.get(type);
    if (!registeredHandlers) {
      return;
    }

    registeredHandlers.delete(handler as GenericHandler);
    if (registeredHandlers.size === 0) {
      this.handlers.delete(type);
    }
  }

  public async emit<TKey extends EventKey<TEventMap>>(
    type: TKey,
    payload: TEventMap[TKey],
    envelope?: Partial<Pick<EventEnvelope<TKey, TEventMap[TKey]>, "version" | "timestamp" | "eventId">>,
  ): Promise<EventEnvelope<TKey, TEventMap[TKey]>> {
    const event: EventEnvelope<TKey, TEventMap[TKey]> = {
      type,
      payload,
      version: envelope?.version ?? this.version,
      timestamp: envelope?.timestamp ?? this.now(),
      eventId: envelope?.eventId ?? this.createEventId(),
    };

    const registeredHandlers = this.handlers.get(type);
    if (!registeredHandlers || registeredHandlers.size === 0) {
      return event;
    }

    for (const handler of registeredHandlers.values()) {
      await this.invokeHandler(handler, event as EventEnvelope<string, unknown>);
    }

    return event;
  }

  private async invokeHandler(
    handler: GenericHandler,
    event: EventEnvelope<string, unknown>,
  ): Promise<void> {
    try {
      await handler(event);
    } catch (e) {
      // Expected: handler errors must not stop event delivery to other subscribers
      log.debug("event handler error", { event: event.type, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

export function createHarnessEventBus(options?: TypedEventBusOptions): TypedEventBus<HarnessEventMap> {
  return new TypedEventBus<HarnessEventMap>(options);
}

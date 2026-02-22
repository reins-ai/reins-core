import type { ConversionProgressEvent } from "./types";

export type ProgressListener = (event: ConversionProgressEvent) => void;

export interface ProgressEmitterOptions {
  /**
   * Minimum interval in milliseconds between progress emissions for the same
   * category. Calls to `emitThrottled` within this window are silently dropped.
   * Defaults to 500ms per MH6 requirement.
   */
  minIntervalMs?: number;
}

export class ProgressEmitter {
  private readonly listeners = new Set<ProgressListener>();
  private readonly minIntervalMs: number;
  private lastEvent: ConversionProgressEvent | null = null;
  private lastEmitTimestamps = new Map<string, number>();

  constructor(options?: ProgressEmitterOptions) {
    this.minIntervalMs = options?.minIntervalMs ?? 500;
  }

  /**
   * Emit a progress event to all registered listeners immediately.
   * Always delivers — use `emitThrottled` for rate-limited delivery.
   */
  emit(event: ConversionProgressEvent): void {
    this.lastEvent = event;
    this.lastEmitTimestamps.set(event.category, Date.now());
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Emit a progress event only if the minimum interval has elapsed since the
   * last emission for this category. Start/complete/error events always pass
   * through regardless of throttle.
   */
  emitThrottled(event: ConversionProgressEvent): void {
    if (event.status === "started" || event.status === "complete" || event.status === "error") {
      this.emit(event);
      return;
    }

    const lastTimestamp = this.lastEmitTimestamps.get(event.category) ?? 0;
    if (Date.now() - lastTimestamp >= this.minIntervalMs) {
      this.emit(event);
    }
  }

  /**
   * Register a listener for progress events.
   * Returns an unsubscribe function for convenient cleanup.
   */
  on(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.off(listener);
    };
  }

  /**
   * Remove a previously registered listener.
   */
  off(listener: ProgressListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Remove all registered listeners.
   */
  removeAllListeners(): void {
    this.listeners.clear();
  }

  /**
   * Return the most recently emitted event, or null if none has been emitted.
   */
  getLastEvent(): ConversionProgressEvent | null {
    return this.lastEvent;
  }
}

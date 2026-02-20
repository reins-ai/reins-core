import { describe, expect, test } from "bun:test";

import {
  HeartbeatWatcherService,
  HEARTBEAT_WATCHER_MIN_DEBOUNCE_MS,
} from "../../src/heartbeat/watcher-service";

class FakeTimeoutScheduler {
  private nextId = 0;
  private readonly callbacks = new Map<number, () => void>();

  readonly delays: number[] = [];
  clearCalls = 0;

  setTimeout(callback: () => void, timeoutMs: number): number {
    const id = ++this.nextId;
    this.delays.push(timeoutMs);
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(id: number): void {
    this.clearCalls += 1;
    this.callbacks.delete(id);
  }

  runLatest(): void {
    const latestId = this.nextId;
    const callback = this.callbacks.get(latestId);
    if (!callback) {
      return;
    }

    this.callbacks.delete(latestId);
    callback();
  }
}

const ROUTINE_ONE = `## Morning Kickoff

**Trigger:** First heartbeat after 7:00 AM on weekdays

**Output Contract:**
- Calendar summary

**Actions:**
1. Check calendar
`;

const ROUTINE_TWO = `## Morning Kickoff

**Trigger:** First heartbeat after 7:00 AM on weekdays

**Output Contract:**
- Calendar summary

**Actions:**
1. Check calendar

## Evening Wind-Down

**Trigger:** First heartbeat after 6:00 PM on weekdays

**Output Contract:**
- Day summary

**Actions:**
1. Review day
`;

describe("HeartbeatWatcherService", () => {
  test("re-parses HEARTBEAT.md after debounced file change", async () => {
    const scheduler = new FakeTimeoutScheduler();
    let currentContent = ROUTINE_ONE;
    let readCount = 0;
    let onChange: (() => void) | null = null;

    const service = new HeartbeatWatcherService({
      workspacePath: "/tmp/workspace",
      readFile: async () => {
        readCount += 1;
        return currentContent;
      },
      watchFile: (_path, callback) => {
        onChange = callback;
        return { close: () => {} };
      },
      setTimeoutFn: (callback, timeoutMs) => scheduler.setTimeout(callback, timeoutMs),
      clearTimeoutFn: (id) => scheduler.clearTimeout(id as number),
    });

    const started = await service.start();
    expect(started.ok).toBe(true);
    expect(service.getTasks()).toHaveLength(1);

    currentContent = ROUTINE_TWO;
    onChange?.();

    expect(service.getTasks()).toHaveLength(1);
    expect(scheduler.delays.at(-1)).toBe(HEARTBEAT_WATCHER_MIN_DEBOUNCE_MS);

    scheduler.runLatest();
    await Promise.resolve();

    expect(service.getTasks()).toHaveLength(2);
    expect(readCount).toBe(2);
  });

  test("debounces rapid watcher events into a single parse", async () => {
    const scheduler = new FakeTimeoutScheduler();
    let readCount = 0;
    let onChange: (() => void) | null = null;

    const service = new HeartbeatWatcherService({
      workspacePath: "/tmp/workspace",
      readFile: async () => {
        readCount += 1;
        return ROUTINE_ONE;
      },
      watchFile: (_path, callback) => {
        onChange = callback;
        return { close: () => {} };
      },
      setTimeoutFn: (callback, timeoutMs) => scheduler.setTimeout(callback, timeoutMs),
      clearTimeoutFn: (id) => scheduler.clearTimeout(id as number),
    });

    await service.start();
    onChange?.();
    onChange?.();
    onChange?.();

    expect(scheduler.clearCalls).toBe(2);

    scheduler.runLatest();
    await Promise.resolve();

    expect(readCount).toBe(2);
  });

  test("exposes parsed tasks for cron due evaluation", async () => {
    const service = new HeartbeatWatcherService({
      workspacePath: "/tmp/workspace",
      readFile: async () => ROUTINE_ONE,
      watchFile: () => ({ close: () => {} }),
      now: () => new Date(2026, 1, 11, 8, 0, 0),
    });

    await service.start();

    const due = service.getDueTasks();
    expect(due).toHaveLength(1);
    expect(due[0]?.routine.name).toBe("Morning Kickoff");
  });

  test("starts and stops cleanly with watcher cleanup", async () => {
    const scheduler = new FakeTimeoutScheduler();
    let onChange: (() => void) | null = null;
    let closed = false;

    const service = new HeartbeatWatcherService({
      workspacePath: "/tmp/workspace",
      readFile: async () => ROUTINE_ONE,
      watchFile: (_path, callback) => {
        onChange = callback;
        return {
          close: () => {
            closed = true;
          },
        };
      },
      setTimeoutFn: (callback, timeoutMs) => scheduler.setTimeout(callback, timeoutMs),
      clearTimeoutFn: (id) => scheduler.clearTimeout(id as number),
    });

    const started = await service.start();
    expect(started.ok).toBe(true);

    onChange?.();
    const stopped = await service.stop();

    expect(stopped.ok).toBe(true);
    expect(closed).toBe(true);
    expect(scheduler.clearCalls).toBe(1);

    const stoppedAgain = await service.stop();
    expect(stoppedAgain.ok).toBe(true);
  });
});

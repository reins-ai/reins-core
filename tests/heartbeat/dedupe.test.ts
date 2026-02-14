import { describe, expect, test } from "bun:test";

import { AlertDedupeStore } from "../../src/heartbeat/dedupe";
import { HeartbeatOutputHandler } from "../../src/heartbeat/handler";

describe("AlertDedupeStore", () => {
  test("suppresses alerts inside dedupe window", () => {
    let now = 1_000;
    const store = new AlertDedupeStore(10_000, () => now);
    const key = store.generateAlertKey("Reminder: stretch");

    expect(store.isDuplicate(key)).toBe(false);
    store.recordAlert(key);
    expect(store.isDuplicate(key)).toBe(true);

    now = 12_000;
    expect(store.isDuplicate(key)).toBe(false);
  });

  test("cleanup purges expired entries", () => {
    let now = 5_000;
    const store = new AlertDedupeStore(5_000, () => now);
    const key = store.generateAlertKey("Follow up on daily plan");

    store.recordAlert(key);
    expect(store.isDuplicate(key)).toBe(true);

    now = 20_000;
    store.cleanup();
    expect(store.isDuplicate(key)).toBe(false);
  });

  test("generateAlertKey normalizes spacing and case", () => {
    const store = new AlertDedupeStore();

    const a = store.generateAlertKey("  Check  Calendar  ");
    const b = store.generateAlertKey("check calendar");
    const c = store.generateAlertKey("check reminders");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("HeartbeatOutputHandler", () => {
  test("suppresses ack-only responses", () => {
    const handler = new HeartbeatOutputHandler(new AlertDedupeStore());

    const result = handler.processOutput("HEARTBEAT_OK");

    expect(result.shouldDeliver).toBe(false);
    expect(result.reason).toBe("ack_suppressed");
  });

  test("delivers first alert and suppresses duplicate", () => {
    const handler = new HeartbeatOutputHandler(new AlertDedupeStore());

    const first = handler.processOutput("Alert: weekly review is due.");
    const second = handler.processOutput("Alert: weekly review is due.");

    expect(first.shouldDeliver).toBe(true);
    expect(first.reason).toBe("delivered");

    expect(second.shouldDeliver).toBe(false);
    expect(second.reason).toBe("duplicate_suppressed");
  });
});

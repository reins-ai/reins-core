import { describe, expect, it } from "bun:test";

import {
  createHarnessEvent,
  createHarnessEventBus,
  TypedEventBus,
  type EventEnvelope,
  type HarnessEventMap,
} from "../../src/harness";

describe("TypedEventBus", () => {
  it("creates harness events with envelope metadata", () => {
    const event = createHarnessEvent({
      type: "token",
      payload: { content: "hello" },
      timestamp: 1700000000000,
      eventId: "evt_test",
    });

    expect(event.type).toBe("token");
    expect(event.payload.content).toBe("hello");
    expect(event.version).toBe(1);
    expect(event.timestamp).toBe(1700000000000);
    expect(event.eventId).toBe("evt_test");
  });

  it("dispatches handlers in registration order", async () => {
    const bus = createHarnessEventBus({
      now: () => 1700000000010,
      createEventId: () => "evt_order",
    });
    const calls: string[] = [];

    bus.on("token", async (event) => {
      calls.push(`first:${event.payload.content}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      calls.push("first:done");
    });
    bus.on("token", (event) => {
      calls.push(`second:${event.payload.content}`);
    });

    const emitted = await bus.emit("token", { content: "abc" });

    expect(emitted.eventId).toBe("evt_order");
    expect(emitted.timestamp).toBe(1700000000010);
    expect(calls).toEqual(["first:abc", "first:done", "second:abc"]);
  });

  it("isolates handler errors and continues delivery", async () => {
    const bus = createHarnessEventBus();
    const calls: string[] = [];

    bus.on("message_start", () => {
      calls.push("boom");
      throw new Error("fail");
    });
    bus.on("message_start", () => {
      calls.push("safe");
    });

    await expect(
      bus.emit("message_start", {
        messageId: "msg_1",
        conversationId: "conv_1",
        model: "claude-sonnet",
      }),
    ).resolves.toBeDefined();
    expect(calls).toEqual(["boom", "safe"]);
  });

  it("supports unsubscribe via off and cleanup callback", async () => {
    const bus = createHarnessEventBus();
    let calls = 0;

    const handler = () => {
      calls += 1;
    };

    const unsubscribe = bus.on("aborted", handler);
    await bus.emit("aborted", { initiatedBy: "user", reason: "manual" });
    bus.off("aborted", handler);
    await bus.emit("aborted", { initiatedBy: "user" });

    const secondHandler = () => {
      calls += 1;
    };

    const cleanup = bus.on("aborted", secondHandler);
    await bus.emit("aborted", { initiatedBy: "system" });
    cleanup();
    unsubscribe();
    await bus.emit("aborted", { initiatedBy: "system", reason: "timeout" });

    expect(calls).toBe(2);
  });

  it("preserves strong typing for event payloads", async () => {
    const bus = new TypedEventBus<HarnessEventMap>();
    const received: EventEnvelope<"token", HarnessEventMap["token"]>[] = [];

    bus.on("token", (event) => {
      received.push(event);
    });

    const permissionPayload: HarnessEventMap["permission_request"] = {
      requestId: "perm_1",
      toolCall: {
        id: "tool_1",
        name: "calendar.create",
        arguments: { title: "Sync" },
      },
      profile: "standard",
      reason: "Tool can modify calendar state",
    };
    const donePayload: HarnessEventMap["done"] = {
      usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      finishReason: "stop",
    };

    await bus.emit("token", { content: "typed" });
    await bus.emit("permission_request", permissionPayload);
    await bus.emit("done", donePayload);

    expect(received[0]?.payload.content).toBe("typed");
  });

  it("allows envelope overrides on emit", async () => {
    const bus = createHarnessEventBus();

    const event = await bus.emit(
      "compaction",
      {
        summary: "Compacted old messages",
        beforeTokenEstimate: 9000,
        afterTokenEstimate: 3800,
      },
      {
        version: 2,
        timestamp: 1700000000200,
        eventId: "evt_override",
      },
    );

    expect(event.version).toBe(2);
    expect(event.timestamp).toBe(1700000000200);
    expect(event.eventId).toBe("evt_override");
  });
});

import { describe, expect, it } from "bun:test";

import {
  createHarnessEventBus,
  EventTransportAdapter,
  type TransportFrame,
} from "../../src/harness";

describe("EventTransportAdapter regression: replay buffer", () => {
  it("respects replay limit by evicting oldest frames", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({
      eventBus: bus,
      replayLimit: 3,
    });

    adapter.start();

    await bus.emit("token", { content: "a" });
    await bus.emit("token", { content: "b" });
    await bus.emit("token", { content: "c" });
    await bus.emit("token", { content: "d" });
    await bus.emit("token", { content: "e" });

    const buffer = adapter.getReplayBuffer();
    expect(buffer).toHaveLength(3);
    expect(buffer[0]?.id).toBe(3);
    expect(buffer[1]?.id).toBe(4);
    expect(buffer[2]?.id).toBe(5);

    adapter.stop();
  });

  it("returns empty replay buffer when no events emitted", () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });

    adapter.start();
    const buffer = adapter.getReplayBuffer();
    expect(buffer).toHaveLength(0);
    adapter.stop();
  });

  it("filters replay buffer by sinceSequenceId", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });

    adapter.start();

    await bus.emit("token", { content: "1" });
    await bus.emit("token", { content: "2" });
    await bus.emit("token", { content: "3" });
    await bus.emit("token", { content: "4" });

    const since2 = adapter.getReplayBuffer(2);
    expect(since2).toHaveLength(2);
    expect(since2[0]?.id).toBe(3);
    expect(since2[1]?.id).toBe(4);

    const since4 = adapter.getReplayBuffer(4);
    expect(since4).toHaveLength(0);

    const since0 = adapter.getReplayBuffer(0);
    expect(since0).toHaveLength(4);

    adapter.stop();
  });
});

describe("EventTransportAdapter regression: start/stop lifecycle", () => {
  it("does not emit frames after stop", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    await bus.emit("token", { content: "before-stop" });
    expect(frames).toHaveLength(1);

    adapter.stop();

    await bus.emit("token", { content: "after-stop" });
    expect(frames).toHaveLength(1);
  });

  it("start is idempotent — calling start twice does not duplicate subscriptions", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();
    adapter.start(); // second call should be no-op

    await bus.emit("token", { content: "test" });

    // Should only receive one frame, not two
    expect(frames).toHaveLength(1);

    adapter.stop();
  });

  it("stop is idempotent — calling stop twice does not throw", () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });

    adapter.start();
    adapter.stop();
    adapter.stop(); // should not throw
  });

  it("can restart after stop", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });

    adapter.start();
    await bus.emit("token", { content: "first" });
    adapter.stop();

    await bus.emit("token", { content: "during-stop" });

    adapter.start();
    await bus.emit("token", { content: "after-restart" });
    adapter.stop();

    expect(frames).toHaveLength(2);
    expect(JSON.parse(frames[0]?.data ?? "{}")).toEqual({ content: "first" });
    expect(JSON.parse(frames[1]?.data ?? "{}")).toEqual({ content: "after-restart" });
  });
});

describe("EventTransportAdapter regression: frame handler isolation", () => {
  it("isolates frame handler errors so other handlers still receive frames", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const received: string[] = [];

    adapter.onFrame(() => {
      received.push("handler-1");
      throw new Error("handler-1 failure");
    });
    adapter.onFrame(() => {
      received.push("handler-2");
    });

    adapter.start();
    await bus.emit("token", { content: "test" });
    adapter.stop();

    expect(received).toEqual(["handler-1", "handler-2"]);
  });

  it("supports unsubscribing frame handlers", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const received: string[] = [];

    const unsub = adapter.onFrame(() => {
      received.push("handler");
    });

    adapter.start();
    await bus.emit("token", { content: "1" });
    unsub();
    await bus.emit("token", { content: "2" });
    adapter.stop();

    expect(received).toEqual(["handler"]);
  });
});

describe("EventTransportAdapter regression: SSE round-trip edge cases", () => {
  it("handles multi-line data in SSE frames", () => {
    const frame: TransportFrame = {
      id: 1,
      event: "error",
      data: '{"error":"line1\\nline2"}',
      timestamp: 1700000000000,
    };

    const sse = EventTransportAdapter.toSSE(frame);
    const parsed = EventTransportAdapter.fromSSE(sse);

    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(1);
    expect(parsed?.event).toBe("error");
  });

  it("returns null for empty SSE string", () => {
    expect(EventTransportAdapter.fromSSE("")).toBeNull();
  });

  it("returns null for SSE missing required fields", () => {
    expect(EventTransportAdapter.fromSSE("id: 1\n\n")).toBeNull();
    expect(EventTransportAdapter.fromSSE("event: token\n\n")).toBeNull();
    expect(EventTransportAdapter.fromSSE("data: test\n\n")).toBeNull();
  });

  it("returns null for SSE with non-numeric id", () => {
    expect(EventTransportAdapter.fromSSE("id: abc\nevent: token\ndata: test\n\n")).toBeNull();
  });

  it("returns null for SSE with empty event name", () => {
    expect(EventTransportAdapter.fromSSE("id: 1\nevent: \ndata: test\n\n")).toBeNull();
  });

  it("handles SSE with multiple data lines", () => {
    const sse = "id: 1\nevent: token\ndata: line1\ndata: line2\n\n";
    const parsed = EventTransportAdapter.fromSSE(sse);

    expect(parsed).not.toBeNull();
    expect(parsed?.data).toBe("line1\nline2");
  });
});

describe("EventTransportAdapter regression: tool lifecycle ordering", () => {
  it("preserves emitted order for interleaved token and tool events", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => {
      frames.push(frame);
    });
    adapter.start();

    await bus.emit("token", { content: "before" });
    await bus.emit("tool_call_start", {
      toolCall: { id: "tool-a", name: "read", arguments: { filePath: "a.ts" } },
    });
    await bus.emit("tool_call_start", {
      toolCall: { id: "tool-b", name: "glob", arguments: { pattern: "**/*.ts" } },
    });
    await bus.emit("tool_call_end", {
      result: { callId: "tool-b", name: "glob", result: ["a.ts"] },
    });
    await bus.emit("tool_call_end", {
      result: { callId: "tool-a", name: "read", result: "done" },
    });
    await bus.emit("token", { content: "after" });

    expect(frames.map((frame) => frame.event)).toEqual([
      "token",
      "tool_call_start",
      "tool_call_start",
      "tool_call_end",
      "tool_call_end",
      "token",
    ]);
    expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3, 4, 5, 6]);

    const endPayloads = frames
      .filter((frame) => frame.event === "tool_call_end")
      .map((frame) => JSON.parse(frame.data) as { result: { callId: string } });
    expect(endPayloads[0]?.result.callId).toBe("tool-b");
    expect(endPayloads[1]?.result.callId).toBe("tool-a");

    adapter.stop();
  });

  it("does not drop rapid tool lifecycle events", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus, replayLimit: 512 });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => {
      frames.push(frame);
    });
    adapter.start();

    const emits: Array<Promise<unknown>> = [];
    for (let i = 0; i < 40; i++) {
      emits.push(
        bus.emit("tool_call_start", {
          toolCall: {
            id: `tool-${i}`,
            name: "read",
            arguments: { filePath: `${i}.ts` },
          },
        }),
      );
      emits.push(
        bus.emit("tool_call_end", {
          result: {
            callId: `tool-${i}`,
            name: "read",
            result: "ok",
          },
        }),
      );
    }
    await Promise.all(emits);

    expect(frames).toHaveLength(80);
    expect(frames[0]?.id).toBe(1);
    expect(frames[79]?.id).toBe(80);

    const replay = adapter.getReplayBuffer();
    expect(replay).toHaveLength(80);

    adapter.stop();
  });
});

describe("EventTransportAdapter regression: abort event transport", () => {
  it("transports abort events with reason and initiator", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    await bus.emit("aborted", {
      initiatedBy: "user",
      reason: "User pressed Ctrl+C",
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("aborted");

    const payload = JSON.parse(frames[0]?.data ?? "{}") as {
      initiatedBy: string;
      reason: string;
    };
    expect(payload.initiatedBy).toBe("user");
    expect(payload.reason).toBe("User pressed Ctrl+C");

    adapter.stop();
  });

  it("transports permission_request events", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    await bus.emit("permission_request", {
      requestId: "perm-1",
      toolCall: { id: "tool-1", name: "calendar", arguments: {} },
      profile: "standard",
      reason: "Requires approval",
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("permission_request");

    const payload = JSON.parse(frames[0]?.data ?? "{}") as {
      requestId: string;
      profile: string;
    };
    expect(payload.requestId).toBe("perm-1");
    expect(payload.profile).toBe("standard");

    adapter.stop();
  });
});

describe("EventTransportAdapter regression: sequential tool event ordering", () => {
  it("preserves strict order for 5 sequential tool start/end pairs", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    for (let i = 0; i < 5; i++) {
      await bus.emit("tool_call_start", {
        toolCall: { id: `tool-${i}`, name: "read", arguments: { filePath: `${i}.ts` } },
      });
      await bus.emit("tool_call_end", {
        result: { callId: `tool-${i}`, name: "read", result: `content-${i}` },
      });
    }

    expect(frames).toHaveLength(10);

    const expectedEvents = Array.from({ length: 5 }).flatMap(() => [
      "tool_call_start",
      "tool_call_end",
    ]);
    expect(frames.map((f) => f.event)).toEqual(expectedEvents);

    for (let i = 0; i < 5; i++) {
      const startFrame = frames[i * 2];
      const endFrame = frames[i * 2 + 1];
      const startPayload = JSON.parse(startFrame?.data ?? "{}") as {
        toolCall: { id: string };
      };
      const endPayload = JSON.parse(endFrame?.data ?? "{}") as {
        result: { callId: string };
      };
      expect(startPayload.toolCall.id).toBe(`tool-${i}`);
      expect(endPayload.result.callId).toBe(`tool-${i}`);
    }

    expect(frames.map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    adapter.stop();
  });

  it("tool A finishes before tool B starts — strict sequential ordering", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    await bus.emit("tool_call_start", {
      toolCall: { id: "tool-a", name: "bash", arguments: { command: "ls" } },
    });
    await bus.emit("tool_call_end", {
      result: { callId: "tool-a", name: "bash", result: "file1.ts" },
    });
    await bus.emit("tool_call_start", {
      toolCall: { id: "tool-b", name: "read", arguments: { filePath: "file1.ts" } },
    });
    await bus.emit("tool_call_end", {
      result: { callId: "tool-b", name: "read", result: "content" },
    });

    expect(frames.map((f) => f.event)).toEqual([
      "tool_call_start",
      "tool_call_end",
      "tool_call_start",
      "tool_call_end",
    ]);

    const ids = frames.map((f) => f.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? 0);
    }

    adapter.stop();
  });
});

describe("EventTransportAdapter regression: parallel tool event ordering", () => {
  it("handles 10 parallel tool start/end pairs without event loss", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus, replayLimit: 512 });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    const emits: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i++) {
      emits.push(
        bus.emit("tool_call_start", {
          toolCall: { id: `tool-${i}`, name: "read", arguments: { filePath: `${i}.ts` } },
        }),
      );
    }
    await Promise.all(emits);

    const endEmits: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i++) {
      endEmits.push(
        bus.emit("tool_call_end", {
          result: { callId: `tool-${i}`, name: "read", result: `ok-${i}` },
        }),
      );
    }
    await Promise.all(endEmits);

    expect(frames).toHaveLength(20);

    const startFrames = frames.filter((f) => f.event === "tool_call_start");
    const endFrames = frames.filter((f) => f.event === "tool_call_end");
    expect(startFrames).toHaveLength(10);
    expect(endFrames).toHaveLength(10);

    const startIds = new Set(
      startFrames.map((f) => {
        const p = JSON.parse(f.data) as { toolCall: { id: string } };
        return p.toolCall.id;
      }),
    );
    const endIds = new Set(
      endFrames.map((f) => {
        const p = JSON.parse(f.data) as { result: { callId: string } };
        return p.result.callId;
      }),
    );

    for (let i = 0; i < 10; i++) {
      expect(startIds.has(`tool-${i}`)).toBe(true);
      expect(endIds.has(`tool-${i}`)).toBe(true);
    }

    adapter.stop();
  });

  it("fast tool completes during slow tool — no blocking", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    await bus.emit("tool_call_start", {
      toolCall: { id: "slow", name: "bash", arguments: { command: "sleep 10" } },
    });
    await bus.emit("tool_call_start", {
      toolCall: { id: "fast", name: "read", arguments: { filePath: "a.ts" } },
    });
    await bus.emit("tool_call_end", {
      result: { callId: "fast", name: "read", result: "quick-result" },
    });
    await bus.emit("tool_call_end", {
      result: { callId: "slow", name: "bash", result: "slow-result" },
    });

    expect(frames).toHaveLength(4);
    expect(frames.map((f) => f.event)).toEqual([
      "tool_call_start",
      "tool_call_start",
      "tool_call_end",
      "tool_call_end",
    ]);

    const endPayloads = frames
      .filter((f) => f.event === "tool_call_end")
      .map((f) => JSON.parse(f.data) as { result: { callId: string } });
    expect(endPayloads[0]?.result.callId).toBe("fast");
    expect(endPayloads[1]?.result.callId).toBe("slow");

    adapter.stop();
  });

  it("tools overlap — events interleaved correctly with monotonic sequence IDs", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    await bus.emit("tool_call_start", {
      toolCall: { id: "t1", name: "read", arguments: {} },
    });
    await bus.emit("tool_call_start", {
      toolCall: { id: "t2", name: "glob", arguments: {} },
    });
    await bus.emit("tool_call_end", {
      result: { callId: "t1", name: "read", result: "done" },
    });
    await bus.emit("tool_call_start", {
      toolCall: { id: "t3", name: "grep", arguments: {} },
    });
    await bus.emit("tool_call_end", {
      result: { callId: "t2", name: "glob", result: "done" },
    });
    await bus.emit("tool_call_end", {
      result: { callId: "t3", name: "grep", result: "done" },
    });

    expect(frames).toHaveLength(6);

    const ids = frames.map((f) => f.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? 0);
    }

    adapter.stop();
  });
});

describe("EventTransportAdapter regression: event payload consistency", () => {
  it("tool_use_id is consistent between start and end events", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    const toolIds = ["tool-alpha", "tool-beta", "tool-gamma"];
    for (const toolId of toolIds) {
      await bus.emit("tool_call_start", {
        toolCall: { id: toolId, name: "read", arguments: { filePath: `${toolId}.ts` } },
      });
      await bus.emit("tool_call_end", {
        result: { callId: toolId, name: "read", result: `result-${toolId}` },
      });
    }

    for (let i = 0; i < toolIds.length; i++) {
      const startFrame = frames[i * 2];
      const endFrame = frames[i * 2 + 1];
      const startPayload = JSON.parse(startFrame?.data ?? "{}") as {
        toolCall: { id: string };
      };
      const endPayload = JSON.parse(endFrame?.data ?? "{}") as {
        result: { callId: string };
      };
      expect(startPayload.toolCall.id).toBe(toolIds[i]);
      expect(endPayload.result.callId).toBe(toolIds[i]);
    }

    adapter.stop();
  });

  it("sequence IDs are monotonically increasing across mixed event types", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    await bus.emit("token", { content: "Hello" });
    await bus.emit("tool_call_start", {
      toolCall: { id: "t1", name: "read", arguments: {} },
    });
    await bus.emit("token", { content: " world" });
    await bus.emit("tool_call_end", {
      result: { callId: "t1", name: "read", result: "ok" },
    });
    await bus.emit("done", {
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "stop",
    });

    expect(frames).toHaveLength(5);

    const ids = frames.map((f) => f.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? 0);
    }

    adapter.stop();
  });

  it("error flags are preserved in tool_call_end payloads", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    await bus.emit("tool_call_end", {
      result: {
        callId: "tool-err",
        name: "bash",
        result: null,
        error: "Command not found",
      },
    });

    expect(frames).toHaveLength(1);
    const payload = JSON.parse(frames[0]?.data ?? "{}") as {
      result: { callId: string; error: string };
    };
    expect(payload.result.callId).toBe("tool-err");
    expect(payload.result.error).toBe("Command not found");

    adapter.stop();
  });
});

describe("EventTransportAdapter regression: rapid burst stress", () => {
  it("100 rapid tool calls — all events ordered and accounted for", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus, replayLimit: 1024 });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    const emits: Array<Promise<unknown>> = [];
    for (let i = 0; i < 100; i++) {
      emits.push(
        bus.emit("tool_call_start", {
          toolCall: { id: `tool-${i}`, name: "read", arguments: { filePath: `${i}.ts` } },
        }),
      );
      emits.push(
        bus.emit("tool_call_end", {
          result: { callId: `tool-${i}`, name: "read", result: `ok-${i}` },
        }),
      );
    }
    await Promise.all(emits);

    expect(frames).toHaveLength(200);

    const ids = frames.map((f) => f.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? 0);
    }

    const replay = adapter.getReplayBuffer();
    expect(replay).toHaveLength(200);

    adapter.stop();
  });

  it("event buffer does not reorder under load — replay matches emission order", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus, replayLimit: 512 });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    for (let i = 0; i < 50; i++) {
      await bus.emit("token", { content: `chunk-${i}` });
      if (i % 5 === 0) {
        await bus.emit("tool_call_start", {
          toolCall: { id: `tool-${i}`, name: "read", arguments: {} },
        });
        await bus.emit("tool_call_end", {
          result: { callId: `tool-${i}`, name: "read", result: "ok" },
        });
      }
    }

    const replay = adapter.getReplayBuffer();
    expect(replay).toHaveLength(frames.length);

    for (let i = 0; i < frames.length; i++) {
      expect(replay[i]?.id).toBe(frames[i]?.id);
      expect(replay[i]?.event).toBe(frames[i]?.event);
    }

    adapter.stop();
  });
});

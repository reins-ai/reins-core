import { describe, expect, it } from "bun:test";

import { InMemoryPluginEventBus } from "../../src/plugins/events";

describe("InMemoryPluginEventBus", () => {
  it("emits events to all subscribers", async () => {
    const bus = new InMemoryPluginEventBus();
    const received: string[] = [];

    bus.on("message", "plugin-a", async () => {
      received.push("a");
    });
    bus.on("message", "plugin-b", async () => {
      received.push("b");
    });

    await bus.emit("message", { text: "hello" });

    expect(received.sort()).toEqual(["a", "b"]);
  });

  it("supports subscribe and unsubscribe", async () => {
    const bus = new InMemoryPluginEventBus();
    let calls = 0;
    const handler = async () => {
      calls += 1;
    };

    bus.on("tool_call", "plugin-a", handler);
    await bus.emit("tool_call", {});
    bus.off("tool_call", "plugin-a", handler);
    await bus.emit("tool_call", {});

    expect(calls).toBe(1);
  });

  it("removeAll removes all handlers for a plugin", async () => {
    const bus = new InMemoryPluginEventBus();
    const received: string[] = [];

    bus.on("message", "plugin-a", async () => {
      received.push("a-message");
    });
    bus.on("conversation_start", "plugin-a", async () => {
      received.push("a-start");
    });
    bus.on("message", "plugin-b", async () => {
      received.push("b-message");
    });

    bus.removeAll("plugin-a");

    await bus.emit("message", {});
    await bus.emit("conversation_start", {});

    expect(received).toEqual(["b-message"]);
  });

  it("awaits async handlers", async () => {
    const bus = new InMemoryPluginEventBus();
    const steps: string[] = [];

    bus.on("message", "plugin-a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      steps.push("done");
    });

    await bus.emit("message", {});

    expect(steps).toEqual(["done"]);
  });

  it("swallows handler errors and continues", async () => {
    const bus = new InMemoryPluginEventBus();
    let safeHandlerCalls = 0;

    bus.on("message", "plugin-a", async () => {
      throw new Error("boom");
    });
    bus.on("message", "plugin-b", async () => {
      safeHandlerCalls += 1;
    });

    await expect(bus.emit("message", {})).resolves.toBeUndefined();
    expect(safeHandlerCalls).toBe(1);
  });
});

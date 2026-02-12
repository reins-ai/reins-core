import { describe, expect, it } from "bun:test";

import {
  InMemoryPluginConfigStore,
  InMemoryPluginToolRegistry,
  PluginContextImpl,
} from "../../src/plugins/context";
import { InMemoryPluginEventBus } from "../../src/plugins/events";
import { InMemoryLogOutput, ScopedPluginLogger } from "../../src/plugins/logger";
import { StubPluginDataAccess } from "../../src/plugins/api";
import type { Tool } from "../../src/types";

function createTool(name: string): Tool {
  return {
    definition: {
      name,
      description: "tool",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    async execute(): Promise<{ callId: string; name: string; result: unknown }> {
      return {
        callId: "call-1",
        name,
        result: { ok: true },
      };
    },
  };
}

describe("PluginContextImpl API surface", () => {
  it("registers tools with plugin namespace prefix", () => {
    const toolRegistry = new InMemoryPluginToolRegistry();
    const context = new PluginContextImpl(
      "weather",
      ["read_notes"],
      new InMemoryPluginEventBus(),
      toolRegistry,
      new StubPluginDataAccess(),
      new InMemoryPluginConfigStore(),
      new ScopedPluginLogger("weather", new InMemoryLogOutput()),
    );

    context.registerTool(createTool("forecast"));

    const tools = toolRegistry.list("weather");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.definition.name).toBe("weather.forecast");
  });

  it("supports event subscription and emission", async () => {
    const eventBus = new InMemoryPluginEventBus();
    const context = new PluginContextImpl(
      "weather",
      ["read_notes"],
      eventBus,
      new InMemoryPluginToolRegistry(),
      new StubPluginDataAccess(),
      new InMemoryPluginConfigStore(),
      new ScopedPluginLogger("weather", new InMemoryLogOutput()),
    );

    let received = 0;
    const handler = async () => {
      received += 1;
    };

    context.on("message", handler);
    await eventBus.emit("message", { text: "hello" });
    context.off("message", handler);
    await eventBus.emit("message", { text: "again" });

    expect(received).toBe(1);
  });

  it("removes plugin handlers on uninstall cleanup", async () => {
    const eventBus = new InMemoryPluginEventBus();
    const context = new PluginContextImpl(
      "weather",
      ["read_notes"],
      eventBus,
      new InMemoryPluginToolRegistry(),
      new StubPluginDataAccess(),
      new InMemoryPluginConfigStore(),
      new ScopedPluginLogger("weather", new InMemoryLogOutput()),
    );

    let calls = 0;
    context.on("message", async () => {
      calls += 1;
    });

    await eventBus.emit("message", {});
    eventBus.removeAll("weather");
    await eventBus.emit("message", {});

    expect(calls).toBe(1);
  });

  it("gets and sets plugin config", () => {
    const context = new PluginContextImpl(
      "weather",
      ["read_notes"],
      new InMemoryPluginEventBus(),
      new InMemoryPluginToolRegistry(),
      new StubPluginDataAccess(),
      new InMemoryPluginConfigStore(),
      new ScopedPluginLogger("weather", new InMemoryLogOutput()),
    );

    context.config.set("units", "metric");

    expect(context.config.get("units")).toBe("metric");
  });

  it("logs with plugin name scope", () => {
    const output = new InMemoryLogOutput();
    const context = new PluginContextImpl(
      "weather",
      ["read_notes"],
      new InMemoryPluginEventBus(),
      new InMemoryPluginToolRegistry(),
      new StubPluginDataAccess(),
      new InMemoryPluginConfigStore(),
      new ScopedPluginLogger("weather", output),
    );

    context.log.info("ready");

    const entries = output.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.pluginName).toBe("weather");
    expect(entries[0]?.message).toBe("ready");
  });

  it("isolates data and config per plugin context", () => {
    const configStore = new InMemoryPluginConfigStore();
    const eventBus = new InMemoryPluginEventBus();
    const toolRegistry = new InMemoryPluginToolRegistry();
    const dataAccess = new StubPluginDataAccess();
    const output = new InMemoryLogOutput();

    const pluginA = new PluginContextImpl(
      "plugin-a",
      ["read_notes"],
      eventBus,
      toolRegistry,
      dataAccess,
      configStore,
      new ScopedPluginLogger("plugin-a", output),
    );

    const pluginB = new PluginContextImpl(
      "plugin-b",
      ["read_notes"],
      eventBus,
      toolRegistry,
      dataAccess,
      configStore,
      new ScopedPluginLogger("plugin-b", output),
    );

    pluginA.config.set("sharedKey", "a");
    pluginB.config.set("sharedKey", "b");

    expect(pluginA.config.get("sharedKey")).toBe("a");
    expect(pluginB.config.get("sharedKey")).toBe("b");
  });
});

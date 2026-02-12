import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";

import type { PluginDataAccess } from "../../../src/plugins/api";
import {
  DEFAULT_RESOURCE_LIMITS,
  MockPluginSandbox,
  PluginSandbox,
  type SandboxConfig,
} from "../../../src/plugins/sandbox";

function fixturePath(name: string): string {
  return resolve(import.meta.dir, "fixtures", name);
}

function createConfig(pluginName: string, entryPoint: string): SandboxConfig {
  return {
    pluginName,
    entryPoint,
    permissions: ["read_notes", "network_access", "file_access"],
    limits: {
      ...DEFAULT_RESOURCE_LIMITS,
      maxCpuTimeMs: 5_000,
      maxEventHandlerMs: 100,
    },
    timeout: 1_000,
  };
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const stop = cleanup.pop();
    if (stop) {
      await stop();
    }
  }
});

describe("MockPluginSandbox", () => {
  it("starts and reports running", async () => {
    const sandbox = new MockPluginSandbox(createConfig("basic", fixturePath("basic-plugin.ts")));
    cleanup.push(() => sandbox.stop());

    await sandbox.start();

    expect(sandbox.isRunning()).toBe(true);
  });

  it("stops cleanly", async () => {
    const sandbox = new MockPluginSandbox(createConfig("basic", fixturePath("basic-plugin.ts")));

    await sandbox.start();
    await sandbox.stop();

    expect(sandbox.isRunning()).toBe(false);
  });

  it("registers tools from plugin", async () => {
    const sandbox = new MockPluginSandbox(createConfig("basic", fixturePath("basic-plugin.ts")));
    cleanup.push(() => sandbox.stop());

    const seen: string[] = [];
    sandbox.onToolRegistered((tool) => {
      seen.push(tool.name);
    });

    await sandbox.start();

    expect(seen).toContain("echo");
    expect(sandbox.getRegisteredTools().map((tool) => tool.name)).toContain("echo");
  });

  it("forwards events to plugin handlers", async () => {
    const sandbox = new MockPluginSandbox(createConfig("basic", fixturePath("basic-plugin.ts")));
    cleanup.push(() => sandbox.stop());

    await sandbox.start();
    await expect(sandbox.sendEvent("message", { text: "hello" })).resolves.toBeUndefined();
  });

  it("runs multiple sandboxes independently", async () => {
    const sandboxA = new MockPluginSandbox(createConfig("a", fixturePath("basic-plugin.ts")));
    const sandboxB = new MockPluginSandbox(createConfig("b", fixturePath("basic-plugin.ts")));
    cleanup.push(() => sandboxA.stop());
    cleanup.push(() => sandboxB.stop());

    await sandboxA.start();
    await sandboxB.start();

    expect(sandboxA.getRegisteredTools().map((tool) => tool.name)).toContain("echo");
    expect(sandboxB.getRegisteredTools().map((tool) => tool.name)).toContain("echo");
  });
});

describe("PluginSandbox (worker threads)", () => {
  it("starts and reports ready", async () => {
    const sandbox = new PluginSandbox(createConfig("worker-basic", fixturePath("basic-plugin.ts")));
    cleanup.push(() => sandbox.stop());

    await sandbox.start();

    expect(sandbox.isRunning()).toBe(true);
    expect(sandbox.getRegisteredTools().map((tool) => tool.name)).toContain("echo");
  });

  it("executes registered tool calls via worker", async () => {
    const sandbox = new PluginSandbox(createConfig("worker-tool", fixturePath("basic-plugin.ts")));
    cleanup.push(() => sandbox.stop());

    await sandbox.start();
    const result = await sandbox.executeToolCall(
      "echo",
      { text: "hello" },
      { conversationId: "conv-1", userId: "user-1" },
    );

    expect(result.name).toBe("echo");
    expect(result.result).toEqual({ text: "hello", userId: "user-1" });
  });

  it("sends API requests and receives responses", async () => {
    const sandbox = new PluginSandbox(createConfig("worker-api", fixturePath("api-plugin.ts")));
    cleanup.push(() => sandbox.stop());

    const dataAccess: PluginDataAccess = {
      conversations: {
        list: async () => [],
        getMessages: async () => [],
      },
      calendar: {
        list: async () => [],
        create: async (input) => ({ id: "c", ...input }),
      },
      notes: {
        list: async () => [{ id: "n", title: "N", content: "C", updatedAt: new Date() }],
        create: async (input) => ({ id: "n2", ...input, updatedAt: new Date() }),
      },
      reminders: {
        list: async () => [],
        create: async (input) => ({ id: "r", ...input, completed: false }),
      },
    };

    sandbox.setDataAccess(dataAccess);
    await sandbox.start();
    await sandbox.sendEvent("message", { ok: true });

    const logs = sandbox.getLogs();
    expect(logs.map((entry) => entry.message)).toContain("notes-list-called");
  });

  it("enforces timeout and stops worker", async () => {
    const timeoutConfig = createConfig("worker-timeout", fixturePath("timeout-plugin.ts"));
    timeoutConfig.limits.maxEventHandlerMs = 50;

    const sandbox = new PluginSandbox(timeoutConfig);
    cleanup.push(() => sandbox.stop());

    await sandbox.start();
    await expect(sandbox.sendEvent("message", {})).rejects.toThrow("timed out");
    expect(sandbox.isRunning()).toBe(false);
  });

  it("isolates crash to failing sandbox", async () => {
    const crashingSandbox = new PluginSandbox(
      createConfig("worker-crash", fixturePath("crash-plugin.ts")),
    );
    const healthySandbox = new PluginSandbox(
      createConfig("worker-healthy", fixturePath("basic-plugin.ts")),
    );
    cleanup.push(() => crashingSandbox.stop());
    cleanup.push(() => healthySandbox.stop());

    await crashingSandbox.start();
    await healthySandbox.start();

    await expect(crashingSandbox.sendEvent("message", {})).rejects.toThrow("plugin-crash");
    await expect(healthySandbox.sendEvent("message", { text: "still-running" })).resolves.toBeUndefined();
  });
});

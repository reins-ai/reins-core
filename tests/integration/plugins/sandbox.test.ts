import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { InMemoryPermissionAuditLog } from "../../../src/plugins/audit";
import { InMemoryPluginEventBus } from "../../../src/plugins/events";
import { PluginLifecycleManager } from "../../../src/plugins/lifecycle";
import { PluginLoader } from "../../../src/plugins/loader";
import { PluginPermissionChecker } from "../../../src/plugins/permissions";
import { DEFAULT_RESOURCE_LIMITS, MockPluginSandbox, type SandboxConfig } from "../../../src/plugins/sandbox";
import { InMemoryPluginStateStore } from "../../../src/plugins/state";
import type { PluginManifest } from "../../../src/types";

function fixturePath(name: string): string {
  return resolve(import.meta.dir, "..", "..", "plugins", "sandbox", "fixtures", name);
}

function createManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "sandbox-plugin",
    version: "1.0.0",
    description: "Sandbox plugin",
    author: "Reins",
    permissions: ["read_notes"],
    entryPoint: fixturePath("basic-plugin.ts"),
    ...overrides,
  };
}

const liveSandboxes: MockPluginSandbox[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  while (liveSandboxes.length > 0) {
    const sandbox = liveSandboxes.pop();
    if (sandbox) {
      await sandbox.stop();
    }
  }

  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createAsyncTimeoutPlugin(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reins-int-sandbox-timeout-"));
  tempRoots.push(root);
  const entryPoint = join(root, "async-timeout-plugin.ts");
  await writeFile(
    entryPoint,
    `
export default async function setupPlugin(context) {
  context.on("message", async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
}
`,
    "utf8",
  );
  return entryPoint;
}

function createMockSandbox(config: SandboxConfig, auditLog: InMemoryPermissionAuditLog): MockPluginSandbox {
  const sandbox = new MockPluginSandbox(
    {
      ...config,
      limits: {
        ...DEFAULT_RESOURCE_LIMITS,
        maxEventHandlerMs: config.limits.maxEventHandlerMs,
      },
    },
    auditLog,
  );
  liveSandboxes.push(sandbox);
  return sandbox;
}

describe("integration/plugins/sandbox", () => {
  it("isolates plugin crashes and timeout failures without crashing host", async () => {
    const auditLog = new InMemoryPermissionAuditLog();
    const timeoutEntryPoint = await createAsyncTimeoutPlugin();

    const activateCrashSandbox = createMockSandbox(
      {
        pluginName: "activate-crash",
        entryPoint: fixturePath("crash-plugin.ts"),
        permissions: ["read_notes"],
        limits: { ...DEFAULT_RESOURCE_LIMITS, maxEventHandlerMs: 50 },
        timeout: 500,
      },
      auditLog,
    );
    const healthyAfterCrash = createMockSandbox(
      {
        pluginName: "healthy-after-crash",
        entryPoint: fixturePath("basic-plugin.ts"),
        permissions: ["read_notes"],
        limits: { ...DEFAULT_RESOURCE_LIMITS, maxEventHandlerMs: 50 },
        timeout: 500,
      },
      auditLog,
    );

    await activateCrashSandbox.start();
    await expect(activateCrashSandbox.sendEvent("message", { trigger: true })).rejects.toThrow("plugin-crash");
    await healthyAfterCrash.start();
    await expect(healthyAfterCrash.sendEvent("message", { ok: true })).resolves.toBeUndefined();
    expect(healthyAfterCrash.isRunning()).toBe(true);

    const timeoutSandbox = createMockSandbox(
      {
        pluginName: "timeout-plugin",
        entryPoint: timeoutEntryPoint,
        permissions: ["read_notes"],
        limits: { ...DEFAULT_RESOURCE_LIMITS, maxEventHandlerMs: 40 },
        timeout: 500,
      },
      auditLog,
    );
    await timeoutSandbox.start();
    await expect(timeoutSandbox.sendEvent("message", { slow: true })).rejects.toThrow("timed out");
    expect(timeoutSandbox.isRunning()).toBe(false);
  });

  it("runs plugins independently and routes tool calls through sandbox boundary", async () => {
    const auditLog = new InMemoryPermissionAuditLog();

    const sandboxOne = createMockSandbox(
      {
        pluginName: "sandbox-one",
        entryPoint: fixturePath("basic-plugin.ts"),
        permissions: ["read_notes"],
        limits: { ...DEFAULT_RESOURCE_LIMITS, maxEventHandlerMs: 100 },
        timeout: 500,
      },
      auditLog,
    );
    const sandboxTwo = createMockSandbox(
      {
        pluginName: "sandbox-two",
        entryPoint: fixturePath("basic-plugin.ts"),
        permissions: ["read_notes"],
        limits: { ...DEFAULT_RESOURCE_LIMITS, maxEventHandlerMs: 100 },
        timeout: 500,
      },
      auditLog,
    );

    await sandboxOne.start();
    await sandboxTwo.start();

    const resultOne = await sandboxOne.executeToolCall(
      "echo",
      { text: "alpha" },
      { conversationId: "conv-1", userId: "u-1" },
    );
    const resultTwo = await sandboxTwo.executeToolCall(
      "echo",
      { text: "beta" },
      { conversationId: "conv-2", userId: "u-2" },
    );

    expect(resultOne.result).toEqual({ text: "alpha", userId: "u-1" });
    expect(resultTwo.result).toEqual({ text: "beta", userId: "u-2" });

    await sandboxOne.stop();
    expect(sandboxOne.isRunning()).toBe(false);
    expect(sandboxTwo.isRunning()).toBe(true);
  });

  it("cleans up sandbox resources when plugin unloads", async () => {
    const stateStore = new InMemoryPluginStateStore();
    const lifecycleManager = new PluginLifecycleManager(stateStore);
    const auditLog = new InMemoryPermissionAuditLog();
    const eventBus = new InMemoryPluginEventBus();
    const created = new Map<string, MockPluginSandbox>();

    const loader = new PluginLoader(
      lifecycleManager,
      (config: SandboxConfig) => {
        const sandbox = createMockSandbox(
          {
            ...config,
            limits: { ...DEFAULT_RESOURCE_LIMITS, maxEventHandlerMs: 100 },
          },
          auditLog,
        );
        created.set(config.pluginName, sandbox);
        return sandbox;
      },
      (pluginName, permissions) => new PluginPermissionChecker(pluginName, permissions, auditLog),
      auditLog,
      eventBus,
    );

    await lifecycleManager.install(
      createManifest({ name: "cleanup-plugin", entryPoint: fixturePath("basic-plugin.ts") }),
      fixturePath("basic-plugin.ts"),
    );
    await lifecycleManager.enable("cleanup-plugin");
    await loader.loadPlugin("cleanup-plugin");

    expect(loader.isLoaded("cleanup-plugin")).toBe(true);
    expect(created.get("cleanup-plugin")?.isRunning()).toBe(true);

    await loader.unloadPlugin("cleanup-plugin");

    expect(loader.isLoaded("cleanup-plugin")).toBe(false);
    expect(loader.getRegisteredTools("cleanup-plugin")).toHaveLength(0);
    expect(created.get("cleanup-plugin")?.isRunning()).toBe(false);

    await expect(eventBus.emit("message", { after: "unload" })).resolves.toBeUndefined();
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateManifest } from "../../src/plugins/manifest";
import { DEFAULT_RESOURCE_LIMITS, PluginSandbox, type SandboxConfig } from "../../src/plugins/sandbox";

const sandboxCleanup: Array<() => Promise<void>> = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  while (sandboxCleanup.length > 0) {
    const stop = sandboxCleanup.pop();
    if (stop) {
      await stop();
    }
  }

  for (const directory of tempDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createTempPlugin(name: string, source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `reins-security-${name}-`));
  tempDirectories.push(directory);
  const entryPoint = join(directory, `${name}.ts`);
  await writeFile(entryPoint, source, "utf8");
  return entryPoint;
}

function createSandboxConfig(pluginName: string, entryPoint: string, permissions: SandboxConfig["permissions"]): SandboxConfig {
  return {
    pluginName,
    entryPoint,
    permissions,
    limits: {
      ...DEFAULT_RESOURCE_LIMITS,
      maxMemoryMB: 24,
      maxCpuTimeMs: 1_000,
      maxEventHandlerMs: 120,
    },
    timeout: 500,
  };
}

describe("security/plugin-sandbox", () => {
  it("rejects plugins that attempt to access process.env", async () => {
    const entryPoint = await createTempPlugin(
      "reads-env",
      `
export default async function setupPlugin(context) {
  context.log.info(process.env.OPENAI_API_KEY ?? "missing");
}
`,
    );

    const sandbox = new PluginSandbox(createSandboxConfig("reads-env", entryPoint, []));
    sandboxCleanup.push(() => sandbox.stop());

    await expect(sandbox.start()).rejects.toThrow("cannot access process.env");
  });

  it("rejects plugins without file_access permission when importing filesystem modules", async () => {
    const entryPoint = await createTempPlugin(
      "reads-file",
      `
import { readFile } from "node:fs/promises";

export default async function setupPlugin(context) {
  context.on("message", async () => {
    await readFile("/tmp/secret.txt", "utf8");
  });
}
`,
    );

    const sandbox = new PluginSandbox(createSandboxConfig("reads-file", entryPoint, ["read_notes"]));
    sandboxCleanup.push(() => sandbox.stop());

    await expect(sandbox.start()).rejects.toThrow("requires file_access permission");
  });

  it("rejects plugins without network_access permission when performing network calls", async () => {
    const entryPoint = await createTempPlugin(
      "network-call",
      `
export default async function setupPlugin(context) {
  context.on("message", async () => {
    await fetch("https://example.com");
  });
}
`,
    );

    const sandbox = new PluginSandbox(createSandboxConfig("network-call", entryPoint, ["read_notes"]));
    sandboxCleanup.push(() => sandbox.stop());

    await expect(sandbox.start()).rejects.toThrow("requires network_access permission");
  });

  it("enforces memory and timeout limits for misbehaving plugins", async () => {
    const memoryEntryPoint = await createTempPlugin(
      "memory-bomb",
      `
export default async function setupPlugin(context) {
  context.on("message", async () => {
    const chunks = [];
    while (true) {
      chunks.push(new Uint8Array(10_000_000));
    }
  });
}
`,
    );

    const memorySandbox = new PluginSandbox(
      createSandboxConfig("memory-bomb", memoryEntryPoint, ["read_notes"]),
    );
    sandboxCleanup.push(() => memorySandbox.stop());

    await memorySandbox.start();
    await expect(memorySandbox.sendEvent("message", { trigger: true })).rejects.toThrow();
    expect(memorySandbox.isRunning()).toBe(false);

    const timeoutEntryPoint = await createTempPlugin(
      "timeout-loop",
      `
export default async function setupPlugin(context) {
  context.on("message", async () => {
    const start = Date.now();
    while (Date.now() - start < 500) {
      // busy loop
    }
  });
}
`,
    );

    const timeoutSandbox = new PluginSandbox(
      createSandboxConfig("timeout-loop", timeoutEntryPoint, ["read_notes"]),
    );
    sandboxCleanup.push(() => timeoutSandbox.stop());

    await timeoutSandbox.start();
    await expect(timeoutSandbox.sendEvent("message", { trigger: true })).rejects.toThrow("timed out");
    expect(timeoutSandbox.isRunning()).toBe(false);
  });

  it("rejects malicious manifest entry point traversal and null bytes", () => {
    const traversalManifest = validateManifest({
      name: "bad-plugin",
      version: "1.0.0",
      description: "Bad",
      author: "attacker",
      permissions: [],
      entryPoint: "../escape.ts",
    });

    expect(traversalManifest.valid).toBe(false);
    if (!traversalManifest.valid) {
      expect(
        traversalManifest.errors.some((error) => error.includes("path traversal")),
      ).toBe(true);
    }

    const nullByteManifest = validateManifest({
      name: "bad-plugin-2",
      version: "1.0.0",
      description: "Bad",
      author: "attacker",
      permissions: [],
      entryPoint: "index.ts\u0000evil.js",
    });

    expect(nullByteManifest.valid).toBe(false);
    if (!nullByteManifest.valid) {
      expect(nullByteManifest.errors.some((error) => error.includes("null bytes"))).toBe(true);
    }
  });
});

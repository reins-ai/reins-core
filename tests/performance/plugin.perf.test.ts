import { describe, expect, it } from "bun:test";

import { validateManifest } from "../../src/plugins/manifest";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolCall, ToolContext } from "../../src/types";
import { benchmark, benchmarkAsync, formatBenchmark } from "../../src/utils";

const TOOL_CONTEXT: ToolContext = {
  conversationId: "conv-perf",
  userId: "user-perf",
};

function createManifest(index: number) {
  return {
    name: `plugin-${index}`,
    version: "1.0.0",
    description: `Plugin ${index}`,
    author: "Perf Test",
    permissions: ["read_notes"],
    entryPoint: "index.ts",
  };
}

function createTool(index: number): Tool {
  return {
    definition: {
      name: `perf.tool.${index}`,
      description: "performance test tool",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    async execute(): Promise<{ callId: string; name: string; result: unknown }> {
      return {
        callId: `call-${index}`,
        name: `perf.tool.${index}`,
        result: { ok: true },
      };
    },
  };
}

describe("performance: plugin", () => {
  it("measures plugin manifest validation throughput", () => {
    const manifests = Array.from({ length: 100 }, (_, index) => createManifest(index));

    const result = benchmark(
      "plugin manifest validation (100 manifests)",
      () => {
        for (const manifest of manifests) {
          const validation = validateManifest(manifest);
          expect(validation.valid).toBe(true);
        }
      },
      50,
    );

    console.info(formatBenchmark(result));
    expect(result.averageMs).toBeLessThan(20);
  });

  it("measures tool registration throughput", () => {
    const tools = Array.from({ length: 100 }, (_, index) => createTool(index));

    const result = benchmark(
      "plugin tool registration (100 tools)",
      () => {
        const registry = new ToolRegistry();
        for (const tool of tools) {
          registry.register(tool);
        }

        expect(registry.list()).toHaveLength(100);
      },
      50,
    );

    console.info(formatBenchmark(result));
    expect(result.averageMs).toBeLessThan(20);
  });

  it("measures mock tool execution throughput", async () => {
    const registry = new ToolRegistry();
    const toolCount = 20;

    for (let index = 0; index < toolCount; index += 1) {
      registry.register(createTool(index));
    }

    const toolCalls: ToolCall[] = Array.from({ length: 200 }, (_, index) => ({
      id: `call-${index}`,
      name: `perf.tool.${index % toolCount}`,
      arguments: {},
    }));

    const executor = new ToolExecutor(registry);

    const result = await benchmarkAsync(
      "plugin tool execution throughput (200 calls)",
      async () => {
        const executionResults = await executor.executeMany(toolCalls, TOOL_CONTEXT);
        expect(executionResults).toHaveLength(toolCalls.length);
      },
      20,
    );

    console.info(formatBenchmark(result));
    expect(result.averageMs).toBeLessThan(50);
  });
});

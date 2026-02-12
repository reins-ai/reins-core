import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { ConversationManager, InMemoryConversationStore } from "../../src/conversation";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import { MockProvider } from "../../src/providers/mock";
import type { Tool, ToolCall, ToolContext, ToolResult } from "../../src/types";
import { BashTool } from "../../src/tools/system/bash";
import { ReadTool } from "../../src/tools/system/read";
import { GlobTool } from "../../src/tools/system/glob";
import { GrepTool } from "../../src/tools/system/grep";
import { LsTool } from "../../src/tools/system/ls";
import { getBuiltinSystemToolDefinitions } from "../../src/tools/builtins";
import type { SystemToolResult } from "../../src/tools/system/types";
import { SYSTEM_TOOL_ERROR_CODES } from "../../src/tools/system/types";

const toolContext: ToolContext = {
  conversationId: "pending",
  userId: "user-1",
  workspaceId: "ws-1",
};

const getWeatherCall: ToolCall = {
  id: "call-weather-1",
  name: "get_weather",
  arguments: { location: "San Francisco" },
};

const getWeatherTool: Tool = {
  definition: {
    name: "get_weather",
    description: "Get weather forecast for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string" },
      },
      required: ["location"],
    },
  },
  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const location = typeof args.location === "string" ? args.location : "unknown";
    return {
      callId: "ignored",
      name: "internal",
      result: {
        location,
        forecast: "Sunny",
        temperatureF: 72,
      },
    };
  },
};

describe("integration/tool-execution", () => {
  it("executes provider-requested tool calls within a conversation", async () => {
    const firstProvider = new MockProvider({
      responseContent: "I'll check the weather now.",
      toolCalls: [getWeatherCall],
      finishReason: "tool_use",
    });
    const secondProvider = new MockProvider({
      responseContent: "It's sunny and 72F in San Francisco.",
      finishReason: "stop",
    });

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(getWeatherTool);
    const executor = new ToolExecutor(toolRegistry);

    const manager = new ConversationManager(new InMemoryConversationStore());
    const conversation = await manager.create({
      title: "Weather",
      model: "mock-model-1",
      provider: "mock-provider",
    });

    await manager.addMessage(conversation.id, {
      role: "user",
      content: "What's the weather?",
    });

    const firstTurnMessages = await manager.getHistory(conversation.id);
    const firstResponse = await firstProvider.chat({
      model: "mock-model-1",
      messages: firstTurnMessages,
      tools: toolRegistry.getDefinitions(),
    });

    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: firstResponse.content,
      toolCalls: firstResponse.toolCalls,
    });

    const executionContext: ToolContext = {
      ...toolContext,
      conversationId: conversation.id,
    };
    const toolResult = await executor.execute(getWeatherCall, executionContext);

    await manager.addMessage(conversation.id, {
      role: "tool",
      content: JSON.stringify(toolResult.result),
      toolResultId: toolResult.callId,
    });

    const secondTurnMessages = await manager.getHistory(conversation.id);
    const secondResponse = await secondProvider.chat({
      model: "mock-model-1",
      messages: secondTurnMessages,
    });

    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: secondResponse.content,
    });

    const finalHistory = await manager.getHistory(conversation.id);
    expect(finalHistory.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(finalHistory[1]?.toolCalls?.[0]?.name).toBe("get_weather");
    expect(finalHistory[2]?.toolResultId).toBe(getWeatherCall.id);
    expect(finalHistory[3]?.content).toContain("72F");
  });

  it("runs tool calls in parallel and captures missing-tool failures", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(getWeatherTool);
    const executor = new ToolExecutor(toolRegistry);

    const results = await executor.executeMany(
      [
        {
          id: "call-1",
          name: "get_weather",
          arguments: { location: "San Francisco" },
        },
        {
          id: "call-2",
          name: "missing_tool",
          arguments: {},
        },
      ],
      {
        ...toolContext,
        conversationId: "conv-1",
      },
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.result).toEqual({
      location: "San Francisco",
      forecast: "Sunny",
      temperatureF: 72,
    });
    expect(results[1]?.result).toBeNull();
    expect(results[1]?.error).toBe("Tool not found: missing_tool");
  });
});

function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), "reins-integration-"));
}

function cleanupSandbox(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

const EXPECTED_SYSTEM_TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "ls",
];

describe("System Tool Suite Integration", () => {
  it("all 7 system tools have definitions in builtins", () => {
    const definitions = getBuiltinSystemToolDefinitions();
    const names = definitions.map((d) => d.name).sort();

    expect(names).toEqual([...EXPECTED_SYSTEM_TOOL_NAMES].sort());
    expect(definitions).toHaveLength(7);
  });

  it("all system tool definitions have valid input_schema", () => {
    const definitions = getBuiltinSystemToolDefinitions();

    for (const def of definitions) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.input_schema).toBeDefined();
      expect(def.input_schema.type).toBe("object");
      expect(def.input_schema.properties).toBeDefined();
    }
  });

  it("Tool-interface tools register in ToolRegistry without conflict", () => {
    const sandbox = makeSandbox();
    try {
      const registry = new ToolRegistry();

      const tools: Tool[] = [
        new BashTool(sandbox),
        new ReadTool(sandbox),
        new LsTool(sandbox),
      ];

      for (const tool of tools) {
        registry.register(tool);
      }

      expect(registry.has("bash")).toBe(true);
      expect(registry.has("read")).toBe(true);
      expect(registry.has("ls")).toBe(true);
      expect(registry.list()).toHaveLength(3);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it("all 7 system tools are instantiable with a sandbox root", () => {
    const sandbox = makeSandbox();
    try {
      const bashTool = new BashTool(sandbox);
      const readTool = new ReadTool(sandbox);
      const globTool = new GlobTool(sandbox);
      const grepTool = new GrepTool(sandbox);
      const lsTool = new LsTool(sandbox);

      expect(bashTool.definition.name).toBe("bash");
      expect(readTool.definition.name).toBe("read");
      expect(globTool.definition.name).toBe("glob");
      expect(grepTool.definition.name).toBe("grep");
      expect(lsTool.definition.name).toBe("ls");

      // write and edit are function-based, verified via builtins definitions
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it("all tools return SystemToolResult envelope on success", async () => {
    const sandbox = makeSandbox();
    try {
      writeFileSync(join(sandbox, "test.txt"), "hello world\nsecond line");
      mkdirSync(join(sandbox, "subdir"));

      const ctx: ToolContext = { conversationId: "int-test", userId: "u1" };

      const bashTool = new BashTool(sandbox);
      const bashResult = await bashTool.execute({ command: "echo hi" }, ctx);
      assertSystemToolResult(bashResult.result);

      const readTool = new ReadTool(sandbox);
      const readResult = await readTool.execute({ path: "test.txt" }, ctx);
      assertSystemToolResult(readResult.result);

      const lsTool = new LsTool(sandbox);
      const lsResult = await lsTool.execute({}, ctx);
      assertSystemToolResult(lsResult.result);

      const globTool = new GlobTool(sandbox);
      const globResult = await globTool.execute({ pattern: "**/*.txt" });
      assertSystemToolResult(globResult);

      const grepTool = new GrepTool(sandbox);
      const grepResult = await grepTool.execute({ pattern: "hello" });
      assertSystemToolResult(grepResult);
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it("all tools enforce sandbox boundaries with TOOL_PERMISSION_DENIED", async () => {
    const sandbox = makeSandbox();
    try {
      const ctx: ToolContext = { conversationId: "int-test", userId: "u1" };
      const outsidePath = "/etc/passwd";

      const readTool = new ReadTool(sandbox);
      await expectPermissionDenied(() => readTool.execute({ path: outsidePath }, ctx));

      const lsTool = new LsTool(sandbox);
      await expectPermissionDenied(() => lsTool.execute({ path: "/etc" }, ctx));

      const globTool = new GlobTool(sandbox);
      await expectPermissionDenied(() => globTool.execute({ pattern: "*.txt", path: "/etc" }));

      const grepTool = new GrepTool(sandbox);
      await expectPermissionDenied(() => grepTool.execute({ pattern: "test", path: "/etc" }));
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it("all tools use structured error codes from SYSTEM_TOOL_ERROR_CODES", async () => {
    const sandbox = makeSandbox();
    try {
      const ctx: ToolContext = { conversationId: "int-test", userId: "u1" };
      const validCodes = new Set(Object.values(SYSTEM_TOOL_ERROR_CODES));

      const readTool = new ReadTool(sandbox);
      try {
        await readTool.execute({ path: "nonexistent.txt" }, ctx);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const toolError = error as { code: string };
        expect(validCodes.has(toolError.code as never)).toBe(true);
      }

      const lsTool = new LsTool(sandbox);
      try {
        await lsTool.execute({ path: "nonexistent-dir" }, ctx);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const toolError = error as { code: string };
        expect(validCodes.has(toolError.code as never)).toBe(true);
      }

      const bashTool = new BashTool(sandbox);
      try {
        await bashTool.execute({ command: "rm -rf /" }, ctx);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const toolError = error as { code: string };
        expect(validCodes.has(toolError.code as never)).toBe(true);
      }
    } finally {
      cleanupSandbox(sandbox);
    }
  });

  it("result envelope metadata is consistent across tools", async () => {
    const sandbox = makeSandbox();
    try {
      writeFileSync(join(sandbox, "data.txt"), "content");
      mkdirSync(join(sandbox, "dir"));

      const ctx: ToolContext = { conversationId: "int-test", userId: "u1" };

      const readTool = new ReadTool(sandbox);
      const readResult = await readTool.execute({ path: "data.txt" }, ctx);
      const readMeta = (readResult.result as SystemToolResult).metadata;
      expect(typeof readMeta.truncated).toBe("boolean");
      expect(typeof readMeta.lineCount).toBe("number");
      expect(typeof readMeta.byteCount).toBe("number");

      const lsTool = new LsTool(sandbox);
      const lsResult = await lsTool.execute({}, ctx);
      const lsMeta = (lsResult.result as SystemToolResult).metadata;
      expect(typeof lsMeta.truncated).toBe("boolean");
      expect(typeof lsMeta.lineCount).toBe("number");
      expect(typeof lsMeta.byteCount).toBe("number");

      const bashTool = new BashTool(sandbox);
      const bashResult = await bashTool.execute({ command: "echo test" }, ctx);
      const bashMeta = (bashResult.result as SystemToolResult).metadata;
      expect(typeof bashMeta.truncated).toBe("boolean");
      expect(typeof bashMeta.lineCount).toBe("number");
      expect(typeof bashMeta.byteCount).toBe("number");

      const globTool = new GlobTool(sandbox);
      const globResult = await globTool.execute({ pattern: "**/*" });
      expect(typeof globResult.metadata.truncated).toBe("boolean");
      expect(typeof globResult.metadata.lineCount).toBe("number");
      expect(typeof globResult.metadata.byteCount).toBe("number");
    } finally {
      cleanupSandbox(sandbox);
    }
  });
});

function assertSystemToolResult(value: unknown): void {
  const result = value as SystemToolResult;
  expect(result).toBeDefined();
  expect(typeof result.title).toBe("string");
  expect(typeof result.output).toBe("string");
  expect(result.metadata).toBeDefined();
  expect(typeof result.metadata.truncated).toBe("boolean");
  expect(typeof result.metadata.lineCount).toBe("number");
  expect(typeof result.metadata.byteCount).toBe("number");
}

async function expectPermissionDenied(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    expect(true).toBe(false);
  } catch (error: unknown) {
    const toolError = error as { code: string };
    expect(toolError.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
  }
}

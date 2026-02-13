import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "bun:test";

import { ToolExecutor, ToolRegistry } from "../../src/tools";
import { BashTool } from "../../src/tools/system";
import { SYSTEM_TOOL_ERROR_CODES, type SystemToolResult } from "../../src/tools/system/types";
import type { ToolContext, ToolResult } from "../../src/types";

const context: ToolContext = {
  conversationId: "conv-bash",
  userId: "user-bash",
};

function createSandboxRoot(): string {
  return mkdtempSync(join(tmpdir(), "reins-bash-tool-"));
}

async function executeBash(
  sandboxRoot: string,
  args: Record<string, unknown>,
  overrideContext?: ToolContext,
): Promise<ToolResult> {
  const registry = new ToolRegistry();
  registry.register(new BashTool(sandboxRoot));
  const executor = new ToolExecutor(registry);

  return executor.execute(
    {
      id: "call-bash",
      name: "bash",
      arguments: args,
    },
    overrideContext ?? context,
  );
}

function expectSuccess(result: ToolResult): SystemToolResult {
  expect(result.error).toBeUndefined();
  expect(result.errorDetail).toBeUndefined();
  expect(result.result).toBeDefined();

  return result.result as SystemToolResult;
}

describe("BashTool", () => {
  it("executes safe commands and captures stdout", async () => {
    const sandboxRoot = createSandboxRoot();

    try {
      const result = await executeBash(sandboxRoot, {
        command: "echo test-output",
      });
      const payload = expectSuccess(result);

      expect(payload.output).toContain("test-output");
      expect(payload.metadata.truncated).toBe(false);
      expect(payload.metadata.lineCount).toBeGreaterThan(0);
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("captures stderr on successful execution", async () => {
    const sandboxRoot = createSandboxRoot();

    try {
      const result = await executeBash(sandboxRoot, {
        command: "printf 'stdout'; printf 'stderr' 1>&2",
      });
      const payload = expectSuccess(result);

      expect(payload.output).toContain("stdout");
      expect(payload.output).toContain("stderr");
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("uses custom workdir when provided", async () => {
    const sandboxRoot = createSandboxRoot();

    try {
      mkdirSync(join(sandboxRoot, "nested"), { recursive: true });

      const result = await executeBash(sandboxRoot, {
        command: "pwd",
        workdir: "nested",
      });
      const payload = expectSuccess(result);

      expect(payload.output.trim()).toBe(resolve(sandboxRoot, "nested"));
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("applies truncation for large outputs", async () => {
    const sandboxRoot = createSandboxRoot();

    try {
      const result = await executeBash(sandboxRoot, {
        command:
          "i=1; while [ $i -le 3000 ]; do printf 'line-%s\\n' \"$i\"; i=$((i+1)); done",
      });
      const payload = expectSuccess(result);

      expect(payload.metadata.truncated).toBe(true);
      expect(payload.metadata.lineCount).toBeGreaterThan(2000);
      expect(payload.output.length).toBeGreaterThan(0);
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("rejects banned commands with TOOL_PERMISSION_DENIED", async () => {
    const sandboxRoot = createSandboxRoot();

    try {
      const result = await executeBash(sandboxRoot, {
        command: "sudo rm -rf /",
      });

      expect(result.result).toBeNull();
      expect(result.errorDetail?.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
      expect(result.errorDetail?.retryable).toBe(false);
      expect(result.errorDetail?.details?.["reason"]).toBe("banned_command");
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("enforces timeout and returns TOOL_TIMEOUT", async () => {
    const sandboxRoot = createSandboxRoot();

    try {
      const result = await executeBash(sandboxRoot, {
        command: "sleep 1",
        timeout: 20,
      });

      expect(result.result).toBeNull();
      expect(result.errorDetail?.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_TIMEOUT);
      expect(result.errorDetail?.retryable).toBe(true);
      expect(result.errorDetail?.details?.["timeoutMs"]).toBe(20);
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("rejects workdir outside sandbox", async () => {
    const sandboxRoot = createSandboxRoot();

    try {
      const result = await executeBash(sandboxRoot, {
        command: "pwd",
        workdir: "../outside",
      });

      expect(result.result).toBeNull();
      expect(result.errorDetail?.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
      expect(result.errorDetail?.details?.["reason"]).toBe("path_outside_sandbox");
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("returns TOOL_EXECUTION_FAILED for non-zero exits", async () => {
    const sandboxRoot = createSandboxRoot();

    try {
      const result = await executeBash(sandboxRoot, {
        command: "exit 7",
      });

      expect(result.result).toBeNull();
      expect(result.errorDetail?.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED);
      expect(result.errorDetail?.retryable).toBe(false);
      expect(result.errorDetail?.details?.["exitCode"]).toBe(7);
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("handles empty output", async () => {
    const sandboxRoot = createSandboxRoot();

    try {
      const result = await executeBash(sandboxRoot, {
        command: ":",
      });
      const payload = expectSuccess(result);

      expect(payload.output).toBe("");
      expect(payload.metadata.lineCount).toBe(0);
      expect(payload.metadata.byteCount).toBe(0);
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("handles commands with special characters", async () => {
    const sandboxRoot = createSandboxRoot();

    try {
      const result = await executeBash(sandboxRoot, {
        command: "printf '%s' '@#$%^&*()[]{}|;:,<.>/?'",
      });
      const payload = expectSuccess(result);

      expect(payload.output).toBe("@#$%^&*()[]{}|;:,<.>/?");
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("handles multi-line output", async () => {
    const sandboxRoot = createSandboxRoot();

    try {
      const result = await executeBash(sandboxRoot, {
        command: "printf 'line-1\\nline-2\\nline-3\\n'",
      });
      const payload = expectSuccess(result);

      expect(payload.output).toContain("line-1\nline-2\nline-3");
      expect(payload.metadata.lineCount).toBe(4);
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("aborts a running command and returns partial output", async () => {
    const sandboxRoot = createSandboxRoot();

    try {
      const controller = new AbortController();
      const runPromise = executeBash(
        sandboxRoot,
        {
          command: "i=1; while [ $i -le 100 ]; do printf 'line-%s\\n' \"$i\"; sleep 0.02; i=$((i+1)); done",
          timeout: 5_000,
        },
        {
          ...context,
          abortSignal: controller.signal,
        },
      );

      await Bun.sleep(120);
      controller.abort("ctrl-c");

      const result = await runPromise;
      expect(result.error).toBe("Tool execution aborted");

      const payload = result.result as SystemToolResult;
      expect(payload.metadata["aborted"]).toBe(true);
      expect(payload.output.length).toBeGreaterThan(0);
      expect(payload.output).toContain("line-");
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });
});

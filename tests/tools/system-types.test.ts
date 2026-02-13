import { describe, expect, it } from "bun:test";

import {
  SYSTEM_TOOL_ERROR_CODES,
  type SystemToolDefinition,
  SystemToolExecutionError,
  isSystemToolDefinition,
  toSystemToolError,
  toSystemToolErrorDetail,
} from "../../src/tools/system/types";

describe("system tool type contracts", () => {
  it("supports Anthropic-style tool definition shape", () => {
    const definition: SystemToolDefinition = {
      name: "read",
      description: "Read file contents from the workspace.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to read" },
        },
        required: ["path"],
      },
    };

    expect(isSystemToolDefinition(definition)).toBe(true);
  });

  it("rejects invalid definitions that do not include input_schema", () => {
    const result = isSystemToolDefinition({
      name: "read",
      description: "Read file contents",
      parameters: { type: "object", properties: {} },
    });

    expect(result).toBe(false);
  });

  it("normalizes unknown values to a default system tool error", () => {
    const normalized = toSystemToolError({ unexpected: true });

    expect(normalized.code).toBe("TOOL_EXECUTION_FAILED");
    expect(normalized.message).toBe("Tool execution failed");
    expect(normalized.retryable).toBe(false);
  });

  it("preserves structured SystemToolExecutionError metadata", () => {
    const original = SystemToolExecutionError.timeout(1500);
    const normalized = toSystemToolError(original);

    expect(normalized).toBe(original);
    expect(normalized.code).toBe("TOOL_TIMEOUT");
    expect(normalized.retryable).toBe(true);
    expect(normalized.details?.["timeoutMs"]).toBe(1500);
  });

  it("maps known coded errors into SystemToolExecutionError", () => {
    const source = new Error("Denied") as Error & { code: string };
    source.code = SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED;

    const normalized = toSystemToolError(source);

    expect(normalized.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
    expect(normalized.message).toBe("Denied");
    expect(normalized.retryable).toBe(false);
  });

  it("creates and serializes details for validation errors", () => {
    const error = SystemToolExecutionError.validation("Invalid args", {
      field: "path",
      reason: "required",
    });

    const detail = toSystemToolErrorDetail(error);
    expect(detail).toEqual({
      code: SYSTEM_TOOL_ERROR_CODES.TOOL_VALIDATION_FAILED,
      message: "Invalid args",
      retryable: false,
      details: {
        field: "path",
        reason: "required",
      },
    });
  });

  it("supports explicit execution failure options", () => {
    const error = SystemToolExecutionError.failed("Execution failed", {
      retryable: true,
      details: { command: "bash" },
    });

    expect(error.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED);
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ command: "bash" });
  });
});

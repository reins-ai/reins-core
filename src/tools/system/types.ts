import { ReinsError } from "../../errors";
import type { JsonSchema } from "../../types";

export type SystemToolArgs = Record<string, unknown>;

export interface SystemToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface ToolMetadata {
  truncated: boolean;
  lineCount: number;
  byteCount: number;
  [key: string]: unknown;
}

export interface SystemToolAttachment {
  type: string;
  text?: string;
  mimeType?: string;
  path?: string;
  [key: string]: unknown;
}

export interface SystemToolResult {
  title: string;
  metadata: ToolMetadata;
  output: string;
  attachments?: SystemToolAttachment[];
}

export const SYSTEM_TOOL_ERROR_CODES = {
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  TOOL_TIMEOUT: "TOOL_TIMEOUT",
  TOOL_VALIDATION_FAILED: "TOOL_VALIDATION_FAILED",
  TOOL_PERMISSION_DENIED: "TOOL_PERMISSION_DENIED",
  TOOL_EXECUTION_FAILED: "TOOL_EXECUTION_FAILED",
} as const;

export type SystemToolErrorCode =
  (typeof SYSTEM_TOOL_ERROR_CODES)[keyof typeof SYSTEM_TOOL_ERROR_CODES];

export interface SystemToolErrorDetail {
  code: SystemToolErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class SystemToolExecutionError extends ReinsError {
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: SystemToolErrorCode,
    message: string,
    options?: {
      cause?: Error;
      retryable?: boolean;
      details?: Record<string, unknown>;
    },
  ) {
    super(message, code, options?.cause);
    this.name = "SystemToolExecutionError";
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }

  static toolNotFound(toolName: string): SystemToolExecutionError {
    return new SystemToolExecutionError(
      SYSTEM_TOOL_ERROR_CODES.TOOL_NOT_FOUND,
      `Tool not found: ${toolName}`,
    );
  }

  static timeout(timeoutMs: number): SystemToolExecutionError {
    return new SystemToolExecutionError(
      SYSTEM_TOOL_ERROR_CODES.TOOL_TIMEOUT,
      `Tool execution timed out after ${timeoutMs}ms`,
      {
        retryable: true,
        details: { timeoutMs },
      },
    );
  }

  static validation(message: string, details?: Record<string, unknown>): SystemToolExecutionError {
    return new SystemToolExecutionError(
      SYSTEM_TOOL_ERROR_CODES.TOOL_VALIDATION_FAILED,
      message,
      {
        details,
      },
    );
  }

  static permissionDenied(
    message: string,
    details?: Record<string, unknown>,
  ): SystemToolExecutionError {
    return new SystemToolExecutionError(
      SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED,
      message,
      {
        details,
      },
    );
  }

  static failed(
    message: string,
    options?: {
      cause?: Error;
      retryable?: boolean;
      details?: Record<string, unknown>;
    },
  ): SystemToolExecutionError {
    return new SystemToolExecutionError(SYSTEM_TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED, message, {
      cause: options?.cause,
      retryable: options?.retryable,
      details: options?.details,
    });
  }
}

export function isSystemToolDefinition(value: unknown): value is SystemToolDefinition {
  if (!isRecord(value)) {
    return false;
  }

  const name = value["name"];
  const description = value["description"];
  const schema = value["input_schema"];

  return typeof name === "string" && name.length > 0 && typeof description === "string" &&
    description.length > 0 && isJsonSchema(schema);
}

export function toSystemToolError(
  value: unknown,
  fallbackCode: SystemToolErrorCode = SYSTEM_TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED,
): SystemToolExecutionError {
  if (value instanceof SystemToolExecutionError) {
    return value;
  }

  if (isSystemToolErrorLike(value)) {
    return new SystemToolExecutionError(value.code, value.message, {
      retryable: value.retryable,
      details: value.details,
    });
  }

  if (isErrorWithKnownCode(value)) {
    return new SystemToolExecutionError(value.code, value.message, {
      cause: value,
      retryable: value.code === SYSTEM_TOOL_ERROR_CODES.TOOL_TIMEOUT,
    });
  }

  if (value instanceof Error && value.message.length > 0) {
    return new SystemToolExecutionError(fallbackCode, value.message, {
      cause: value,
      retryable: fallbackCode === SYSTEM_TOOL_ERROR_CODES.TOOL_TIMEOUT,
    });
  }

  if (typeof value === "string" && value.length > 0) {
    return new SystemToolExecutionError(fallbackCode, value, {
      retryable: fallbackCode === SYSTEM_TOOL_ERROR_CODES.TOOL_TIMEOUT,
    });
  }

  return new SystemToolExecutionError(fallbackCode, "Tool execution failed", {
    retryable: fallbackCode === SYSTEM_TOOL_ERROR_CODES.TOOL_TIMEOUT,
  });
}

export function toSystemToolErrorDetail(value: unknown): SystemToolErrorDetail {
  const normalized = toSystemToolError(value);

  return {
    code: normalized.code as SystemToolErrorCode,
    message: normalized.message,
    retryable: normalized.retryable,
    details: normalized.details,
  };
}

function isErrorWithKnownCode(value: unknown): value is Error & { code: SystemToolErrorCode } {
  if (!(value instanceof Error)) {
    return false;
  }

  return isSystemToolErrorCode((value as { code?: unknown }).code);
}

function isSystemToolErrorLike(value: unknown): value is SystemToolErrorDetail {
  if (!isRecord(value)) {
    return false;
  }

  if (!isSystemToolErrorCode(value["code"])) {
    return false;
  }

  return (
    typeof value["message"] === "string" &&
    typeof value["retryable"] === "boolean" &&
    (value["details"] === undefined || isRecord(value["details"]))
  );
}

function isSystemToolErrorCode(value: unknown): value is SystemToolErrorCode {
  return typeof value === "string" &&
    Object.values(SYSTEM_TOOL_ERROR_CODES).includes(value as SystemToolErrorCode);
}

function isJsonSchema(value: unknown): value is JsonSchema {
  if (!isRecord(value)) {
    return false;
  }

  if (value["type"] !== "object") {
    return false;
  }

  return isRecord(value["properties"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

import { ToolError } from "../errors";
import type { ToolCall, ToolResult } from "../types";

export interface SerializedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface SerializedToolResult {
  callId: string;
  name: string;
  resultJson: string;
  error?: string;
  errorDetailJson?: string;
}

export function serializeToolCall(toolCall: ToolCall): SerializedToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    argumentsJson: safeStringify(toolCall.arguments, `tool call arguments for ${toolCall.name}`),
  };
}

export function deserializeToolCall(serialized: SerializedToolCall): ToolCall {
  return {
    id: serialized.id,
    name: serialized.name,
    arguments: parseRecord(serialized.argumentsJson, `tool call arguments for ${serialized.name}`),
  };
}

export function serializeToolResult(toolResult: ToolResult): SerializedToolResult {
  return {
    callId: toolResult.callId,
    name: toolResult.name,
    resultJson: safeStringify(toolResult.result, `tool result for ${toolResult.name}`),
    error: toolResult.error,
    errorDetailJson:
      toolResult.errorDetail === undefined
        ? undefined
        : safeStringify(toolResult.errorDetail, `tool error detail for ${toolResult.name}`),
  };
}

export function deserializeToolResult(serialized: SerializedToolResult): ToolResult {
  return {
    callId: serialized.callId,
    name: serialized.name,
    result: safeParse(serialized.resultJson, `tool result for ${serialized.name}`),
    error: serialized.error,
    errorDetail:
      serialized.errorDetailJson === undefined
        ? undefined
        : parseErrorDetail(serialized.errorDetailJson, `tool error detail for ${serialized.name}`),
  };
}

function parseErrorDetail(value: string, label: string): ToolResult["errorDetail"] {
  const parsed = safeParse(value, label);

  if (!isPlainRecord(parsed)) {
    throw new ToolError(`Invalid serialized object for ${label}`);
  }

  const message = parsed["message"];
  const code = parsed["code"];
  const retryable = parsed["retryable"];
  const details = parsed["details"];

  if (typeof message !== "string" || typeof code !== "string" || typeof retryable !== "boolean") {
    throw new ToolError(`Invalid serialized object for ${label}`);
  }

  if (details !== undefined && !isPlainRecord(details)) {
    throw new ToolError(`Invalid serialized object for ${label}`);
  }

  return {
    code,
    message,
    retryable,
    details,
  };
}

function safeStringify(value: unknown, label: string): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new ToolError(`Failed to serialize ${label}`, asError(error));
  }
}

function safeParse(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ToolError(`Failed to deserialize ${label}`, asError(error));
  }
}

function parseRecord(value: string, label: string): Record<string, unknown> {
  const parsed = safeParse(value, label);

  if (!isPlainRecord(parsed)) {
    throw new ToolError(`Invalid serialized object for ${label}`);
  }

  return parsed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (Array.isArray(value)) {
    return false;
  }

  return true;
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

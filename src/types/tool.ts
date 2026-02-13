export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  result: unknown;
  error?: string;
  errorDetail?: ToolErrorDetail;
}

export interface ToolErrorDetail {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  conversationId: string;
  userId: string;
  workspaceId?: string;
  abortSignal?: AbortSignal;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
}

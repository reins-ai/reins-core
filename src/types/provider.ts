import type { Message } from "./conversation";
import type { StreamEvent } from "./streaming";
import type { ToolCall, ToolDefinition } from "./tool";

export interface ProviderConfig {
  id: string;
  name: string;
  type: "gateway" | "byok" | "oauth" | "local";
  baseUrl?: string;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens?: number;
  capabilities: ModelCapability[];
}

export type ModelCapability = "chat" | "streaming" | "tool_use" | "vision" | "audio";

export interface Provider {
  readonly config: ProviderConfig;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
  listModels(): Promise<Model[]>;
  validateConnection(): Promise<boolean>;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  finishReason: "stop" | "tool_use" | "length" | "error";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

import type { Message } from "./conversation";
import type { StreamEvent } from "./streaming";
import type { ToolCall, ToolDefinition } from "./tool";

export type ProviderType = "gateway" | "byok" | "oauth" | "local";

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl?: string;
  capabilities?: ProviderCapabilities;
}

export type ProviderAuthMode = "api_key" | "oauth";

export interface ProviderCapabilities {
  authModes: ProviderAuthMode[];
  requiresAuth: boolean;
  userConfigurable?: boolean;
  envVars?: string[];
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
  readonly capabilities?: ProviderCapabilities;
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

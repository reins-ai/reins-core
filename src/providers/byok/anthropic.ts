import { ProviderError } from "../../errors";
import { generateId } from "../../conversation/id";
import { getTextContent } from "../../types/conversation";
import { StreamTransformer } from "../../streaming";
import type { StreamEvent } from "../../types/streaming";
import type {
  ChatRequest,
  ChatResponse,
  Model,
  Provider,
  ProviderConfig,
  TokenUsage,
} from "../../types/provider";
import type { ToolCall } from "../../types/tool";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface BYOKAnthropicProviderOptions {
  baseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0;
  const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function parseToolCalls(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const calls: ToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") {
      continue;
    }

    const id = asString(block.id) ?? generateId("tool");
    const name = asString(block.name) ?? "unknown_tool";
    const input = isRecord(block.input) ? block.input : {};

    calls.push({
      id,
      name,
      arguments: input,
    });
  }

  return calls;
}

function parseTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text") {
      continue;
    }

    const text = asString(block.text);
    if (text) {
      textParts.push(text);
    }
  }

  return textParts.join("\n");
}

function mapFinishReason(value: unknown): ChatResponse["finishReason"] {
  if (value === "tool_use") {
    return "tool_use";
  }

  if (value === "max_tokens") {
    return "length";
  }

  return "stop";
}

function mapMessages(request: ChatRequest): AnthropicMessage[] {
  return request.messages
    .filter(
      (message): message is ChatRequest["messages"][number] & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role,
      content: getTextContent(message.content),
    }));
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";

const DEFAULT_MODELS: Model[] = [
  {
    id: "claude-3-5-sonnet-latest",
    name: "Claude 3.5 Sonnet",
    provider: "byok-anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: ["chat", "streaming", "tool_use", "vision"],
  },
  {
    id: "claude-3-5-haiku-latest",
    name: "Claude 3.5 Haiku",
    provider: "byok-anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: ["chat", "streaming", "tool_use", "vision"],
  },
];

export class BYOKAnthropicProvider implements Provider {
  public readonly config: ProviderConfig;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, options: BYOKAnthropicProviderOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.config = {
      id: "byok-anthropic",
      name: "Anthropic BYOK",
      type: "byok",
      baseUrl: this.baseUrl,
    };
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model,
        system: request.systemPrompt,
        messages: mapMessages(request),
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature,
      }),
    });

    if (!response.ok) {
      throw new ProviderError(`Anthropic chat request failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as unknown;
    if (!isRecord(payload)) {
      throw new ProviderError("Anthropic chat response payload is invalid");
    }

    const toolCalls = parseToolCalls(payload.content);

    return {
      id: asString(payload.id) ?? generateId("anthropic"),
      model: asString(payload.model) ?? request.model,
      content: parseTextContent(payload.content),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: parseUsage(payload.usage),
      finishReason: mapFinishReason(payload.stop_reason),
    };
  }

  public async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model,
        system: request.systemPrompt,
        messages: mapMessages(request),
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      throw new ProviderError(`Anthropic stream request failed (${response.status}): ${await response.text()}`);
    }

    for await (const event of StreamTransformer.fromSSE(response.body)) {
      yield event;
    }
  }

  public async listModels(): Promise<Model[]> {
    return DEFAULT_MODELS.map((model) => ({ ...model, provider: this.config.id }));
  }

  public async validateConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models?limit=1`, {
        method: "GET",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

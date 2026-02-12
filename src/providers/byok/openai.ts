import { ProviderError } from "../../errors";
import { generateId } from "../../conversation/id";
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

interface BYOKOpenAIProviderOptions {
  baseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mapFinishReason(value: unknown): ChatResponse["finishReason"] {
  if (value === "tool_calls") {
    return "tool_use";
  }

  if (value === "length") {
    return "length";
  }

  return "stop";
}

function parseUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const inputTokens = typeof value.prompt_tokens === "number" ? value.prompt_tokens : 0;
  const outputTokens = typeof value.completion_tokens === "number" ? value.completion_tokens : 0;
  const totalTokens = typeof value.total_tokens === "number" ? value.total_tokens : inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const calls: ToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.function)) {
      continue;
    }

    const id = asString(item.id) ?? generateId("tool");
    const name = asString(item.function.name) ?? "unknown_tool";
    const args = asString(item.function.arguments);

    let parsedArguments: Record<string, unknown> = {};
    if (args) {
      try {
        const parsed = JSON.parse(args) as unknown;
        if (isRecord(parsed)) {
          parsedArguments = parsed;
        }
      } catch {
        parsedArguments = {};
      }
    }

    calls.push({
      id,
      name,
      arguments: parsedArguments,
    });
  }

  return calls;
}

const DEFAULT_BASE_URL = "https://api.openai.com";

export class BYOKOpenAIProvider implements Provider {
  public readonly config: ProviderConfig;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, options: BYOKOpenAIProviderOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.config = {
      id: "byok-openai",
      name: "OpenAI BYOK",
      type: "byok",
      baseUrl: this.baseUrl,
    };
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        tools: request.tools,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
      }),
    });

    if (!response.ok) {
      throw new ProviderError(`OpenAI chat request failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
      throw new ProviderError("OpenAI chat response payload is invalid");
    }

    const choice = payload.choices[0];
    if (!isRecord(choice)) {
      throw new ProviderError("OpenAI chat response choice is invalid");
    }

    const message = isRecord(choice.message) ? choice.message : {};
    const toolCalls = parseToolCalls(message.tool_calls);

    return {
      id: asString(payload.id) ?? generateId("openai"),
      model: asString(payload.model) ?? request.model,
      content: asString(message.content) ?? "",
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: parseUsage(payload.usage),
      finishReason: mapFinishReason(choice.finish_reason),
    };
  }

  public async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        stream: true,
        tools: request.tools,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
      }),
    });

    if (!response.ok || !response.body) {
      throw new ProviderError(`OpenAI stream request failed (${response.status}): ${await response.text()}`);
    }

    for await (const event of StreamTransformer.fromSSE(response.body)) {
      yield event;
    }
  }

  public async listModels(): Promise<Model[]> {
    const response = await fetch(`${this.baseUrl}/v1/models`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new ProviderError(`OpenAI models request failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new ProviderError("OpenAI models response payload is invalid");
    }

    const models: Model[] = [];
    for (const item of payload.data) {
      if (!isRecord(item)) {
        continue;
      }

      const id = asString(item.id);
      if (!id) {
        continue;
      }

      models.push({
        id,
        name: id,
        provider: this.config.id,
        contextWindow: 128_000,
        capabilities: ["chat", "streaming", "tool_use"],
      });
    }

    return models;
  }

  public async validateConnection(): Promise<boolean> {
    try {
      const models = await this.listModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }
}

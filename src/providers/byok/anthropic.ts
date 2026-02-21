import { ProviderError } from "../../errors";
import { generateId } from "../../conversation/id";
import type { ContentBlock } from "../../types/conversation";
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
import { thinkingLevelToBudget } from "./thinking-utils";
import { createLogger } from "../../logger";

const log = createLogger("providers:anthropic");

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface BYOKAnthropicProviderOptions {
  baseUrl?: string;
}

interface AnthropicThinking {
  type: "enabled";
  budget_tokens: number;
}

function debugThinking(event: string, details: Record<string, unknown>): void {
  if (process.env.REINS_DEBUG_THINKING !== "1") {
    return;
  }

  log.debug(event, details);
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

function mapContentBlocks(blocks: ContentBlock[]): AnthropicContentBlock[] {
  return blocks.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text" as const, text: block.text };
      case "tool_use":
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input,
        };
      case "tool_result":
        return {
          type: "tool_result" as const,
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error ? { is_error: true } : {}),
        };
    }
  });
}

function mapMessages(request: ChatRequest): AnthropicMessage[] {
  return request.messages
    .filter(
      (message): message is ChatRequest["messages"][number] & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role,
      content: typeof message.content === "string"
        ? message.content
        : mapContentBlocks(message.content),
    }));
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
/** Fallback max_tokens when the caller does not specify one. */
const DEFAULT_MAX_TOKENS = 1024;
/**
 * Minimum max_tokens required when extended thinking is enabled.
 * Must be strictly greater than MIN_THINKING_BUDGET_TOKENS so the model
 * has at least one output token beyond the thinking budget.
 */
const MIN_THINKING_MAX_TOKENS = 1025;
/** Minimum budget_tokens accepted by the Anthropic thinking API. */
const MIN_THINKING_BUDGET_TOKENS = 1024;
const ANTHROPIC_THINKING_BETA = "interleaved-thinking-2025-05-14";

function resolveMaxTokens(request: ChatRequest): number {
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (request.thinkingLevel && request.thinkingLevel !== "none" && maxTokens <= MIN_THINKING_BUDGET_TOKENS) {
    return MIN_THINKING_MAX_TOKENS;
  }

  return maxTokens;
}

function resolveThinking(request: ChatRequest, maxTokens: number): AnthropicThinking | undefined {
  const thinkingLevel = request.thinkingLevel;
  if (!thinkingLevel || thinkingLevel === "none") {
    return undefined;
  }

  const budgetTokens = thinkingLevelToBudget(thinkingLevel, maxTokens);
  if (
    budgetTokens === undefined
    || budgetTokens < MIN_THINKING_BUDGET_TOKENS
    || budgetTokens >= maxTokens
  ) {
    debugThinking("resolveThinking.invalid", {
      model: request.model,
      thinkingLevel,
      maxTokens,
      budgetTokens,
    });
    return undefined;
  }

  debugThinking("resolveThinking", {
    model: request.model,
    thinkingLevel,
    maxTokens,
    budgetTokens,
  });

  return {
    type: "enabled",
    budget_tokens: budgetTokens,
  };
}

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
    const maxTokens = resolveMaxTokens(request);
    const thinking = resolveThinking(request, maxTokens);
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(thinking ? { "anthropic-beta": ANTHROPIC_THINKING_BETA } : {}),
    };
    const body = {
      model: request.model,
      system: request.systemPrompt,
      messages: mapMessages(request),
      max_tokens: maxTokens,
      temperature: request.temperature,
      ...(thinking ? { thinking } : {}),
    };

    debugThinking("chat.request", {
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      maxTokens,
      thinking,
      headers: {
        "anthropic-version": headers["anthropic-version"],
        "anthropic-beta": headers["anthropic-beta"],
      },
      body,
    });

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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
    const maxTokens = resolveMaxTokens(request);
    const thinking = resolveThinking(request, maxTokens);
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(thinking ? { "anthropic-beta": ANTHROPIC_THINKING_BETA } : {}),
    };
    const body = {
      model: request.model,
      system: request.systemPrompt,
      messages: mapMessages(request),
      max_tokens: maxTokens,
      temperature: request.temperature,
      stream: true,
      ...(thinking ? { thinking } : {}),
    };

    debugThinking("stream.request", {
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      maxTokens,
      thinking,
      headers: {
        "anthropic-version": headers["anthropic-version"],
        "anthropic-beta": headers["anthropic-beta"],
      },
      body,
    });

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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

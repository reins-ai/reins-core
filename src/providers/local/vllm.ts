import { estimateConversationTokens, estimateTokens } from "../../context/tokenizer";
import { ProviderError } from "../../errors";
import { StreamTransformer } from "../../streaming/transformer";
import { getTextContent, type Message } from "../../types/conversation";
import type { StreamEvent } from "../../types/streaming";
import type {
  ChatRequest,
  ChatResponse,
  Model,
  Provider,
  ProviderConfig,
  TokenUsage,
} from "../../types/provider";
import type { ToolCall, ToolDefinition } from "../../types/tool";
import { HealthChecker } from "./health";
import { MetricsTracker } from "./metrics";
import type { LocalProviderConfig } from "./types";

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: ToolDefinition["parameters"];
    };
  }>;
}

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      tool_calls?: Array<{
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAIModelsResponse {
  data?: Array<{
    id?: string;
    owned_by?: string;
  }>;
}

const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function toOpenAIMessageRole(role: Message["role"]): OpenAIMessage["role"] {
  if (role === "assistant" || role === "system" || role === "tool") {
    return role;
  }

  return "user";
}

function mapFinishReason(reason?: string): ChatResponse["finishReason"] {
  if (reason === "tool_calls" || reason === "function_call") {
    return "tool_use";
  }

  if (reason === "length") {
    return "length";
  }

  if (reason === "content_filter" || reason === "error") {
    return "error";
  }

  return "stop";
}

function parseToolCalls(
  toolCalls?: Array<{
    id?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>,
): ToolCall[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined;
  }

  const parsed = toolCalls
    .map((entry) => {
      if (typeof entry.id !== "string" || typeof entry.function?.name !== "string") {
        return undefined;
      }

      let argumentsObject: Record<string, unknown> = {};
      if (typeof entry.function.arguments === "string" && entry.function.arguments.length > 0) {
        try {
          const raw = JSON.parse(entry.function.arguments) as unknown;
          if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
            argumentsObject = raw as Record<string, unknown>;
          }
        } catch {
          argumentsObject = {};
        }
      }

      return {
        id: entry.id,
        name: entry.function.name,
        arguments: argumentsObject,
      } satisfies ToolCall;
    })
    .filter((entry): entry is ToolCall => entry !== undefined);

  return parsed.length > 0 ? parsed : undefined;
}

export class VLLMProvider implements Provider {
  readonly config: ProviderConfig;

  private readonly localConfig: LocalProviderConfig;
  private readonly healthChecker: HealthChecker;
  private readonly metrics: MetricsTracker;

  constructor(config: Partial<LocalProviderConfig> = {}) {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;

    this.config = {
      id: "vllm",
      name: "vLLM",
      type: "local",
      baseUrl,
    };

    this.localConfig = {
      id: this.config.id,
      name: this.config.name,
      type: this.config.type,
      baseUrl,
      timeout,
      healthCheckInterval: config.healthCheckInterval,
    };

    this.healthChecker = new HealthChecker(baseUrl, timeout);
    this.metrics = new MetricsTracker();

    if (this.localConfig.healthCheckInterval !== undefined) {
      this.healthChecker.startPolling(this.localConfig.healthCheckInterval);
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const start = performance.now();
    const payload: OpenAIChatRequest = {
      model: request.model,
      messages: this.buildMessages(request),
      stream: false,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      tools: this.convertTools(request.tools),
    };

    const response = await this.requestJson<OpenAIChatResponse>("v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const choice = response.choices?.[0];
    const content = choice?.message?.content ?? "";

    const usage = this.createUsage(
      request,
      content,
      response.usage?.prompt_tokens,
      response.usage?.completion_tokens,
      response.usage?.total_tokens,
    );

    this.recordMetrics(request.model, usage.outputTokens, performance.now() - start);

    return {
      id: response.id ?? `vllm-${Date.now()}`,
      model: response.model ?? request.model,
      content,
      toolCalls: parseToolCalls(choice?.message?.tool_calls),
      usage,
      finishReason: mapFinishReason(choice?.finish_reason),
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.localConfig.timeout ?? DEFAULT_TIMEOUT_MS);
    const start = performance.now();

    try {
      const payload: OpenAIChatRequest = {
        model: request.model,
        messages: this.buildMessages(request),
        stream: true,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        tools: this.convertTools(request.tools),
      };

      const response = await fetch(new URL("v1/chat/completions", normalizeBaseUrl(this.localConfig.baseUrl)), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new ProviderError(`vLLM stream failed with status ${response.status}`);
      }

      if (response.body === null) {
        throw new ProviderError("vLLM stream response body is empty");
      }

      let output = "";
      let doneEmitted = false;

      for await (const event of StreamTransformer.fromSSE(response.body, controller.signal)) {
        if (event.type === "token") {
          output += event.content;
          yield event;
          continue;
        }

        if (event.type === "error") {
          yield event;
          yield {
            type: "done",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            finishReason: "error",
          };
          return;
        }

        if (event.type === "done") {
          if (doneEmitted) {
            continue;
          }

          doneEmitted = true;
          const usage =
            event.usage.totalTokens > 0
              ? event.usage
              : this.createUsage(request, output, undefined, estimateTokens(output));

          this.recordMetrics(request.model, usage.outputTokens, performance.now() - start);

          yield {
            type: "done",
            usage,
            finishReason: event.finishReason,
          };
          return;
        }
      }

      if (!doneEmitted) {
        const fallbackUsage = this.createUsage(request, output);
        this.recordMetrics(request.model, fallbackUsage.outputTokens, performance.now() - start);
        yield {
          type: "done",
          usage: fallbackUsage,
          finishReason: "stop",
        };
      }
    } catch (error) {
      yield {
        type: "error",
        error: error instanceof Error ? error : new ProviderError(String(error)),
      };
      yield {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: "error",
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async listModels(): Promise<Model[]> {
    const response = await this.requestJson<OpenAIModelsResponse>("v1/models", {
      method: "GET",
    });

    return (response.data ?? [])
      .filter((entry) => typeof entry.id === "string" && entry.id.length > 0)
      .map((entry) => {
        const modelId = entry.id as string;
        return {
          id: modelId,
          name: modelId,
          provider: this.config.id,
          contextWindow: this.estimateContextWindow(modelId),
          capabilities: ["chat", "streaming", "tool_use"],
        } satisfies Model;
      });
  }

  async validateConnection(): Promise<boolean> {
    const health = await this.healthChecker.check();
    return health.status === "available";
  }

  getMetricsTracker(): MetricsTracker {
    return this.metrics;
  }

  getHealthChecker(): HealthChecker {
    return this.healthChecker;
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.localConfig.timeout ?? DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(new URL(path, normalizeBaseUrl(this.localConfig.baseUrl)), {
        ...init,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new ProviderError(`vLLM request failed with status ${response.status}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError("Failed to communicate with vLLM", error instanceof Error ? error : undefined);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildMessages(request: ChatRequest): OpenAIMessage[] {
    const messages: Message[] =
      request.systemPrompt === undefined
        ? request.messages
        : [
            {
              id: "system",
              role: "system",
              content: request.systemPrompt,
              createdAt: new Date(),
            },
            ...request.messages,
          ];

    return messages.map((message) => {
      const role = toOpenAIMessageRole(message.role);
      return {
        role,
        content: getTextContent(message.content),
        tool_call_id: role === "tool" ? message.toolResultId : undefined,
      };
    });
  }

  private convertTools(
    tools?: ToolDefinition[],
  ): Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: ToolDefinition["parameters"];
    };
  }> | undefined {
    if (!Array.isArray(tools) || tools.length === 0) {
      return undefined;
    }

    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private createUsage(
    request: ChatRequest,
    content: string,
    inputTokenCount?: number,
    outputTokenCount?: number,
    totalTokenCount?: number,
  ): TokenUsage {
    const inputTokens = inputTokenCount ?? this.estimateInputTokens(request);
    const outputTokens = outputTokenCount ?? estimateTokens(content);
    const totalTokens = totalTokenCount ?? inputTokens + outputTokens;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }

  private estimateInputTokens(request: ChatRequest): number {
    const base = estimateConversationTokens(request.messages);
    if (!request.systemPrompt) {
      return base;
    }
    return base + estimateTokens(request.systemPrompt);
  }

  private estimateContextWindow(modelId: string): number {
    const normalized = modelId.toLowerCase();

    if (normalized.includes("128k")) {
      return 128_000;
    }

    if (normalized.includes("32k")) {
      return 32_000;
    }

    if (normalized.includes("16k")) {
      return 16_000;
    }

    return 8_192;
  }

  private recordMetrics(modelId: string, outputTokens: number, latencyMs: number): void {
    const tokensPerSecond = outputTokens / Math.max(latencyMs / 1000, 0.001);

    this.metrics.record({
      modelId,
      latencyMs,
      tokensPerSecond,
      timestamp: new Date(),
    });
  }
}

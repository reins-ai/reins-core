import { estimateConversationTokens, estimateTokens } from "../../context/tokenizer";
import { ProviderError } from "../../errors";
import type { Message } from "../../types/conversation";
import type { StreamEvent } from "../../types/streaming";
import type {
  ChatRequest,
  ChatResponse,
  Model,
  Provider,
  ProviderConfig,
  TokenUsage,
} from "../../types/provider";
import { HealthChecker } from "./health";
import { MetricsTracker } from "./metrics";
import type { LocalProviderConfig } from "./types";

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

interface OllamaChatResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
  };
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface OllamaStreamChunk {
  model?: string;
  message?: {
    role?: string;
    content?: string;
  };
  done?: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
  error?: string;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    size?: number;
    details?: {
      parameter_size?: string;
      family?: string;
    };
  }>;
}

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function mapRole(role: Message["role"]): OllamaMessage["role"] {
  if (role === "assistant" || role === "system" || role === "tool") {
    return role;
  }

  return "user";
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function convertMessages(messages: Message[]): OllamaMessage[] {
  return messages.map((message) => ({
    role: mapRole(message.role),
    content: message.content,
  }));
}

export class OllamaProvider implements Provider {
  readonly config: ProviderConfig;

  private readonly localConfig: LocalProviderConfig;
  private readonly healthChecker: HealthChecker;
  private readonly metrics: MetricsTracker;

  constructor(config: Partial<LocalProviderConfig> = {}) {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;

    this.config = {
      id: "ollama",
      name: "Ollama",
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
    const payload: OllamaChatRequest = {
      model: request.model,
      messages: this.buildMessages(request),
      stream: false,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
      },
    };

    const response = await this.requestJson<OllamaChatResponse>("api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const content = response.message?.content ?? "";
    const usage = this.createUsage(request, content, response.prompt_eval_count, response.eval_count);

    this.recordMetrics(
      request.model,
      usage.outputTokens,
      performance.now() - start,
      safeNumber(response.eval_duration),
    );

    return {
      id: `ollama-${Date.now()}`,
      model: response.model ?? request.model,
      content,
      usage,
      finishReason: "stop",
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.localConfig.timeout ?? DEFAULT_TIMEOUT_MS);
    const start = performance.now();

    try {
      const payload: OllamaChatRequest = {
        model: request.model,
        messages: this.buildMessages(request),
        stream: true,
        options: {
          temperature: request.temperature,
          num_predict: request.maxTokens,
        },
      };

      const response = await fetch(new URL("api/chat", normalizeBaseUrl(this.localConfig.baseUrl)), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new ProviderError(`Ollama stream failed with status ${response.status}`);
      }

      if (response.body === null) {
        throw new ProviderError("Ollama stream response body is empty");
      }

      let collectedText = "";

      for await (const line of this.readNdjsonLines(response.body)) {
        let chunk: OllamaStreamChunk;

        try {
          chunk = JSON.parse(line) as OllamaStreamChunk;
        } catch {
          throw new ProviderError("Invalid NDJSON payload from Ollama stream");
        }

        if (typeof chunk.error === "string" && chunk.error.length > 0) {
          throw new ProviderError(chunk.error);
        }

        const delta = chunk.message?.content ?? "";
        if (delta.length > 0) {
          collectedText += delta;
          yield { type: "token", content: delta };
        }

        if (chunk.done) {
          const usage = this.createUsage(
            request,
            collectedText,
            chunk.prompt_eval_count,
            chunk.eval_count,
          );

          this.recordMetrics(
            request.model,
            usage.outputTokens,
            performance.now() - start,
            safeNumber(chunk.eval_duration),
          );

          yield {
            type: "done",
            usage,
            finishReason: "stop",
          };
          return;
        }
      }

      const fallbackUsage = this.createUsage(request, collectedText);
      this.recordMetrics(request.model, fallbackUsage.outputTokens, performance.now() - start);

      yield {
        type: "done",
        usage: fallbackUsage,
        finishReason: "stop",
      };
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
    const response = await this.requestJson<OllamaTagsResponse>("api/tags", { method: "GET" });
    const models = response.models ?? [];

    return models
      .filter((model) => typeof model.name === "string" && model.name.length > 0)
      .map((model) => {
        const name = model.name as string;
        const family = model.details?.family;
        return {
          id: name,
          name,
          provider: this.config.id,
          contextWindow: this.estimateContextWindow(name, family),
          capabilities: this.estimateCapabilities(name, family),
        };
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

  private buildMessages(request: ChatRequest): OllamaMessage[] {
    const systemMessage: Message[] =
      request.systemPrompt === undefined
        ? []
        : [
            {
              id: "system",
              role: "system",
              content: request.systemPrompt,
              createdAt: new Date(),
            },
          ];

    return convertMessages([...systemMessage, ...request.messages]);
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
        throw new ProviderError(`Ollama request failed with status ${response.status}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError("Failed to communicate with Ollama", error instanceof Error ? error : undefined);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async *readNdjsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (value === undefined) {
          continue;
        }

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");

        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            yield line;
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }

      const trailing = (buffer + decoder.decode()).trim();
      if (trailing.length > 0) {
        yield trailing;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private createUsage(
    request: ChatRequest,
    content: string,
    inputTokenCount?: number,
    outputTokenCount?: number,
  ): TokenUsage {
    const inputTokens = inputTokenCount ?? this.estimateInputTokens(request);
    const outputTokens = outputTokenCount ?? estimateTokens(content);

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  private estimateInputTokens(request: ChatRequest): number {
    const base = estimateConversationTokens(request.messages);
    if (!request.systemPrompt) {
      return base;
    }
    return base + estimateTokens(request.systemPrompt);
  }

  private estimateCapabilities(modelName: string, family?: string): Model["capabilities"] {
    const normalized = `${modelName} ${family ?? ""}`.toLowerCase();
    const capabilities: Model["capabilities"] = ["chat", "streaming"];

    if (normalized.includes("vision") || normalized.includes("llava")) {
      capabilities.push("vision");
    }

    return capabilities;
  }

  private estimateContextWindow(modelName: string, family?: string): number {
    const normalized = `${modelName} ${family ?? ""}`.toLowerCase();

    if (normalized.includes("llama3") || normalized.includes("qwen2.5")) {
      return 128_000;
    }

    if (normalized.includes("mistral") || normalized.includes("gemma")) {
      return 32_000;
    }

    return 8_192;
  }

  private recordMetrics(
    modelId: string,
    outputTokens: number,
    latencyMs: number,
    evalDurationNs?: number,
  ): void {
    const evalSeconds = evalDurationNs === undefined ? 0 : evalDurationNs / 1_000_000_000;
    const tokensPerSecond =
      evalSeconds > 0 ? outputTokens / evalSeconds : outputTokens / Math.max(latencyMs / 1000, 0.001);

    this.metrics.record({
      modelId,
      latencyMs,
      tokensPerSecond,
      timestamp: new Date(),
    });
  }
}

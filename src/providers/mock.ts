import { ProviderError } from "../errors";
import type { StreamEvent } from "../types/streaming";
import type {
  ChatRequest,
  ChatResponse,
  Model,
  Provider,
  ProviderConfig,
  TokenUsage,
} from "../types/provider";
import type { ToolCall } from "../types/tool";

export interface MockProviderOptions {
  config?: Partial<ProviderConfig>;
  models?: Model[];
  responseContent?: string;
  toolCalls?: ToolCall[];
  finishReason?: ChatResponse["finishReason"];
  simulateError?: boolean;
  errorMessage?: string;
}

const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  id: "mock-provider",
  name: "Mock Provider",
  type: "local",
};

const DEFAULT_MODEL_ID = "mock-model-1";

const DEFAULT_MODELS: Model[] = [
  {
    id: DEFAULT_MODEL_ID,
    name: "Mock Model 1",
    provider: DEFAULT_PROVIDER_CONFIG.id,
    contextWindow: 4096,
    capabilities: ["chat", "streaming", "tool_use"],
  },
];

export class MockProvider implements Provider {
  readonly config: ProviderConfig;

  private readonly models: Model[];
  private readonly responseContent: string;
  private readonly toolCalls?: ToolCall[];
  private readonly finishReason: ChatResponse["finishReason"];
  private readonly simulateError: boolean;
  private readonly errorMessage: string;

  constructor(options: MockProviderOptions = {}) {
    this.config = {
      ...DEFAULT_PROVIDER_CONFIG,
      ...options.config,
    };

    this.models = this.normalizeModels(options.models ?? DEFAULT_MODELS);
    this.responseContent = options.responseContent ?? "Mock response";
    this.toolCalls = options.toolCalls;
    this.finishReason = options.finishReason ?? (this.toolCalls ? "tool_use" : "stop");
    this.simulateError = options.simulateError ?? false;
    this.errorMessage = options.errorMessage ?? "Mock provider error";
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.ensureNoError();
    this.ensureModelExists(request.model);

    const usage = this.calculateUsage(request, this.responseContent);

    return {
      id: `mock-chat-${Date.now()}`,
      model: request.model,
      content: this.responseContent,
      toolCalls: this.toolCalls,
      usage,
      finishReason: this.finishReason,
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.simulateError) {
      yield { type: "error", error: new ProviderError(this.errorMessage) };
      yield {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: "error",
      };
      return;
    }

    this.ensureModelExists(request.model);

    for (const character of this.responseContent) {
      yield { type: "token", content: character };
    }

    for (const toolCall of this.toolCalls ?? []) {
      yield { type: "tool_call_start", toolCall };
      yield {
        type: "tool_call_end",
        result: {
          callId: toolCall.id,
          name: toolCall.name,
          result: { ok: true },
        },
      };
    }

    yield {
      type: "done",
      usage: this.calculateUsage(request, this.responseContent),
      finishReason: this.finishReason,
    };
  }

  async listModels(): Promise<Model[]> {
    this.ensureNoError();
    return [...this.models];
  }

  async validateConnection(): Promise<boolean> {
    return true;
  }

  private ensureNoError(): void {
    if (this.simulateError) {
      throw new ProviderError(this.errorMessage);
    }
  }

  private ensureModelExists(modelId: string): void {
    const hasModel = this.models.some((model) => model.id === modelId);

    if (!hasModel) {
      throw new ProviderError(`Model not available on provider ${this.config.id}: ${modelId}`);
    }
  }

  private calculateUsage(request: ChatRequest, content: string): TokenUsage {
    const inputTokenEstimate = this.estimateTokens([
      request.systemPrompt ?? "",
      ...request.messages.map((message) => message.content),
    ]);
    const outputTokenEstimate = this.estimateTokens([content]);

    return {
      inputTokens: inputTokenEstimate,
      outputTokens: outputTokenEstimate,
      totalTokens: inputTokenEstimate + outputTokenEstimate,
    };
  }

  private estimateTokens(parts: string[]): number {
    const text = parts.join(" ").trim();
    if (text.length === 0) {
      return 0;
    }

    return text.split(/\s+/).length;
  }

  private normalizeModels(models: Model[]): Model[] {
    return models.map((model) => ({
      ...model,
      provider: model.provider || this.config.id,
    }));
  }
}

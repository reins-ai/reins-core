import { ProviderError } from "../../errors";
import { generateId } from "../../conversation/id";
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

interface BYOKGoogleProviderOptions {
  baseUrl?: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

interface GeminiRequest {
  contents: GeminiContent[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseGeminiUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const inputTokens = asNumber(value.promptTokenCount) ?? 0;
  const outputTokens = asNumber(value.candidatesTokenCount) ?? 0;
  const totalTokens = asNumber(value.totalTokenCount) ?? inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function mapFinishReason(value: unknown): ChatResponse["finishReason"] {
  if (value === "MAX_TOKENS") {
    return "length";
  }

  return "stop";
}

function mapRole(role: Message["role"]): GeminiContent["role"] {
  return role === "assistant" ? "model" : "user";
}

function toGeminiRequest(request: ChatRequest): GeminiRequest {
  const systemPrefix = request.systemPrompt ? `${request.systemPrompt}\n\n` : "";
  const contents = request.messages.map((message, index) => {
    const text = getTextContent(message.content);
    return {
      role: mapRole(message.role),
      parts: [{ text: index === 0 ? `${systemPrefix}${text}` : text }],
    };
  });

  return {
    contents,
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
    },
  };
}

function parseTextFromCandidates(candidates: unknown): string {
  if (!Array.isArray(candidates)) {
    return "";
  }

  const textParts: string[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
      continue;
    }

    for (const part of candidate.content.parts) {
      if (!isRecord(part)) {
        continue;
      }

      const text = asString(part.text);
      if (text && text.length > 0) {
        textParts.push(text);
      }
    }
  }

  return textParts.join("");
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

const DEFAULT_MODELS: Model[] = [
  {
    id: "gemini-1.5-pro",
    name: "Gemini 1.5 Pro",
    provider: "byok-google",
    contextWindow: 2_000_000,
    capabilities: ["chat", "streaming", "vision"],
  },
  {
    id: "gemini-1.5-flash",
    name: "Gemini 1.5 Flash",
    provider: "byok-google",
    contextWindow: 1_000_000,
    capabilities: ["chat", "streaming", "vision"],
  },
];

export class BYOKGoogleProvider implements Provider {
  public readonly config: ProviderConfig;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, options: BYOKGoogleProviderOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.config = {
      id: "byok-google",
      name: "Google BYOK",
      type: "byok",
      baseUrl: this.baseUrl,
    };
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const endpoint = new URL(
      `v1beta/models/${request.model}:generateContent`,
      normalizeBaseUrl(this.baseUrl),
    ).toString();

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(toGeminiRequest(request)),
    });

    if (!response.ok) {
      throw new ProviderError(`Google chat request failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as unknown;
    if (!isRecord(payload)) {
      throw new ProviderError("Google chat response payload is invalid");
    }

    const finishReason =
      Array.isArray(payload.candidates) && payload.candidates.length > 0 && isRecord(payload.candidates[0])
        ? mapFinishReason(payload.candidates[0].finishReason)
        : "stop";

    return {
      id: generateId("google"),
      model: request.model,
      content: parseTextFromCandidates(payload.candidates),
      usage: parseGeminiUsage(payload.usageMetadata),
      finishReason,
    };
  }

  public async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const endpoint = new URL(
      `v1beta/models/${request.model}:streamGenerateContent?alt=sse`,
      normalizeBaseUrl(this.baseUrl),
    ).toString();

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.apiKey,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(toGeminiRequest(request)),
    });

    if (!response.ok || !response.body) {
      throw new ProviderError(`Google stream request failed (${response.status}): ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let emittedDone = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (!value) {
          continue;
        }

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const dataLines = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart());

          if (dataLines.length === 0) {
            continue;
          }

          const data = dataLines.join("\n").trim();
          if (data === "[DONE]") {
            emittedDone = true;
            yield {
              type: "done",
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              finishReason: "stop",
            };
            continue;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(data) as unknown;
          } catch {
            yield { type: "error", error: new ProviderError("Invalid Google SSE payload") };
            continue;
          }

          if (!isRecord(parsed)) {
            continue;
          }

          const text = parseTextFromCandidates(parsed.candidates);
          if (text.length > 0) {
            yield { type: "token", content: text };
          }
        }
      }

      if (!emittedDone) {
        yield {
          type: "done",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finishReason: "stop",
        };
      }
    } finally {
      reader.releaseLock();
    }
  }

  public async listModels(): Promise<Model[]> {
    return DEFAULT_MODELS.map((model) => ({ ...model, provider: this.config.id }));
  }

  public async validateConnection(): Promise<boolean> {
    try {
      const endpoint = new URL("v1beta/models", normalizeBaseUrl(this.baseUrl)).toString();
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          "x-goog-api-key": this.apiKey,
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

import { err, ok, type Result } from "../../result";
import {
  type EmbeddingProvider,
  type EmbeddingProviderMetadata,
  EmbeddingProviderError,
  validateEmbeddingDimension,
  wrapEmbeddingProviderError,
} from "./embedding-provider";

interface OpenAiEmbeddingResponseRecord {
  embedding?: unknown;
}

interface OpenAiEmbeddingResponse {
  data?: unknown;
}

export interface OpenAiEmbeddingProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  dimension?: number;
  version?: string;
  fetchFn?: typeof fetch;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai";
  readonly model: string;
  readonly dimension: number;
  readonly version: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenAiEmbeddingProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0) {
      throw new EmbeddingProviderError("OpenAI apiKey must be a non-empty string");
    }

    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = options.model ?? "text-embedding-3-small";
    this.dimension = options.dimension ?? 1536;
    this.version = options.version ?? "1";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  get metadata(): EmbeddingProviderMetadata {
    return {
      provider: this.id,
      model: this.model,
      dimension: this.dimension,
      version: this.version,
    };
  }

  async embed(text: string): Promise<Result<Float32Array, EmbeddingProviderError>> {
    const batchResult = await this.embedBatch([text]);
    if (!batchResult.ok) {
      return batchResult;
    }

    const firstVector = batchResult.value[0];
    if (!firstVector) {
      return err(new EmbeddingProviderError("openai embed returned no vectors"));
    }

    return ok(firstVector);
  }

  async embedBatch(texts: string[]): Promise<Result<Float32Array[], EmbeddingProviderError>> {
    if (texts.length === 0) {
      return ok([]);
    }

    for (const text of texts) {
      if (text.trim().length === 0) {
        return err(new EmbeddingProviderError("Embedding input text must be non-empty"));
      }
    }

    try {
      const response = await this.fetchFn(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        return err(
          new EmbeddingProviderError(
            `openai embeddings request failed (${response.status}): ${body}`,
            "EMBEDDING_PROVIDER_REQUEST_FAILED",
          ),
        );
      }

      const payload = (await response.json()) as OpenAiEmbeddingResponse;
      if (!Array.isArray(payload.data)) {
        return err(new EmbeddingProviderError("openai embeddings response missing data array"));
      }

      if (payload.data.length !== texts.length) {
        return err(
          new EmbeddingProviderError(
            `openai embeddings response count mismatch: expected ${texts.length}, got ${payload.data.length}`,
          ),
        );
      }

      const vectors: Float32Array[] = [];
      for (const item of payload.data) {
        const record = item as OpenAiEmbeddingResponseRecord;
        if (!Array.isArray(record.embedding) || !record.embedding.every((value) => typeof value === "number")) {
          return err(new EmbeddingProviderError("openai embeddings response contains invalid vector values"));
        }

        const vector = Float32Array.from(record.embedding);
        const dimensionResult = validateEmbeddingDimension(vector, this.dimension, "openai embedding");
        if (!dimensionResult.ok) {
          return dimensionResult;
        }

        vectors.push(vector);
      }

      return ok(vectors);
    } catch (error) {
      return err(wrapEmbeddingProviderError(this.id, "embedBatch", error));
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/models/${encodeURIComponent(this.model)}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

import { err, ok, type Result } from "../../result";
import {
  type EmbeddingProvider,
  type EmbeddingProviderMetadata,
  EmbeddingProviderError,
  validateEmbeddingDimension,
  wrapEmbeddingProviderError,
} from "./embedding-provider";

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

export interface OllamaEmbeddingProviderOptions {
  baseUrl?: string;
  model?: string;
  dimension?: number;
  version?: string;
  fetchFn?: typeof fetch;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = "ollama";
  readonly model: string;
  readonly dimension: number;
  readonly version: string;

  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OllamaEmbeddingProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    this.model = options.model ?? "nomic-embed-text";
    this.dimension = options.dimension ?? 768;
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
      return err(new EmbeddingProviderError("ollama embed returned no vectors"));
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
      const response = await this.fetchFn(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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
            `ollama embed request failed (${response.status}): ${body}`,
            "EMBEDDING_PROVIDER_REQUEST_FAILED",
          ),
        );
      }

      const payload = (await response.json()) as OllamaEmbedResponse;
      if (!Array.isArray(payload.embeddings)) {
        return err(new EmbeddingProviderError("ollama embed response missing embeddings array"));
      }

      if (payload.embeddings.length !== texts.length) {
        return err(
          new EmbeddingProviderError(
            `ollama embed response count mismatch: expected ${texts.length}, got ${payload.embeddings.length}`,
          ),
        );
      }

      const vectors: Float32Array[] = [];
      for (const rawVector of payload.embeddings) {
        if (!Array.isArray(rawVector) || !rawVector.every((value) => typeof value === "number")) {
          return err(new EmbeddingProviderError("ollama embed response contains invalid vector values"));
        }

        const vector = Float32Array.from(rawVector);
        const dimensionResult = validateEmbeddingDimension(vector, this.dimension, "ollama embedding");
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
      const response = await this.fetchFn(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

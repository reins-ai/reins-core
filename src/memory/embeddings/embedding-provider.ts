import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";

export interface EmbeddingProviderMetadata {
  provider: string;
  model: string;
  dimension: number;
  version: string;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimension: number;
  readonly version: string;

  embed(text: string): Promise<Result<Float32Array, EmbeddingProviderError>>;
  embedBatch(texts: string[]): Promise<Result<Float32Array[], EmbeddingProviderError>>;
  isAvailable(): Promise<boolean>;
}

export class EmbeddingProviderError extends ReinsError {
  constructor(message: string, code = "EMBEDDING_PROVIDER_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "EmbeddingProviderError";
  }
}

function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

function getErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  return String(value);
}

export function validateEmbeddingDimension(
  vector: Float32Array,
  expectedDimension: number,
  context: string,
): Result<void, EmbeddingProviderError> {
  if (vector.length !== expectedDimension) {
    return err(
      new EmbeddingProviderError(
        `${context} returned dimension ${vector.length}, expected ${expectedDimension}`,
        "EMBEDDING_DIMENSION_MISMATCH",
      ),
    );
  }

  return ok(undefined);
}

export function vectorToBlob(vector: Float32Array): Buffer {
  const start = vector.byteOffset;
  const end = vector.byteOffset + vector.byteLength;
  const arrayBuffer = vector.buffer.slice(start, end);
  return Buffer.from(arrayBuffer);
}

export function blobToVector(blob: Buffer): Float32Array {
  if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new EmbeddingProviderError(
      "Embedding blob byte length must be divisible by 4",
      "EMBEDDING_BLOB_INVALID",
    );
  }

  const start = blob.byteOffset;
  const end = blob.byteOffset + blob.byteLength;
  const arrayBuffer = blob.buffer.slice(start, end);
  return new Float32Array(arrayBuffer);
}

export class EmbeddingProviderRegistry {
  private readonly providers = new Map<string, EmbeddingProvider>();
  private defaultProviderId?: string;

  register(provider: EmbeddingProvider): Result<void, EmbeddingProviderError> {
    const providerId = normalizeProviderId(provider.id);
    if (providerId.length === 0) {
      return err(new EmbeddingProviderError("Provider id must be a non-empty string"));
    }

    if (this.providers.has(providerId)) {
      return err(new EmbeddingProviderError(`Provider already registered: ${providerId}`));
    }

    this.providers.set(providerId, provider);
    if (!this.defaultProviderId) {
      this.defaultProviderId = providerId;
    }

    return ok(undefined);
  }

  get(id: string): EmbeddingProvider | undefined {
    return this.providers.get(normalizeProviderId(id));
  }

  getDefault(): EmbeddingProvider | undefined {
    if (!this.defaultProviderId) {
      return undefined;
    }

    return this.providers.get(this.defaultProviderId);
  }

  setDefault(id: string): Result<void, EmbeddingProviderError> {
    const providerId = normalizeProviderId(id);
    if (!this.providers.has(providerId)) {
      return err(new EmbeddingProviderError(`Provider not found: ${id}`));
    }

    this.defaultProviderId = providerId;
    return ok(undefined);
  }

  list(): EmbeddingProvider[] {
    return Array.from(this.providers.values());
  }
}

export function wrapEmbeddingProviderError(
  providerId: string,
  operation: string,
  value: unknown,
): EmbeddingProviderError {
  const message = `${providerId} ${operation} failed: ${getErrorMessage(value)}`;
  const cause = value instanceof Error ? value : undefined;
  return new EmbeddingProviderError(message, "EMBEDDING_PROVIDER_REQUEST_FAILED", cause);
}

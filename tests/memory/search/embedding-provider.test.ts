import { describe, expect, test } from "bun:test";

import { ok } from "../../../src/result";
import {
  EmbeddingProviderRegistry,
  blobToVector,
  validateEmbeddingDimension,
  vectorToBlob,
  type EmbeddingProvider,
} from "../../../src/memory/embeddings/embedding-provider";
import { OllamaEmbeddingProvider } from "../../../src/memory/embeddings/ollama-embedding-provider";
import { OpenAIEmbeddingProvider } from "../../../src/memory/embeddings/openai-embedding-provider";

interface FetchRecord {
  url: string;
  init?: RequestInit;
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function createMockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  records: FetchRecord[],
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = resolveUrl(input);
    records.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
}

function getHeaderValue(headers: HeadersInit | undefined, headerName: string): string | null {
  if (!headers) {
    return null;
  }

  const target = headerName.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(headerName);
  }

  if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      if (name.toLowerCase() === target) {
        return value;
      }
    }

    return null;
  }

  const value = headers[headerName] ?? headers[target];
  if (Array.isArray(value)) {
    return value.join(",");
  }

  return typeof value === "string" ? value : null;
}

function readJsonBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") {
    return undefined;
  }

  return JSON.parse(init.body);
}

function createProvider(id: string, model: string, dimension: number): EmbeddingProvider {
  return {
    id,
    model,
    dimension,
    version: "1",
    async embed() {
      return ok(new Float32Array(dimension));
    },
    async embedBatch(texts: string[]) {
      return ok(texts.map(() => new Float32Array(dimension)));
    },
    async isAvailable() {
      return true;
    },
  };
}

function expectVectorCloseTo(actual: Float32Array, expected: number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(actual[index]).toBeCloseTo(expected[index] ?? 0, 6);
  }
}

describe("EmbeddingProviderRegistry", () => {
  test("registers providers and manages default provider", () => {
    const registry = new EmbeddingProviderRegistry();
    const ollama = createProvider("ollama", "nomic-embed-text", 3);
    const openai = createProvider("openai", "text-embedding-3-small", 4);

    const firstRegister = registry.register(ollama);
    const secondRegister = registry.register(openai);

    expect(firstRegister.ok).toBe(true);
    expect(secondRegister.ok).toBe(true);
    expect(registry.get("ollama")).toBe(ollama);
    expect(registry.get("OPENAI")).toBe(openai);
    expect(registry.list()).toEqual([ollama, openai]);
    expect(registry.getDefault()).toBe(ollama);

    const setDefaultResult = registry.setDefault("openai");
    expect(setDefaultResult.ok).toBe(true);
    expect(registry.getDefault()).toBe(openai);
  });

  test("rejects duplicate registrations and unknown default provider", () => {
    const registry = new EmbeddingProviderRegistry();
    const provider = createProvider("ollama", "nomic-embed-text", 3);

    const first = registry.register(provider);
    const duplicate = registry.register(provider);
    const missingDefault = registry.setDefault("missing");

    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.message).toContain("already registered");
    }

    expect(missingDefault.ok).toBe(false);
    if (!missingDefault.ok) {
      expect(missingDefault.error.message).toContain("Provider not found");
    }
  });
});

describe("vector serialization", () => {
  test("round-trips vectorToBlob and blobToVector", () => {
    const vector = new Float32Array([1.25, -2.5, 3.75]);
    const blob = vectorToBlob(vector);
    const roundTripped = blobToVector(blob);

    expect(roundTripped.length).toBe(vector.length);
    expect(roundTripped[0]).toBeCloseTo(vector[0] ?? 0, 6);
    expect(roundTripped[1]).toBeCloseTo(vector[1] ?? 0, 6);
    expect(roundTripped[2]).toBeCloseTo(vector[2] ?? 0, 6);
  });

  test("validates vector dimension", () => {
    const vector = new Float32Array([0.1, 0.2]);
    const result = validateEmbeddingDimension(vector, 3, "test embedding");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EMBEDDING_DIMENSION_MISMATCH");
      expect(result.error.message).toContain("expected 3");
    }
  });
});

describe("OllamaEmbeddingProvider", () => {
  test("generates single and batch embeddings with mocked fetch", async () => {
    const records: FetchRecord[] = [];
    const mockFetch = createMockFetch((url, init) => {
      expect(url).toBe("http://localhost:11434/api/embed");
      expect(init?.method).toBe("POST");

      const payload = readJsonBody(init) as { model?: string; input?: unknown };
      expect(payload.model).toBe("nomic-embed-text");
      expect(Array.isArray(payload.input)).toBe(true);

      const inputs = Array.isArray(payload.input) ? payload.input : [];
      const embeddings = inputs.map((_, index) => [index + 0.1, index + 0.2, index + 0.3]);
      return new Response(JSON.stringify({ embeddings }), { status: 200 });
    }, records);

    const provider = new OllamaEmbeddingProvider({
      fetchFn: mockFetch,
      dimension: 3,
      model: "nomic-embed-text",
    });

    const single = await provider.embed("hello world");
    expect(single.ok).toBe(true);
    if (single.ok) {
      expectVectorCloseTo(single.value, [0.1, 0.2, 0.3]);
    }

    const batch = await provider.embedBatch(["a", "b"]);
    expect(batch.ok).toBe(true);
    if (batch.ok) {
      expect(batch.value.length).toBe(2);
      const secondVector = batch.value[1];
      expect(secondVector).toBeDefined();
      if (secondVector) {
        expectVectorCloseTo(secondVector, [1.1, 1.2, 1.3]);
      }
    }

    expect(records.length).toBe(2);
  });

  test("returns errors for failed requests and dimension mismatches", async () => {
    const failureFetch = createMockFetch(
      () => new Response("service unavailable", { status: 503 }),
      [],
    );

    const failureProvider = new OllamaEmbeddingProvider({
      fetchFn: failureFetch,
      dimension: 3,
    });

    const failed = await failureProvider.embed("hello");
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("EMBEDDING_PROVIDER_REQUEST_FAILED");
      expect(failed.error.message).toContain("503");
    }

    const mismatchFetch = createMockFetch(
      () => new Response(JSON.stringify({ embeddings: [[1, 2]] }), { status: 200 }),
      [],
    );

    const mismatchProvider = new OllamaEmbeddingProvider({
      fetchFn: mismatchFetch,
      dimension: 3,
    });
    const mismatch = await mismatchProvider.embed("hello");
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error.code).toBe("EMBEDDING_DIMENSION_MISMATCH");
    }
  });

  test("reports availability based on /api/tags response", async () => {
    const availableProvider = new OllamaEmbeddingProvider({
      fetchFn: createMockFetch(
        (url) => {
          expect(url).toBe("http://localhost:11434/api/tags");
          return new Response(JSON.stringify({ models: [] }), { status: 200 });
        },
        [],
      ),
    });

    const unavailableProvider = new OllamaEmbeddingProvider({
      fetchFn: createMockFetch(() => new Response("nope", { status: 500 }), []),
    });

    expect(await availableProvider.isAvailable()).toBe(true);
    expect(await unavailableProvider.isAvailable()).toBe(false);
  });
});

describe("OpenAIEmbeddingProvider", () => {
  test("generates embeddings and sends auth header", async () => {
    const records: FetchRecord[] = [];
    const mockFetch = createMockFetch((url, init) => {
      expect(url).toBe("https://api.openai.com/v1/embeddings");
      expect(init?.method).toBe("POST");
      expect(getHeaderValue(init?.headers, "Authorization")).toBe("Bearer test-key");

      const payload = readJsonBody(init) as { model?: string; input?: unknown };
      expect(payload.model).toBe("text-embedding-3-small");
      const inputs = Array.isArray(payload.input) ? payload.input : [];

      const data = inputs.map((_, index) => ({
        embedding: [index + 0.01, index + 0.02, index + 0.03],
      }));

      return new Response(JSON.stringify({ data }), { status: 200 });
    }, records);

    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetchFn: mockFetch,
      model: "text-embedding-3-small",
      dimension: 3,
    });

    const single = await provider.embed("hello");
    expect(single.ok).toBe(true);
    if (single.ok) {
      expectVectorCloseTo(single.value, [0.01, 0.02, 0.03]);
    }

    const batch = await provider.embedBatch(["a", "b"]);
    expect(batch.ok).toBe(true);
    if (batch.ok) {
      expect(batch.value.length).toBe(2);
      const secondVector = batch.value[1];
      expect(secondVector).toBeDefined();
      if (secondVector) {
        expectVectorCloseTo(secondVector, [1.01, 1.02, 1.03]);
      }
    }

    expect(records.length).toBe(2);
  });

  test("handles API failures and reports availability", async () => {
    const failedProvider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      dimension: 3,
      fetchFn: createMockFetch(() => new Response("bad key", { status: 401 }), []),
    });

    const failedEmbed = await failedProvider.embed("hello");
    expect(failedEmbed.ok).toBe(false);
    if (!failedEmbed.ok) {
      expect(failedEmbed.error.code).toBe("EMBEDDING_PROVIDER_REQUEST_FAILED");
      expect(failedEmbed.error.message).toContain("401");
    }

    const availableProvider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetchFn: createMockFetch((url) => {
        expect(url).toBe("https://api.openai.com/v1/models/text-embedding-3-small");
        return new Response("", { status: 200 });
      }, []),
    });

    const unavailableProvider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetchFn: createMockFetch(() => new Response("", { status: 503 }), []),
    });

    expect(await availableProvider.isAvailable()).toBe(true);
    expect(await unavailableProvider.isAvailable()).toBe(false);
  });
});

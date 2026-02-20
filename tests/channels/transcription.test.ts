import { describe, expect, it } from "bun:test";

import { transcribeAudio } from "../../src/channels/transcription";
import { ChannelError } from "../../src/channels/errors";

function createMockFetch(
  status: number,
  body: unknown,
  options: { throwError?: Error } = {},
): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    if (options.throwError) {
      throw options.throwError;
    }

    // Capture request details for assertion
    const request = input instanceof Request ? input : new Request(input, init);
    (createMockFetch as unknown as Record<string, unknown>).lastRequest = request;
    (createMockFetch as unknown as Record<string, unknown>).lastInit = init;

    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

function createCapturingFetch(
  status: number,
  body: unknown,
): { fetchFn: typeof fetch; captured: { url: string; headers: Record<string, string>; body: FormData | null }[] } {
  const captured: { url: string; headers: Record<string, string>; body: FormData | null }[] = [];

  const fetchFn: typeof fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }

    const formBody = init?.body instanceof FormData ? init.body : null;
    captured.push({ url, headers, body: formBody });

    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetchFn, captured };
}

const sampleBuffer = new ArrayBuffer(100);

describe("transcribeAudio", () => {
  it("transcribes audio using Groq API", async () => {
    const mockFetch = createMockFetch(200, { text: "Hello world" });

    const result = await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      { apiKey: "gsk_test123", fetchFn: mockFetch },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Hello world");
    }
  });

  it("returns error when API returns non-200", async () => {
    const mockFetch = createMockFetch(401, {
      error: { message: "Invalid API key" },
    });

    const result = await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      { apiKey: "bad-key", fetchFn: mockFetch },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ChannelError);
      expect(result.error.message).toContain("status 401");
    }
  });

  it("returns error on network failure", async () => {
    const networkError = new Error("Connection refused");
    const mockFetch = createMockFetch(200, {}, { throwError: networkError });

    const result = await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      { apiKey: "gsk_test123", fetchFn: mockFetch },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ChannelError);
      expect(result.error.message).toBe("Transcription request failed");
    }
  });

  it("uses custom model when provided", async () => {
    const { fetchFn, captured } = createCapturingFetch(200, {
      text: "transcribed",
    });

    const result = await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      {
        apiKey: "gsk_test123",
        model: "whisper-large-v3",
        fetchFn,
      },
    );

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const formData = captured[0]!.body!;
    expect(formData.get("model")).toBe("whisper-large-v3");
  });

  it("uses default model when not specified", async () => {
    const { fetchFn, captured } = createCapturingFetch(200, {
      text: "transcribed",
    });

    await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      { apiKey: "gsk_test123", fetchFn },
    );

    expect(captured).toHaveLength(1);
    const formData = captured[0]!.body!;
    expect(formData.get("model")).toBe("whisper-large-v3-turbo");
  });

  it("handles empty transcript response", async () => {
    const mockFetch = createMockFetch(200, { text: "" });

    const result = await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      { apiKey: "gsk_test123", fetchFn: mockFetch },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("");
    }
  });

  it("handles missing text field in response", async () => {
    const mockFetch = createMockFetch(200, { duration: 1.5 });

    const result = await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      { apiKey: "gsk_test123", fetchFn: mockFetch },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("");
    }
  });

  it("sends correct Authorization header", async () => {
    const { fetchFn, captured } = createCapturingFetch(200, {
      text: "ok",
    });

    await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      { apiKey: "gsk_secret_key_123", fetchFn },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers["authorization"]).toBe(
      "Bearer gsk_secret_key_123",
    );
  });

  it("sends correct multipart form data", async () => {
    const { fetchFn, captured } = createCapturingFetch(200, {
      text: "hello",
    });

    await transcribeAudio(
      sampleBuffer,
      "voice.webm",
      "audio/webm",
      { apiKey: "gsk_test", fetchFn },
    );

    expect(captured).toHaveLength(1);
    const formData = captured[0]!.body!;
    expect(formData.get("model")).toBe("whisper-large-v3-turbo");
    expect(formData.get("response_format")).toBe("json");

    const file = formData.get("file") as Blob;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe("audio/webm");
    expect(file.size).toBe(100);
  });

  it("sends request to Groq API URL", async () => {
    const { fetchFn, captured } = createCapturingFetch(200, {
      text: "ok",
    });

    await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      { apiKey: "gsk_test", fetchFn },
    );

    expect(captured[0]!.url).toBe(
      "https://api.groq.com/openai/v1/audio/transcriptions",
    );
  });

  it("includes language hint when provided", async () => {
    const { fetchFn, captured } = createCapturingFetch(200, {
      text: "bonjour",
    });

    await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      { apiKey: "gsk_test", language: "fr", fetchFn },
    );

    expect(captured).toHaveLength(1);
    const formData = captured[0]!.body!;
    expect(formData.get("language")).toBe("fr");
  });

  it("omits language field when not provided", async () => {
    const { fetchFn, captured } = createCapturingFetch(200, {
      text: "hello",
    });

    await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      { apiKey: "gsk_test", fetchFn },
    );

    expect(captured).toHaveLength(1);
    const formData = captured[0]!.body!;
    expect(formData.get("language")).toBeNull();
  });

  it("returns error when response is not valid JSON", async () => {
    const fetchFn: typeof fetch = async () => {
      return new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    };

    const result = await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      { apiKey: "gsk_test", fetchFn },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        "Transcription API returned invalid JSON",
      );
    }
  });

  it("includes error body detail in non-200 error message", async () => {
    const fetchFn: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded" } }),
        { status: 429 },
      );
    };

    const result = await transcribeAudio(
      sampleBuffer,
      "voice.ogg",
      "audio/ogg",
      { apiKey: "gsk_test", fetchFn },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("status 429");
      expect(result.error.message).toContain("Rate limit exceeded");
    }
  });
});

import { describe, expect, it } from "bun:test";

import { ChannelError } from "../../../src/channels/errors";
import { DiscordClient } from "../../../src/channels/discord/client";
import type { DiscordMessage } from "../../../src/channels/discord/types";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface FetchMockContext {
  calls: FetchCall[];
  fetchFn: typeof fetch;
}

function createMessage(id: string): DiscordMessage {
  return {
    id,
    channel_id: "123",
    author: {
      id: "user-1",
      username: "reins",
      discriminator: "0001",
      bot: true,
    },
    content: "hello",
    timestamp: "2026-02-15T00:00:00.000Z",
    embeds: [],
    attachments: [],
  };
}

function createJsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function createFetchMock(
  queue: Array<Response | Error | (() => Promise<Response> | Response)>,
): FetchMockContext {
  const calls: FetchCall[] = [];

  const fetchFn: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });

    const next = queue.shift();
    if (next === undefined) {
      throw new Error("No queued response available");
    }

    if (next instanceof Error) {
      throw next;
    }

    if (typeof next === "function") {
      const value = next();
      return await Promise.resolve(value);
    }

    return next;
  };

  return { calls, fetchFn };
}

function parseJsonBody(call: FetchCall): Record<string, unknown> {
  const body = call.init?.body;
  expect(typeof body).toBe("string");
  return JSON.parse(body as string) as Record<string, unknown>;
}

describe("DiscordClient", () => {
  it("sends plain text messages via Discord REST API", async () => {
    const { fetchFn, calls } = createFetchMock([
      createJsonResponse(200, createMessage("message-1")),
    ]);

    const client = new DiscordClient({ token: "bot-token", fetchFn });
    const result = await client.sendMessage("123", "hello from reins");

    expect(result.id).toBe("message-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/123/messages");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toBeInstanceOf(Headers);

    const headers = calls[0]!.init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bot bot-token");
    expect(headers.get("content-type")).toBe("application/json");

    const body = parseJsonBody(calls[0]!);
    expect(body.content).toBe("hello from reins");
  });

  it("sends embeds via Discord REST API", async () => {
    const { fetchFn, calls } = createFetchMock([
      createJsonResponse(200, createMessage("message-2")),
    ]);

    const client = new DiscordClient({ token: "bot-token", fetchFn });
    await client.sendEmbed("123", {
      title: "Summary",
      description: "Build complete",
      color: 0x00_aa_ff,
    });

    const body = parseJsonBody(calls[0]!);
    expect(Array.isArray(body.embeds)).toBe(true);
    const embeds = body.embeds as Array<Record<string, unknown>>;
    expect(embeds[0]?.title).toBe("Summary");
    expect(embeds[0]?.description).toBe("Build complete");
  });

  it("sends typing indicator via Discord REST API", async () => {
    const { fetchFn, calls } = createFetchMock([
      createJsonResponse(204, null),
    ]);

    const client = new DiscordClient({ token: "bot-token", fetchFn });
    await client.sendTyping("123");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/123/typing");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("uploads files using multipart form data", async () => {
    const { fetchFn, calls } = createFetchMock([
      createJsonResponse(200, createMessage("message-3")),
    ]);

    const client = new DiscordClient({ token: "bot-token", fetchFn });
    await client.uploadFile("123", {
      name: "report.txt",
      data: "hello file",
      contentType: "text/plain",
      description: "daily report",
    });

    expect(calls).toHaveLength(1);
    const body = calls[0]!.init?.body;
    expect(body).toBeInstanceOf(FormData);

    const formData = body as FormData;
    const filePart = formData.get("files[0]");
    expect(filePart).toBeInstanceOf(File);
    const payloadJson = formData.get("payload_json");
    expect(payloadJson).toBe('{"attachments":[{"id":0,"description":"daily report"}]}');
  });

  it("respects route bucket limits between requests", async () => {
    const sleepCalls: number[] = [];
    let nowMs = 0;
    const { fetchFn } = createFetchMock([
      createJsonResponse(
        200,
        createMessage("message-1"),
        {
          "x-ratelimit-bucket": "bucket-a",
          "x-ratelimit-limit": "5",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset-after": "2",
        },
      ),
      createJsonResponse(200, createMessage("message-2")),
    ]);

    const client = new DiscordClient({
      token: "bot-token",
      fetchFn,
      nowFn: () => nowMs,
      sleepFn: async (delayMs: number) => {
        sleepCalls.push(delayMs);
        nowMs += delayMs;
      },
    });

    await client.sendMessage("123", "first");
    await client.sendMessage("123", "second");

    expect(sleepCalls).toContain(2_000);
  });

  it("retries 429 responses using retry-after", async () => {
    const sleepCalls: number[] = [];
    const { fetchFn, calls } = createFetchMock([
      createJsonResponse(429, {
        message: "You are being rate limited.",
        code: 0,
        retry_after: 1,
        global: false,
      }, { "retry-after": "1" }),
      createJsonResponse(200, createMessage("message-9")),
    ]);

    const client = new DiscordClient({
      token: "bot-token",
      fetchFn,
      sleepFn: async (delayMs: number) => {
        sleepCalls.push(delayMs);
      },
    });

    const result = await client.sendMessage("123", "hello");
    expect(result.id).toBe("message-9");
    expect(calls).toHaveLength(2);
    expect(sleepCalls[0]).toBe(1_000);
  });

  it("throws ChannelError on non-retriable API failures", async () => {
    const { fetchFn } = createFetchMock([
      createJsonResponse(403, {
        message: "Missing Access",
        code: 50_001,
      }),
    ]);

    const client = new DiscordClient({ token: "bot-token", fetchFn });

    await expect(client.sendMessage("123", "hello")).rejects.toThrow(ChannelError);
  });

  it("throws when token is empty", () => {
    expect(() => new DiscordClient({ token: "   " })).toThrow(ChannelError);
  });
});

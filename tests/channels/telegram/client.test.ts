import { describe, expect, it } from "bun:test";

import { ChannelError } from "../../../src/channels/errors";
import { TelegramClient } from "../../../src/channels/telegram/client";
import type { TelegramApiResponse, TelegramMessage, TelegramUpdate, TelegramUser } from "../../../src/channels/telegram/types";

function createJsonResponse<T>(status: number, body: TelegramApiResponse<T>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function createUser(): TelegramUser {
  return {
    id: 101,
    is_bot: true,
    first_name: "ReinsBot",
    username: "reins_bot",
  };
}

function createMessage(id: number): TelegramMessage {
  return {
    message_id: id,
    date: 1_735_689_600,
    chat: {
      id: 42,
      type: "private",
    },
    text: "hello",
  };
}

function createUpdates(updateId: number): TelegramUpdate[] {
  return [
    {
      update_id: updateId,
      message: createMessage(500 + updateId),
    },
  ];
}

interface FetchMockContext {
  calls: Array<{ url: string; init?: RequestInit }>;
  fetchFn: typeof fetch;
}

function createFetchMock(
  queue: Array<Response | Error | (() => Promise<Response> | Response)>,
): FetchMockContext {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

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

  return { fetchFn, calls };
}

function parseJsonBody(call: { init?: RequestInit }): Record<string, unknown> {
  const body = call.init?.body;
  expect(typeof body).toBe("string");
  return JSON.parse(body as string) as Record<string, unknown>;
}

describe("TelegramClient", () => {
  it("validates bot token using getMe", async () => {
    const user = createUser();
    const { fetchFn, calls } = createFetchMock([createJsonResponse(200, { ok: true, result: user })]);

    const client = new TelegramClient({ token: "123:abc", fetchFn });
    const result = await client.getMe();

    expect(result).toEqual(user);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:abc/getMe");
    expect(calls[0]!.init?.method).toBe("GET");
  });

  it("long-polls getUpdates with offset and timeout", async () => {
    const updates = createUpdates(9001);
    const { fetchFn, calls } = createFetchMock([createJsonResponse(200, { ok: true, result: updates })]);

    const client = new TelegramClient({ token: "123:abc", fetchFn, pollTimeoutSeconds: 45 });
    const result = await client.getUpdates(9001);

    expect(result).toEqual(updates);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:abc/getUpdates");
    expect(calls[0]!.init?.method).toBe("POST");
    const requestBody = parseJsonBody(calls[0]!);
    expect(requestBody.offset).toBe(9001);
    expect(requestBody.timeout).toBe(45);
  });

  it("sends text messages with optional fields", async () => {
    const message = createMessage(1);
    const { fetchFn, calls } = createFetchMock([createJsonResponse(200, { ok: true, result: message })]);
    const client = new TelegramClient({ token: "123:abc", fetchFn });

    const sent = await client.sendMessage(42, "hello", {
      parseMode: "MarkdownV2",
      disableNotification: true,
      disableWebPagePreview: true,
      replyToMessageId: 7,
    });

    expect(sent).toEqual(message);
    const requestBody = parseJsonBody(calls[0]!);
    expect(requestBody.chat_id).toBe(42);
    expect(requestBody.text).toBe("hello");
    expect(requestBody.parse_mode).toBe("MarkdownV2");
    expect(requestBody.disable_notification).toBe(true);
    expect(requestBody.disable_web_page_preview).toBe(true);
    expect(requestBody.reply_to_message_id).toBe(7);
  });

  it("sends photo, document, and voice messages", async () => {
    const first = createMessage(11);
    const second = createMessage(12);
    const third = createMessage(13);
    const { fetchFn, calls } = createFetchMock([
      createJsonResponse(200, { ok: true, result: first }),
      createJsonResponse(200, { ok: true, result: second }),
      createJsonResponse(200, { ok: true, result: third }),
    ]);

    const client = new TelegramClient({ token: "123:abc", fetchFn });

    await client.sendPhoto(1, "https://example.com/image.png", { caption: "img" });
    await client.sendDocument(2, "file-id-document", { caption: "doc", parseMode: "HTML" });
    await client.sendVoice(3, "file-id-voice", { disableNotification: true });

    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:abc/sendPhoto");
    expect(calls[1]!.url).toBe("https://api.telegram.org/bot123:abc/sendDocument");
    expect(calls[2]!.url).toBe("https://api.telegram.org/bot123:abc/sendVoice");

    const firstBody = parseJsonBody(calls[0]!);
    expect(firstBody.photo).toBe("https://example.com/image.png");

    const secondBody = parseJsonBody(calls[1]!);
    expect(secondBody.document).toBe("file-id-document");
    expect(secondBody.parse_mode).toBe("HTML");

    const thirdBody = parseJsonBody(calls[2]!);
    expect(thirdBody.voice).toBe("file-id-voice");
    expect(thirdBody.disable_notification).toBe(true);
  });

  it("sends typing chat action", async () => {
    const { fetchFn, calls } = createFetchMock([
      createJsonResponse(200, { ok: true, result: true }),
    ]);

    const client = new TelegramClient({ token: "123:abc", fetchFn });
    const result = await client.sendChatAction(42, "typing");

    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:abc/sendChatAction");
    const requestBody = parseJsonBody(calls[0]!);
    expect(requestBody.chat_id).toBe(42);
    expect(requestBody.action).toBe("typing");
  });

  it("retries transient network failures with exponential backoff", async () => {
    const sleepCalls: number[] = [];
    const { fetchFn } = createFetchMock([
      new Error("network down"),
      new Error("still down"),
      createJsonResponse(200, { ok: true, result: createUser() }),
    ]);

    const client = new TelegramClient({
      token: "123:abc",
      fetchFn,
      sleepFn: async (delayMs: number) => {
        sleepCalls.push(delayMs);
      },
    });

    const user = await client.getMe();
    expect(user.username).toBe("reins_bot");
    expect(sleepCalls).toEqual([1_000, 2_000]);
  });

  it("respects retry_after headers and retries 429 responses", async () => {
    const sleepCalls: number[] = [];
    let now = 1_000;

    const { fetchFn } = createFetchMock([
      createJsonResponse(
        429,
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 2 },
        },
        { "retry-after": "2" },
      ),
      () => createJsonResponse(200, { ok: true, result: createUser() }),
    ]);

    const client = new TelegramClient({
      token: "123:abc",
      fetchFn,
      sleepFn: async (delayMs: number) => {
        sleepCalls.push(delayMs);
        now += delayMs;
      },
      nowFn: () => now,
    });

    const user = await client.getMe();
    expect(user.id).toBe(101);
    expect(sleepCalls[0]).toBe(2_000);
  });

  it("throws ChannelError on non-retriable API failures", async () => {
    const { fetchFn } = createFetchMock([
      createJsonResponse(401, {
        ok: false,
        error_code: 401,
        description: "Unauthorized",
      }),
    ]);

    const client = new TelegramClient({ token: "123:abc", fetchFn });

    await expect(client.getMe()).rejects.toThrow(ChannelError);
  });

  it("throws when token is empty", () => {
    expect(() => new TelegramClient({ token: "   " })).toThrow(ChannelError);
  });
});

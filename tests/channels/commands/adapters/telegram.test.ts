import { describe, expect, it } from "bun:test";
import {
  renderCommandResult,
  handleCallbackQuery,
  handleUserMessageForPending,
} from "../../../../src/channels/commands/adapters/telegram";
import type { TelegramCallbackQuery } from "../../../../src/channels/telegram/types";
import type { TelegramClient } from "../../../../src/channels/telegram/client";
import type {
  CommandResult,
  PendingCommandState,
} from "../../../../src/channels/commands/types";
import { PENDING_COMMAND_TTL_MS } from "../../../../src/channels/commands/types";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockClient {
  sentMessages: Array<{ chatId: string | number; text: string; options?: unknown }>;
  answeredCallbacks: string[];
  deletedMessages: Array<{ chatId: string | number; messageId: number }>;
  sendMessage: (chatId: string | number, text: string, options?: unknown) => Promise<void>;
  answerCallbackQuery: (queryId: string) => Promise<void>;
  deleteMessage: (chatId: string | number, messageId: number) => Promise<void>;
}

function makeMockClient(overrides?: Partial<MockClient>): MockClient {
  const client: MockClient = {
    sentMessages: [],
    answeredCallbacks: [],
    deletedMessages: [],
    sendMessage: async (chatId, text, options) => {
      client.sentMessages.push({ chatId, text, options });
    },
    answerCallbackQuery: async (queryId) => {
      client.answeredCallbacks.push(queryId);
    },
    deleteMessage: async (chatId, messageId) => {
      client.deletedMessages.push({ chatId, messageId });
    },
    ...overrides,
  };
  return client;
}

function asTelegramClient(mock: MockClient): TelegramClient {
  return mock as unknown as TelegramClient;
}

function makeCallbackQuery(overrides: Partial<TelegramCallbackQuery> = {}): TelegramCallbackQuery {
  return {
    id: "query-1",
    from: { id: 42, is_bot: false, first_name: "Test" },
    chat_instance: "inst-1",
    message: {
      message_id: 100,
      from: { id: 1, is_bot: false, first_name: "Bot" },
      chat: { id: 99, type: "private" },
      date: 0,
      text: "/connect",
    },
    data: "connect:openai",
    ...overrides,
  };
}

function makePending(overrides: Partial<PendingCommandState> = {}): PendingCommandState {
  return {
    command: "connect",
    step: "awaiting_provider_selection",
    data: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderCommandResult
// ---------------------------------------------------------------------------

describe("renderCommandResult", () => {
  it("sends plain text for a text result", async () => {
    const client = makeMockClient();
    const result: CommandResult = {
      kind: "text",
      text: "All good!",
      success: true,
    };

    await renderCommandResult(result, 99, asTelegramClient(client));

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].chatId).toBe(99);
    expect(client.sentMessages[0].text).toBe("All good!");
    expect(client.sentMessages[0].options).toBeUndefined();
  });

  it("sends inline keyboard for a menu result", async () => {
    const client = makeMockClient();
    const result: CommandResult = {
      kind: "menu",
      text: "Pick a provider:",
      items: [
        { id: "openai", label: "OpenAI" },
        { id: "anthropic", label: "Anthropic" },
      ],
      success: true,
    };

    await renderCommandResult(result, "chat-1", asTelegramClient(client));

    expect(client.sentMessages).toHaveLength(1);
    const msg = client.sentMessages[0];
    expect(msg.chatId).toBe("chat-1");
    expect(msg.text).toBe("Pick a provider:");

    const opts = msg.options as { replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
    expect(opts.replyMarkup.inline_keyboard).toEqual([
      [{ text: "OpenAI", callback_data: "openai" }],
      [{ text: "Anthropic", callback_data: "anthropic" }],
    ]);
  });

  it("sends Yes/No inline keyboard for a confirmation result", async () => {
    const client = makeMockClient();
    const result: CommandResult = {
      kind: "confirmation",
      text: "Disconnect OpenAI?",
      confirmId: "confirm:openai",
      cancelId: "cancel:openai",
      success: true,
    };

    await renderCommandResult(result, 42, asTelegramClient(client));

    expect(client.sentMessages).toHaveLength(1);
    const msg = client.sentMessages[0];
    expect(msg.text).toBe("Disconnect OpenAI?");

    const opts = msg.options as { replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
    expect(opts.replyMarkup.inline_keyboard).toEqual([
      [
        { text: "Yes", callback_data: "confirm:openai" },
        { text: "No", callback_data: "cancel:openai" },
      ],
    ]);
  });
});

// ---------------------------------------------------------------------------
// handleCallbackQuery
// ---------------------------------------------------------------------------

describe("handleCallbackQuery", () => {
  it("answers the callback, dispatches, and renders the result", async () => {
    const client = makeMockClient();
    const query = makeCallbackQuery();
    const dispatched: Array<{ callbackId: string; pending: PendingCommandState | undefined }> = [];

    const onDispatch = async (
      callbackId: string,
      pending: PendingCommandState | undefined,
    ): Promise<CommandResult> => {
      dispatched.push({ callbackId, pending });
      return { kind: "text", text: "Connected!", success: true };
    };

    await handleCallbackQuery(query, undefined, onDispatch, asTelegramClient(client));

    expect(client.answeredCallbacks).toEqual(["query-1"]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].callbackId).toBe("connect:openai");
    expect(dispatched[0].pending).toBeUndefined();
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].text).toBe("Connected!");
  });

  it("sends expiry message when pending state is stale", async () => {
    const client = makeMockClient();
    const query = makeCallbackQuery();
    const stale = makePending({ createdAt: Date.now() - PENDING_COMMAND_TTL_MS - 1 });
    let dispatched = false;

    const onDispatch = async (): Promise<CommandResult> => {
      dispatched = true;
      return { kind: "text", text: "should not reach", success: true };
    };

    await handleCallbackQuery(query, stale, onDispatch, asTelegramClient(client));

    expect(dispatched).toBe(false);
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].text).toBe("Session expired. Please run the command again.");
  });

  it("swallows answerCallbackQuery errors and continues dispatch", async () => {
    const client = makeMockClient({
      answerCallbackQuery: async () => {
        throw new Error("Telegram API error");
      },
    });
    const query = makeCallbackQuery();
    let dispatched = false;

    const onDispatch = async (): Promise<CommandResult> => {
      dispatched = true;
      return { kind: "text", text: "ok", success: true };
    };

    await handleCallbackQuery(query, undefined, onDispatch, asTelegramClient(client));

    expect(dispatched).toBe(true);
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].text).toBe("ok");
  });

  it("sends error message when onDispatch throws", async () => {
    const client = makeMockClient();
    const query = makeCallbackQuery();

    const onDispatch = async (): Promise<CommandResult> => {
      throw new Error("Provider not found");
    };

    await handleCallbackQuery(query, undefined, onDispatch, asTelegramClient(client));

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].text).toBe("Error: Provider not found");
  });

  it("calls deleteMessage when result has deleteUserMessage flag and messageId is present", async () => {
    const client = makeMockClient();
    const query = makeCallbackQuery();

    const onDispatch = async (): Promise<CommandResult> => ({
      kind: "text",
      text: "Key stored!",
      success: true,
      flags: ["deleteUserMessage"],
    });

    await handleCallbackQuery(query, undefined, onDispatch, asTelegramClient(client));

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].text).toBe("Key stored!");
    expect(client.deletedMessages).toHaveLength(1);
    expect(client.deletedMessages[0]).toEqual({ chatId: 99, messageId: 100 });
  });

  it("does not call deleteMessage when result has deleteUserMessage flag but no messageId", async () => {
    const client = makeMockClient();
    const query = makeCallbackQuery({ message: undefined });

    const onDispatch = async (): Promise<CommandResult> => ({
      kind: "text",
      text: "Key stored!",
      success: true,
      flags: ["deleteUserMessage"],
    });

    await handleCallbackQuery(query, undefined, onDispatch, asTelegramClient(client));

    expect(client.sentMessages).toHaveLength(1);
    expect(client.deletedMessages).toHaveLength(0);
  });

  it("swallows deleteMessage errors and completes normally", async () => {
    const client = makeMockClient({
      deleteMessage: async () => {
        throw new Error("Forbidden: message can't be deleted");
      },
    });
    const query = makeCallbackQuery();

    const onDispatch = async (): Promise<CommandResult> => ({
      kind: "text",
      text: "Key stored!",
      success: true,
      flags: ["deleteUserMessage"],
    });

    await handleCallbackQuery(query, undefined, onDispatch, asTelegramClient(client));

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].text).toBe("Key stored!");
  });

  it("skips TTL check and dispatches when pending state is undefined", async () => {
    const client = makeMockClient();
    const query = makeCallbackQuery();
    let dispatched = false;

    const onDispatch = async (
      _callbackId: string,
      pending: PendingCommandState | undefined,
    ): Promise<CommandResult> => {
      dispatched = true;
      expect(pending).toBeUndefined();
      return { kind: "text", text: "Dispatched!", success: true };
    };

    await handleCallbackQuery(query, undefined, onDispatch, asTelegramClient(client));

    expect(dispatched).toBe(true);
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].text).toBe("Dispatched!");
  });

  it("falls back to query.from.id for chatId when query.message is undefined", async () => {
    const client = makeMockClient();
    const query = makeCallbackQuery({ message: undefined });

    const onDispatch = async (): Promise<CommandResult> => ({
      kind: "text",
      text: "Fallback chat",
      success: true,
    });

    await handleCallbackQuery(query, undefined, onDispatch, asTelegramClient(client));

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].chatId).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// handleUserMessageForPending
// ---------------------------------------------------------------------------

describe("handleUserMessageForPending", () => {
  it("calls onReply and renders the result", async () => {
    const client = makeMockClient();
    const pending = makePending();
    const replies: Array<{ text: string; state: PendingCommandState }> = [];

    const onReply = async (
      replyText: string,
      state: PendingCommandState,
    ): Promise<CommandResult> => {
      replies.push({ text: replyText, state });
      return { kind: "text", text: "API key saved!", success: true };
    };

    await handleUserMessageForPending(
      "sk-abc123",
      99,
      200,
      pending,
      onReply,
      asTelegramClient(client),
    );

    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe("sk-abc123");
    expect(replies[0].state).toBe(pending);
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].text).toBe("API key saved!");
  });

  it("sends error message when onReply throws", async () => {
    const client = makeMockClient();
    const pending = makePending();

    const onReply = async (): Promise<CommandResult> => {
      throw new Error("Invalid API key");
    };

    await handleUserMessageForPending(
      "bad-key",
      99,
      200,
      pending,
      onReply,
      asTelegramClient(client),
    );

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].text).toBe("Error: Invalid API key");
  });

  it("calls deleteMessage when result has deleteUserMessage flag", async () => {
    const client = makeMockClient();
    const pending = makePending();

    const onReply = async (): Promise<CommandResult> => ({
      kind: "text",
      text: "Key stored securely.",
      success: true,
      flags: ["deleteUserMessage"],
    });

    await handleUserMessageForPending(
      "sk-secret",
      99,
      200,
      pending,
      onReply,
      asTelegramClient(client),
    );

    expect(client.deletedMessages).toHaveLength(1);
    expect(client.deletedMessages[0]).toEqual({ chatId: 99, messageId: 200 });
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].text).toBe("Key stored securely.");
  });

  it("swallows deleteMessage errors and still renders the result", async () => {
    const client = makeMockClient({
      deleteMessage: async () => {
        throw new Error("Forbidden: message can't be deleted");
      },
    });
    const pending = makePending();

    const onReply = async (): Promise<CommandResult> => ({
      kind: "text",
      text: "Key stored.",
      success: true,
      flags: ["deleteUserMessage"],
    });

    await handleUserMessageForPending(
      "sk-secret",
      99,
      200,
      pending,
      onReply,
      asTelegramClient(client),
    );

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].text).toBe("Key stored.");
  });
});

import { describe, expect, it } from "bun:test";
import {
  renderCommandResult,
  handleNumberReply,
} from "../../../../src/channels/commands/adapters/discord";
import type { DiscordSendFn } from "../../../../src/channels/commands/adapters/discord";
import type {
  CommandMenuItem,
  CommandResult,
  PendingCommandState,
} from "../../../../src/channels/commands/types";
import { PENDING_COMMAND_TTL_MS } from "../../../../src/channels/commands/types";

function makeSendFn(): {
  sentMessages: Array<{ channelId: string; text: string }>;
  fn: DiscordSendFn;
} {
  const sentMessages: Array<{ channelId: string; text: string }> = [];
  const fn: DiscordSendFn = async (channelId, text) => {
    sentMessages.push({ channelId, text });
  };
  return { sentMessages, fn };
}

function makePending(
  overrides: Partial<PendingCommandState> = {},
): PendingCommandState {
  return {
    command: "connect",
    step: "awaiting_provider_selection",
    data: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

const sampleItems: CommandMenuItem[] = [
  {
    id: "connect:openai",
    label: "OpenAI",
    description: "not connected | auth: apikey",
  },
  { id: "connect:fireworks", label: "Fireworks" },
];

describe("renderCommandResult", () => {
  it("sends plain text for a text result", async () => {
    const { sentMessages, fn } = makeSendFn();
    const result: CommandResult = {
      kind: "text",
      text: "Model switched to gpt-4.",
      success: true,
    };

    await renderCommandResult(result, "ch-1", fn);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].channelId).toBe("ch-1");
    expect(sentMessages[0].text).toBe("Model switched to gpt-4.");
  });

  it("sends a numbered menu with header and trailing prompt", async () => {
    const { sentMessages, fn } = makeSendFn();
    const result: CommandResult = {
      kind: "menu",
      text: "Select a provider:",
      items: sampleItems,
      success: true,
    };

    await renderCommandResult(result, "ch-1", fn);

    expect(sentMessages).toHaveLength(1);
    const text = sentMessages[0].text;
    expect(text).toContain("Select a provider:");
    expect(text).toContain(
      "1. **OpenAI** — not connected | auth: apikey",
    );
    expect(text).toContain("2. **Fireworks**");
    expect(text).toContain("Reply with a number to select.");
  });

  it("omits description suffix for menu items without description", async () => {
    const { sentMessages, fn } = makeSendFn();
    const items: CommandMenuItem[] = [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta", description: "has desc" },
    ];
    const result: CommandResult = {
      kind: "menu",
      text: "Pick one:",
      items,
      success: true,
    };

    await renderCommandResult(result, "ch-1", fn);

    const text = sentMessages[0].text;
    expect(text).toContain("1. **Alpha**\n");
    expect(text).not.toContain("1. **Alpha** —");
    expect(text).toContain("2. **Beta** — has desc");
  });

  it("sends confirmation prompt with yes/no instructions", async () => {
    const { sentMessages, fn } = makeSendFn();
    const result: CommandResult = {
      kind: "confirmation",
      text: "Are you sure you want to disconnect?",
      confirmId: "yes",
      cancelId: "no",
      success: true,
    };

    await renderCommandResult(result, "ch-1", fn);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe(
      "Are you sure you want to disconnect?\n\nReply with **yes** or **no**.",
    );
  });
});

describe("handleNumberReply", () => {
  it("sends expiry message when pending state has exceeded TTL", async () => {
    const { sentMessages, fn } = makeSendFn();
    const expired = makePending({
      createdAt: Date.now() - PENDING_COMMAND_TTL_MS - 1,
    });
    const onSelect = async (): Promise<CommandResult> => ({
      kind: "text",
      text: "should not reach",
      success: true,
    });

    await handleNumberReply("1", expired, sampleItems, onSelect, "ch-1", fn);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe(
      "Session expired. Please run the command again.",
    );
  });

  it("does not call onSelect when state is expired", async () => {
    const { fn } = makeSendFn();
    const expired = makePending({
      createdAt: Date.now() - PENDING_COMMAND_TTL_MS - 1,
    });
    let called = false;
    const onSelect = async (): Promise<CommandResult> => {
      called = true;
      return { kind: "text", text: "x", success: true };
    };

    await handleNumberReply("1", expired, sampleItems, onSelect, "ch-1", fn);

    expect(called).toBe(false);
  });

  it("dispatches item[0] when reply is '1'", async () => {
    const { sentMessages, fn } = makeSendFn();
    const pending = makePending();
    let receivedId = "";
    const onSelect = async (id: string): Promise<CommandResult> => {
      receivedId = id;
      return { kind: "text", text: "Connected to OpenAI.", success: true };
    };

    await handleNumberReply("1", pending, sampleItems, onSelect, "ch-1", fn);

    expect(receivedId).toBe("connect:openai");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe("Connected to OpenAI.");
  });

  it("dispatches item[1] when reply is '2'", async () => {
    const { fn } = makeSendFn();
    const pending = makePending();
    let receivedId = "";
    const onSelect = async (id: string): Promise<CommandResult> => {
      receivedId = id;
      return { kind: "text", text: "ok", success: true };
    };

    await handleNumberReply("2", pending, sampleItems, onSelect, "ch-1", fn);

    expect(receivedId).toBe("connect:fireworks");
  });

  it("sends range error for number 0", async () => {
    const { sentMessages, fn } = makeSendFn();
    const pending = makePending();
    let called = false;
    const onSelect = async (): Promise<CommandResult> => {
      called = true;
      return { kind: "text", text: "x", success: true };
    };

    await handleNumberReply("0", pending, sampleItems, onSelect, "ch-1", fn);

    expect(called).toBe(false);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe(
      "Please reply with a number between 1 and 2.",
    );
  });

  it("sends range error for number exceeding items length", async () => {
    const { sentMessages, fn } = makeSendFn();
    const pending = makePending();
    let called = false;
    const onSelect = async (): Promise<CommandResult> => {
      called = true;
      return { kind: "text", text: "x", success: true };
    };

    await handleNumberReply("3", pending, sampleItems, onSelect, "ch-1", fn);

    expect(called).toBe(false);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe(
      "Please reply with a number between 1 and 2.",
    );
  });

  it("sends range error for non-numeric reply", async () => {
    const { sentMessages, fn } = makeSendFn();
    const pending = makePending();
    let called = false;
    const onSelect = async (): Promise<CommandResult> => {
      called = true;
      return { kind: "text", text: "x", success: true };
    };

    await handleNumberReply("abc", pending, sampleItems, onSelect, "ch-1", fn);

    expect(called).toBe(false);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe(
      "Please reply with a number between 1 and 2.",
    );
  });

  it("trims whitespace and correctly parses ' 2 ' as item[1]", async () => {
    const { fn } = makeSendFn();
    const pending = makePending();
    let receivedId = "";
    const onSelect = async (id: string): Promise<CommandResult> => {
      receivedId = id;
      return { kind: "text", text: "ok", success: true };
    };

    await handleNumberReply(
      " 2 ",
      pending,
      sampleItems,
      onSelect,
      "ch-1",
      fn,
    );

    expect(receivedId).toBe("connect:fireworks");
  });

  it("sends error message when onSelect throws", async () => {
    const { sentMessages, fn } = makeSendFn();
    const pending = makePending();
    const onSelect = async (): Promise<CommandResult> => {
      throw new Error("Provider unavailable");
    };

    await handleNumberReply("1", pending, sampleItems, onSelect, "ch-1", fn);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe("Error: Provider unavailable");
  });

  it("renders the result from onSelect via renderCommandResult", async () => {
    const { sentMessages, fn } = makeSendFn();
    const pending = makePending();
    const onSelect = async (): Promise<CommandResult> => ({
      kind: "menu",
      text: "Next step:",
      items: [{ id: "step2", label: "Enter API key" }],
      success: true,
    });

    await handleNumberReply("1", pending, sampleItems, onSelect, "ch-1", fn);

    expect(sentMessages).toHaveLength(1);
    const text = sentMessages[0].text;
    expect(text).toContain("Next step:");
    expect(text).toContain("1. **Enter API key**");
    expect(text).toContain("Reply with a number to select.");
  });
});

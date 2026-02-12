import { describe, expect, it } from "bun:test";

import type { Message } from "../../src/types";
import {
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
} from "../../src/context/tokenizer";

const createMessage = (overrides: Partial<Message> = {}): Message => ({
  id: "msg_1",
  role: "user",
  content: "hello world",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

describe("tokenizer", () => {
  it("estimates token count across different text lengths", () => {
    expect(estimateTokens("hi")).toBe(1);
    expect(estimateTokens("hello world")).toBeGreaterThanOrEqual(2);
    expect(estimateTokens("a".repeat(80))).toBeGreaterThanOrEqual(20);
  });

  it("includes role and content for message token estimation", () => {
    const short = createMessage({ content: "short" });
    const longer = createMessage({ content: "this is a much longer content payload for token estimation" });

    expect(estimateMessageTokens(short)).toBeGreaterThan(5);
    expect(estimateMessageTokens(longer)).toBeGreaterThan(estimateMessageTokens(short));
  });

  it("includes serialized tool calls in message token estimation", () => {
    const withoutToolCalls = createMessage({ content: "run tool" });
    const withToolCalls = createMessage({
      content: "run tool",
      toolCalls: [
        {
          id: "call_1",
          name: "calendar.create",
          arguments: {
            title: "Weekly sync",
            day: "Monday",
          },
        },
      ],
    });

    expect(estimateMessageTokens(withToolCalls)).toBeGreaterThan(estimateMessageTokens(withoutToolCalls));
  });

  it("sums conversation token counts with framing overhead", () => {
    const first = createMessage({ id: "msg_1", content: "first message" });
    const second = createMessage({ id: "msg_2", role: "assistant", content: "second message" });

    const conversationTokens = estimateConversationTokens([first, second]);
    const expectedMinimum = estimateMessageTokens(first) + estimateMessageTokens(second) + 3;

    expect(conversationTokens).toBe(expectedMinimum);
  });

  it("returns minimal tokens for empty text", () => {
    const emptyMessage = createMessage({ content: "" });

    expect(estimateTokens("")).toBe(1);
    expect(estimateMessageTokens(emptyMessage)).toBeGreaterThanOrEqual(6);
    expect(estimateConversationTokens([])).toBe(3);
  });
});

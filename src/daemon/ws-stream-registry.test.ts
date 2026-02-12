import { describe, expect, it } from "bun:test";

import {
  WsStreamRegistry,
  type StreamRegistrySocket,
  type StreamRegistrySocketData,
  toStreamSubscriptionKey,
} from "./ws-stream-registry";

interface TestSocketData extends StreamRegistrySocketData {
  connectionId: string;
}

interface TestSocket extends StreamRegistrySocket<TestSocketData> {
  sent: string[];
}

function createSocket(connectionId: string): TestSocket {
  const sent: string[] = [];
  return {
    data: { connectionId },
    sent,
    send(message: string) {
      sent.push(message);
      return message.length;
    },
  };
}

describe("WsStreamRegistry", () => {
  it("uses conversationId:assistantMessageId key format", () => {
    const key = toStreamSubscriptionKey({
      conversationId: "conv-1",
      assistantMessageId: "asst-1",
    });
    expect(key).toBe("conv-1:asst-1");
  });

  it("delivers published events to multiple subscribers", () => {
    const registry = new WsStreamRegistry<TestSocketData>();
    const first = createSocket("c1");
    const second = createSocket("c2");

    registry.subscribe(first, { conversationId: "conv", assistantMessageId: "msg" });
    registry.subscribe(second, { conversationId: "conv", assistantMessageId: "msg" });

    const delivered = registry.publish(
      { conversationId: "conv", assistantMessageId: "msg" },
      { type: "stream-event", event: { type: "message_start" } },
    );

    expect(delivered).toBe(2);
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
  });

  it("removes socket subscriptions on disconnect", () => {
    const registry = new WsStreamRegistry<TestSocketData>();
    const socket = createSocket("c1");

    registry.subscribe(socket, { conversationId: "conv", assistantMessageId: "msg-1" });
    registry.subscribe(socket, { conversationId: "conv", assistantMessageId: "msg-2" });

    expect(registry.getSubscriptionCount()).toBe(2);

    registry.removeConnection(socket);

    expect(registry.getSubscriptionCount()).toBe(0);
    const delivered = registry.publish(
      { conversationId: "conv", assistantMessageId: "msg-1" },
      { type: "stream-event", event: { type: "content_chunk" } },
    );
    expect(delivered).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";

import {
  deliverHeartbeatResult,
  type HeartbeatDeliveryReport,
  type HeartbeatResultForDelivery,
} from "../../src/heartbeat/delivery";
import { ChannelRegistry } from "../../src/channels/registry";
import type {
  Channel,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
} from "../../src/channels/types";
import type { HeartbeatProcessedOutput } from "../../src/heartbeat/handler";

const FIXED_TIME = new Date("2026-02-19T09:30:00.000Z");

function createMockChannel(
  id: string,
  platform: "telegram" | "discord" = "telegram",
  options?: {
    enabled?: boolean;
    sendFn?: (message: ChannelMessage) => Promise<void>;
  },
): Channel & { sentMessages: ChannelMessage[] } {
  const sentMessages: ChannelMessage[] = [];

  return {
    sentMessages,
    config: {
      id,
      platform,
      tokenReference: `token-ref-${id}`,
      enabled: options?.enabled ?? true,
    } as ChannelConfig,
    status: {
      state: "connected",
      uptimeMs: 1000,
    } as ChannelStatus,
    connect: async () => {},
    disconnect: async () => {},
    send:
      options?.sendFn ??
      (async (message: ChannelMessage) => {
        sentMessages.push(message);
      }),
    onMessage: (_handler: ChannelMessageHandler) => () => {},
  };
}

function createHeartbeatOutput(
  content: string,
  shouldDeliver = true,
): HeartbeatProcessedOutput {
  return {
    content,
    shouldDeliver,
    reason: shouldDeliver ? "delivered" : "ack_suppressed",
  };
}

function createHeartbeatResult(
  routineName: string,
  content: string,
): HeartbeatResultForDelivery {
  return {
    routineName,
    output: createHeartbeatOutput(content),
  };
}

describe("deliverHeartbeatResult", () => {
  describe("channel delivery", () => {
    test("delivers result to a single enabled channel", async () => {
      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const result = createHeartbeatResult(
        "Morning Kickoff",
        "3 tasks due today, 1 meeting at 2pm",
      );

      const report = await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      expect(report.delivered).toBe(true);
      expect(report.method).toBe("channel");
      expect(report.successCount).toBe(1);
      expect(report.failureCount).toBe(0);
      expect(report.channelResults).toHaveLength(1);
      expect(report.channelResults[0].channelId).toBe("ch-1");
      expect(report.channelResults[0].success).toBe(true);
      expect(channel.sentMessages).toHaveLength(1);
    });

    test("delivers result to multiple enabled channels", async () => {
      const channel1 = createMockChannel("ch-1", "telegram");
      const channel2 = createMockChannel("ch-2", "discord");
      const registry = new ChannelRegistry();
      registry.register(channel1);
      registry.register(channel2);

      const result = createHeartbeatResult(
        "Evening Wind-Down",
        "All tasks completed today",
      );

      const report = await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      expect(report.delivered).toBe(true);
      expect(report.method).toBe("channel");
      expect(report.successCount).toBe(2);
      expect(report.failureCount).toBe(0);
      expect(report.channelResults).toHaveLength(2);
      expect(channel1.sentMessages).toHaveLength(1);
      expect(channel2.sentMessages).toHaveLength(1);
    });

    test("message text includes routine name and content", async () => {
      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const result = createHeartbeatResult(
        "Morning Kickoff",
        "3 tasks due today",
      );

      await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      const sentMessage = channel.sentMessages[0];
      expect(sentMessage.text).toContain("Morning Kickoff");
      expect(sentMessage.text).toContain("3 tasks due today");
    });

    test("message uses reins-system sender with isBot flag", async () => {
      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const result = createHeartbeatResult("Test Routine", "test content");

      await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      const sentMessage = channel.sentMessages[0];
      expect(sentMessage.sender.id).toBe("reins-system");
      expect(sentMessage.sender.displayName).toBe("Reins");
      expect(sentMessage.sender.isBot).toBe(true);
    });

    test("message includes correct platform and channelId", async () => {
      const channel = createMockChannel("ch-discord", "discord");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const result = createHeartbeatResult("Test Routine", "test content");

      await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      const sentMessage = channel.sentMessages[0];
      expect(sentMessage.platform).toBe("discord");
      expect(sentMessage.channelId).toBe("ch-discord");
    });

    test("message has a unique id", async () => {
      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const result = createHeartbeatResult("Test Routine", "test content");

      await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      const sentMessage = channel.sentMessages[0];
      expect(sentMessage.id).toBeDefined();
      expect(typeof sentMessage.id).toBe("string");
      expect(sentMessage.id.length).toBeGreaterThan(0);
    });

    test("message timestamp matches provided now()", async () => {
      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const result = createHeartbeatResult("Test Routine", "test content");

      await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      const sentMessage = channel.sentMessages[0];
      expect(sentMessage.timestamp).toEqual(FIXED_TIME);
    });
  });

  describe("disabled channels", () => {
    test("skips disabled channels", async () => {
      const enabledChannel = createMockChannel("ch-enabled");
      const disabledChannel = createMockChannel("ch-disabled", "telegram", {
        enabled: false,
      });
      const registry = new ChannelRegistry();
      registry.register(enabledChannel);
      registry.register(disabledChannel);

      const result = createHeartbeatResult("Test Routine", "test content");

      const report = await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      expect(report.successCount).toBe(1);
      expect(report.channelResults).toHaveLength(1);
      expect(report.channelResults[0].channelId).toBe("ch-enabled");
      expect(enabledChannel.sentMessages).toHaveLength(1);
      expect(disabledChannel.sentMessages).toHaveLength(0);
    });

    test("all disabled channels falls back to TUI method", async () => {
      const disabledChannel = createMockChannel("ch-disabled", "telegram", {
        enabled: false,
      });
      const registry = new ChannelRegistry();
      registry.register(disabledChannel);

      const result = createHeartbeatResult("Test Routine", "test content");

      const report = await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      expect(report.delivered).toBe(false);
      expect(report.method).toBe("tui");
      expect(report.channelResults).toHaveLength(0);
    });
  });

  describe("TUI fallback", () => {
    test("returns TUI method when no channels registered", async () => {
      const registry = new ChannelRegistry();

      const result = createHeartbeatResult(
        "Morning Kickoff",
        "3 tasks due today",
      );

      const report = await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      expect(report.delivered).toBe(false);
      expect(report.method).toBe("tui");
      expect(report.channelResults).toHaveLength(0);
      expect(report.successCount).toBe(0);
      expect(report.failureCount).toBe(0);
      expect(report.timestamp).toEqual(FIXED_TIME);
    });

    test("logs info message when falling back to TUI", async () => {
      const registry = new ChannelRegistry();
      const loggedMessages: Array<{ message: string; context?: Record<string, unknown> }> = [];

      const result = createHeartbeatResult("Morning Kickoff", "test content");

      await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
        logger: {
          info: (message, context) => {
            loggedMessages.push({ message, context });
          },
          error: () => {},
        },
      });

      expect(loggedMessages).toHaveLength(1);
      expect(loggedMessages[0].message).toContain("No enabled channels");
      expect(loggedMessages[0].context?.routineName).toBe("Morning Kickoff");
    });
  });

  describe("error handling", () => {
    test("catches per-channel send errors without blocking others", async () => {
      const failingChannel = createMockChannel("ch-fail", "telegram", {
        sendFn: async () => {
          throw new Error("Network timeout");
        },
      });
      const successChannel = createMockChannel("ch-ok", "discord");
      const registry = new ChannelRegistry();
      registry.register(failingChannel);
      registry.register(successChannel);

      const result = createHeartbeatResult("Test Routine", "test content");

      const report = await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      expect(report.delivered).toBe(true);
      expect(report.successCount).toBe(1);
      expect(report.failureCount).toBe(1);
      expect(report.channelResults).toHaveLength(2);

      const failResult = report.channelResults.find((r) => r.channelId === "ch-fail");
      expect(failResult?.success).toBe(false);
      expect(failResult?.error).toBe("Network timeout");

      const okResult = report.channelResults.find((r) => r.channelId === "ch-ok");
      expect(okResult?.success).toBe(true);

      expect(successChannel.sentMessages).toHaveLength(1);
    });

    test("all channels failing results in delivered=false", async () => {
      const failChannel1 = createMockChannel("ch-fail-1", "telegram", {
        sendFn: async () => {
          throw new Error("Timeout");
        },
      });
      const failChannel2 = createMockChannel("ch-fail-2", "discord", {
        sendFn: async () => {
          throw new Error("Connection refused");
        },
      });
      const registry = new ChannelRegistry();
      registry.register(failChannel1);
      registry.register(failChannel2);

      const result = createHeartbeatResult("Test Routine", "test content");

      const report = await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      expect(report.delivered).toBe(false);
      expect(report.method).toBe("channel");
      expect(report.successCount).toBe(0);
      expect(report.failureCount).toBe(2);
    });

    test("logs error for each failed channel delivery", async () => {
      const failingChannel = createMockChannel("ch-fail", "telegram", {
        sendFn: async () => {
          throw new Error("Send failed");
        },
      });
      const registry = new ChannelRegistry();
      registry.register(failingChannel);

      const loggedErrors: Array<{ message: string; context?: Record<string, unknown> }> = [];

      const result = createHeartbeatResult("Morning Kickoff", "test content");

      await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
        logger: {
          info: () => {},
          error: (message, context) => {
            loggedErrors.push({ message, context });
          },
        },
      });

      expect(loggedErrors).toHaveLength(1);
      expect(loggedErrors[0].message).toContain("Heartbeat delivery failed");
      expect(loggedErrors[0].context?.channelId).toBe("ch-fail");
      expect(loggedErrors[0].context?.routineName).toBe("Morning Kickoff");
      expect(loggedErrors[0].context?.error).toBe("Send failed");
    });

    test("handles non-Error throw from channel send", async () => {
      const failingChannel = createMockChannel("ch-fail", "telegram", {
        sendFn: async () => {
          throw "string error";
        },
      });
      const registry = new ChannelRegistry();
      registry.register(failingChannel);

      const result = createHeartbeatResult("Test Routine", "test content");

      const report = await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      expect(report.channelResults[0].success).toBe(false);
      expect(report.channelResults[0].error).toBe("string error");
    });
  });

  describe("report structure", () => {
    test("report timestamp uses provided now()", async () => {
      const registry = new ChannelRegistry();
      const result = createHeartbeatResult("Test Routine", "test content");

      const report = await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      expect(report.timestamp).toEqual(FIXED_TIME);
    });

    test("report uses current time when no now() provided", async () => {
      const registry = new ChannelRegistry();
      const result = createHeartbeatResult("Test Routine", "test content");

      const before = new Date();
      const report = await deliverHeartbeatResult(result, registry);
      const after = new Date();

      expect(report.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(report.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    test("channel results include platform information", async () => {
      const telegramChannel = createMockChannel("ch-tg", "telegram");
      const discordChannel = createMockChannel("ch-dc", "discord");
      const registry = new ChannelRegistry();
      registry.register(telegramChannel);
      registry.register(discordChannel);

      const result = createHeartbeatResult("Test Routine", "test content");

      const report = await deliverHeartbeatResult(result, registry, {
        now: () => FIXED_TIME,
      });

      const tgResult = report.channelResults.find((r) => r.channelId === "ch-tg");
      expect(tgResult?.platform).toBe("telegram");

      const dcResult = report.channelResults.find((r) => r.channelId === "ch-dc");
      expect(dcResult?.platform).toBe("discord");
    });
  });
});

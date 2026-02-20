import { describe, expect, test } from "bun:test";

import {
  deliverBriefing,
  type DeliveryReport,
} from "../../../src/memory/proactive/briefing-delivery";
import type {
  FormattedBriefing,
  FormattedBriefingMessage,
} from "../../../src/cron/jobs/morning-briefing-job";
import { ChannelRegistry } from "../../../src/channels/registry";
import type {
  Channel,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
} from "../../../src/channels/types";

const FIXED_TIME = new Date("2026-02-19T08:00:00.000Z");

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
    send: options?.sendFn ?? (async (message: ChannelMessage) => {
      sentMessages.push(message);
    }),
    onMessage: (_handler: ChannelMessageHandler) => () => {},
  };
}

function createFormattedBriefing(
  messages: FormattedBriefingMessage[],
  overrides?: Partial<FormattedBriefing>,
): FormattedBriefing {
  return {
    messages,
    totalItems: overrides?.totalItems ?? messages.length,
    timestamp: overrides?.timestamp ?? FIXED_TIME,
    isEmpty: overrides?.isEmpty ?? messages.length === 0,
  };
}

function createSectionMessage(
  sectionType: string,
  text?: string,
): FormattedBriefingMessage {
  return {
    sectionType,
    text: text ?? `Content for ${sectionType}`,
  };
}

describe("deliverBriefing", () => {
  describe("successful delivery", () => {
    test("delivers all section messages to a single channel", async () => {
      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads", "Thread updates"),
        createSectionMessage("high_importance", "Important items"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.totalChannels).toBe(1);
      expect(report.successCount).toBe(1);
      expect(report.failureCount).toBe(0);
      expect(report.channels).toHaveLength(1);
      expect(report.channels[0].channelId).toBe("ch-1");
      expect(report.channels[0].success).toBe(true);
      expect(report.channels[0].messagesSent).toBe(2);
      expect(channel.sentMessages).toHaveLength(2);
    });

    test("delivers to multiple channels", async () => {
      const channel1 = createMockChannel("ch-1", "telegram");
      const channel2 = createMockChannel("ch-2", "discord");
      const registry = new ChannelRegistry();
      registry.register(channel1);
      registry.register(channel2);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.totalChannels).toBe(2);
      expect(report.successCount).toBe(2);
      expect(report.failureCount).toBe(0);
      expect(channel1.sentMessages).toHaveLength(1);
      expect(channel2.sentMessages).toHaveLength(1);
    });

    test("sends messages with correct channel message structure", async () => {
      const channel = createMockChannel("ch-1", "telegram");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads", "Thread content here"),
      ]);

      await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(channel.sentMessages).toHaveLength(1);
      const sent = channel.sentMessages[0];
      expect(sent.text).toBe("Thread content here");
      expect(sent.platform).toBe("telegram");
      expect(sent.channelId).toBe("ch-1");
      expect(sent.sender.id).toBe("reins-system");
      expect(sent.sender.isBot).toBe(true);
      expect(sent.timestamp).toEqual(FIXED_TIME);
      expect(sent.id).toBeDefined();
    });

    test("delivers empty briefing message", async () => {
      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const briefing = createFormattedBriefing(
        [createSectionMessage("empty", "Good morning! Nothing to report today.")],
        { isEmpty: true, totalItems: 0 },
      );

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.successCount).toBe(1);
      expect(channel.sentMessages).toHaveLength(1);
      expect(channel.sentMessages[0].text).toBe("Good morning! Nothing to report today.");
    });
  });

  describe("section ordering", () => {
    test("sends sections in canonical order: open_threads → high_importance → recent_decisions → upcoming", async () => {
      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      // Provide sections in reverse order to verify sorting
      const briefing = createFormattedBriefing([
        createSectionMessage("upcoming", "Upcoming events"),
        createSectionMessage("open_threads", "Open threads"),
        createSectionMessage("recent_decisions", "Recent decisions"),
        createSectionMessage("high_importance", "High importance"),
      ]);

      await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(channel.sentMessages).toHaveLength(4);
      expect(channel.sentMessages[0].text).toBe("Open threads");
      expect(channel.sentMessages[1].text).toBe("High importance");
      expect(channel.sentMessages[2].text).toBe("Recent decisions");
      expect(channel.sentMessages[3].text).toBe("Upcoming events");
    });

    test("unknown section types are appended after known types", async () => {
      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const briefing = createFormattedBriefing([
        createSectionMessage("custom_section", "Custom content"),
        createSectionMessage("open_threads", "Open threads"),
      ]);

      await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(channel.sentMessages).toHaveLength(2);
      expect(channel.sentMessages[0].text).toBe("Open threads");
      expect(channel.sentMessages[1].text).toBe("Custom content");
    });
  });

  describe("partial failure", () => {
    test("one channel failure does not block delivery to other channels", async () => {
      const failingChannel = createMockChannel("ch-fail", "telegram", {
        sendFn: async () => {
          throw new Error("Network timeout");
        },
      });
      const successChannel = createMockChannel("ch-ok", "discord");
      const registry = new ChannelRegistry();
      registry.register(failingChannel);
      registry.register(successChannel);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.totalChannels).toBe(2);
      expect(report.successCount).toBe(1);
      expect(report.failureCount).toBe(1);

      const failResult = report.channels.find((c) => c.channelId === "ch-fail");
      expect(failResult?.success).toBe(false);
      expect(failResult?.error).toBe("Network timeout");
      expect(failResult?.messagesSent).toBe(0);

      const okResult = report.channels.find((c) => c.channelId === "ch-ok");
      expect(okResult?.success).toBe(true);
      expect(okResult?.messagesSent).toBe(1);
    });

    test("channel failure mid-delivery reports partial message count", async () => {
      let callCount = 0;
      const partialChannel = createMockChannel("ch-partial", "telegram", {
        sendFn: async () => {
          callCount += 1;
          if (callCount === 2) {
            throw new Error("Connection lost");
          }
        },
      });
      const registry = new ChannelRegistry();
      registry.register(partialChannel);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
        createSectionMessage("high_importance"),
        createSectionMessage("recent_decisions"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.failureCount).toBe(1);
      const result = report.channels[0];
      expect(result.success).toBe(false);
      expect(result.messagesSent).toBe(1);
      expect(result.error).toBe("Connection lost");
    });

    test("all channels failing returns all-failure report", async () => {
      const fail1 = createMockChannel("ch-1", "telegram", {
        sendFn: async () => { throw new Error("Fail 1"); },
      });
      const fail2 = createMockChannel("ch-2", "discord", {
        sendFn: async () => { throw new Error("Fail 2"); },
      });
      const registry = new ChannelRegistry();
      registry.register(fail1);
      registry.register(fail2);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.totalChannels).toBe(2);
      expect(report.successCount).toBe(0);
      expect(report.failureCount).toBe(2);
      expect(report.channels[0].error).toBe("Fail 1");
      expect(report.channels[1].error).toBe("Fail 2");
    });

    test("non-Error thrown values are stringified in error field", async () => {
      const channel = createMockChannel("ch-1", "telegram", {
        sendFn: async () => {
          throw "string error";
        },
      });
      const registry = new ChannelRegistry();
      registry.register(channel);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.channels[0].success).toBe(false);
      expect(report.channels[0].error).toBe("string error");
    });
  });

  describe("empty channel list", () => {
    test("returns zero-channel report when no channels registered", async () => {
      const registry = new ChannelRegistry();

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.totalChannels).toBe(0);
      expect(report.successCount).toBe(0);
      expect(report.failureCount).toBe(0);
      expect(report.channels).toHaveLength(0);
    });

    test("skips disabled channels", async () => {
      const disabledChannel = createMockChannel("ch-disabled", "telegram", { enabled: false });
      const enabledChannel = createMockChannel("ch-enabled", "discord");
      const registry = new ChannelRegistry();
      registry.register(disabledChannel);
      registry.register(enabledChannel);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.totalChannels).toBe(1);
      expect(report.successCount).toBe(1);
      expect(report.channels).toHaveLength(1);
      expect(report.channels[0].channelId).toBe("ch-enabled");
    });

    test("all channels disabled returns zero-channel report", async () => {
      const ch1 = createMockChannel("ch-1", "telegram", { enabled: false });
      const ch2 = createMockChannel("ch-2", "discord", { enabled: false });
      const registry = new ChannelRegistry();
      registry.register(ch1);
      registry.register(ch2);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.totalChannels).toBe(0);
      expect(report.successCount).toBe(0);
      expect(report.channels).toHaveLength(0);
    });
  });

  describe("multiple sections", () => {
    test("delivers all four standard sections to each channel", async () => {
      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads", "Threads"),
        createSectionMessage("high_importance", "Important"),
        createSectionMessage("recent_decisions", "Decisions"),
        createSectionMessage("upcoming", "Upcoming"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.channels[0].messagesSent).toBe(4);
      expect(channel.sentMessages).toHaveLength(4);
    });

    test("delivers all sections to all channels independently", async () => {
      const ch1 = createMockChannel("ch-1", "telegram");
      const ch2 = createMockChannel("ch-2", "discord");
      const registry = new ChannelRegistry();
      registry.register(ch1);
      registry.register(ch2);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads", "Threads"),
        createSectionMessage("high_importance", "Important"),
        createSectionMessage("recent_decisions", "Decisions"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.totalChannels).toBe(2);
      expect(report.successCount).toBe(2);
      expect(ch1.sentMessages).toHaveLength(3);
      expect(ch2.sentMessages).toHaveLength(3);
      // Both channels receive same content
      expect(ch1.sentMessages[0].text).toBe("Threads");
      expect(ch2.sentMessages[0].text).toBe("Threads");
    });

    test("single section briefing delivers one message per channel", async () => {
      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const briefing = createFormattedBriefing([
        createSectionMessage("high_importance", "Urgent item"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.channels[0].messagesSent).toBe(1);
      expect(channel.sentMessages[0].text).toBe("Urgent item");
    });
  });

  describe("delivery report structure", () => {
    test("report includes timestamp", async () => {
      const registry = new ChannelRegistry();
      const briefing = createFormattedBriefing([]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.timestamp).toEqual(FIXED_TIME);
    });

    test("report includes platform in per-channel results", async () => {
      const telegramChannel = createMockChannel("ch-tg", "telegram");
      const discordChannel = createMockChannel("ch-dc", "discord");
      const registry = new ChannelRegistry();
      registry.register(telegramChannel);
      registry.register(discordChannel);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      const tgResult = report.channels.find((c) => c.channelId === "ch-tg");
      const dcResult = report.channels.find((c) => c.channelId === "ch-dc");
      expect(tgResult?.platform).toBe("telegram");
      expect(dcResult?.platform).toBe("discord");
    });

    test("successful delivery has no error field", async () => {
      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
      ]);

      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.channels[0].error).toBeUndefined();
    });
  });

  describe("logger integration", () => {
    test("logs error when channel delivery fails", async () => {
      const loggedErrors: Array<{ message: string; context?: Record<string, unknown> }> = [];
      const logger = {
        error: (message: string, context?: Record<string, unknown>) => {
          loggedErrors.push({ message, context });
        },
      };

      const failChannel = createMockChannel("ch-fail", "telegram", {
        sendFn: async () => { throw new Error("Send failed"); },
      });
      const registry = new ChannelRegistry();
      registry.register(failChannel);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
      ]);

      await deliverBriefing(briefing, registry, { now: () => FIXED_TIME, logger });

      expect(loggedErrors).toHaveLength(1);
      expect(loggedErrors[0].message).toBe("Briefing delivery failed for channel");
      expect(loggedErrors[0].context?.channelId).toBe("ch-fail");
      expect(loggedErrors[0].context?.error).toBe("Send failed");
    });

    test("does not log when delivery succeeds", async () => {
      const loggedErrors: Array<{ message: string }> = [];
      const logger = {
        error: (message: string) => { loggedErrors.push({ message }); },
      };

      const channel = createMockChannel("ch-1");
      const registry = new ChannelRegistry();
      registry.register(channel);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
      ]);

      await deliverBriefing(briefing, registry, { now: () => FIXED_TIME, logger });

      expect(loggedErrors).toHaveLength(0);
    });

    test("works without logger option", async () => {
      const failChannel = createMockChannel("ch-fail", "telegram", {
        sendFn: async () => { throw new Error("No logger"); },
      });
      const registry = new ChannelRegistry();
      registry.register(failChannel);

      const briefing = createFormattedBriefing([
        createSectionMessage("open_threads"),
      ]);

      // Should not throw even without logger
      const report = await deliverBriefing(briefing, registry, { now: () => FIXED_TIME });

      expect(report.failureCount).toBe(1);
    });
  });
});

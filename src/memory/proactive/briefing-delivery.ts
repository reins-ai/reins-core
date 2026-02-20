import type { FormattedBriefing, FormattedBriefingMessage } from "../../cron/jobs/morning-briefing-job";
import type { Channel, ChannelMessage } from "../../channels/types";
import type { ChannelRegistry } from "../../channels/registry";

/**
 * Per-channel delivery outcome.
 */
export interface ChannelDeliveryResult {
  channelId: string;
  platform: string;
  success: boolean;
  messagesSent: number;
  error?: string;
}

/**
 * Aggregate delivery report for a briefing.
 */
export interface DeliveryReport {
  totalChannels: number;
  successCount: number;
  failureCount: number;
  channels: ChannelDeliveryResult[];
  timestamp: Date;
}

/**
 * Options for briefing delivery.
 */
export interface DeliverBriefingOptions {
  now?: () => Date;
  logger?: {
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

/**
 * Section delivery order per D-W3-2 decision.
 * Messages are sent in this order: open_threads → high_importance → recent_decisions → upcoming.
 * Any other section types (including "empty") are appended at the end.
 */
const SECTION_ORDER: readonly string[] = [
  "open_threads",
  "high_importance",
  "recent_decisions",
  "upcoming",
];

function sectionSortKey(sectionType: string): number {
  const index = SECTION_ORDER.indexOf(sectionType);
  return index === -1 ? SECTION_ORDER.length : index;
}

function orderMessages(messages: FormattedBriefingMessage[]): FormattedBriefingMessage[] {
  return [...messages].sort(
    (a, b) => sectionSortKey(a.sectionType) - sectionSortKey(b.sectionType),
  );
}

function buildChannelMessage(
  text: string,
  channel: Channel,
  timestamp: Date,
): ChannelMessage {
  return {
    id: crypto.randomUUID(),
    platform: channel.config.platform,
    channelId: channel.config.id,
    sender: {
      id: "reins-system",
      displayName: "Reins",
      isBot: true,
    },
    timestamp,
    text,
  };
}

/**
 * Delivers a formatted briefing to all channels registered in the ChannelRegistry.
 *
 * Each briefing section is sent as a separate message (per D-W3-2 decision) in the
 * canonical order: open_threads → high_importance → recent_decisions → upcoming.
 *
 * Per-channel errors are caught and logged — one channel failing does not block
 * delivery to other channels.
 */
export async function deliverBriefing(
  briefing: FormattedBriefing,
  channelRegistry: ChannelRegistry,
  options?: DeliverBriefingOptions,
): Promise<DeliveryReport> {
  const now = options?.now ?? (() => new Date());
  const logger = options?.logger;
  const channels = channelRegistry.list();
  const enabledChannels = channels.filter((ch) => ch.config.enabled);
  const orderedMessages = orderMessages(briefing.messages);
  const results: ChannelDeliveryResult[] = [];

  for (const channel of enabledChannels) {
    const result = await deliverToChannel(channel, orderedMessages, now(), logger);
    results.push(result);
  }

  const successCount = results.filter((r) => r.success).length;

  return {
    totalChannels: enabledChannels.length,
    successCount,
    failureCount: enabledChannels.length - successCount,
    channels: results,
    timestamp: now(),
  };
}

async function deliverToChannel(
  channel: Channel,
  messages: FormattedBriefingMessage[],
  timestamp: Date,
  logger?: DeliverBriefingOptions["logger"],
): Promise<ChannelDeliveryResult> {
  let messagesSent = 0;

  try {
    for (const message of messages) {
      const channelMessage = buildChannelMessage(message.text, channel, timestamp);
      await channel.send(channelMessage);
      messagesSent += 1;
    }

    return {
      channelId: channel.config.id,
      platform: channel.config.platform,
      success: true,
      messagesSent,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger?.error("Briefing delivery failed for channel", {
      channelId: channel.config.id,
      platform: channel.config.platform,
      messagesSent,
      error: errorMessage,
    });

    return {
      channelId: channel.config.id,
      platform: channel.config.platform,
      success: false,
      messagesSent,
      error: errorMessage,
    };
  }
}

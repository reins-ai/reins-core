import type { Channel, ChannelMessage } from "../channels/types";
import type { ChannelRegistry } from "../channels/registry";
import type { HeartbeatProcessedOutput } from "./handler";

/**
 * Per-channel delivery outcome for a heartbeat result.
 */
export interface HeartbeatChannelDeliveryResult {
  channelId: string;
  platform: string;
  success: boolean;
  error?: string;
}

/**
 * Aggregate delivery report for a heartbeat result.
 */
export interface HeartbeatDeliveryReport {
  delivered: boolean;
  method: "channel" | "tui";
  channelResults: HeartbeatChannelDeliveryResult[];
  successCount: number;
  failureCount: number;
  timestamp: Date;
}

/**
 * Heartbeat result with routine context for delivery.
 */
export interface HeartbeatResultForDelivery {
  routineName: string;
  output: HeartbeatProcessedOutput;
}

/**
 * Options for heartbeat delivery.
 */
export interface DeliverHeartbeatOptions {
  now?: () => Date;
  logger?: {
    error: (message: string, context?: Record<string, unknown>) => void;
    info: (message: string, context?: Record<string, unknown>) => void;
  };
}

function buildHeartbeatChannelMessage(
  routineName: string,
  content: string,
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
    text: `**Heartbeat: ${routineName}**\n\n${content}`,
  };
}

async function deliverToChannel(
  channel: Channel,
  routineName: string,
  content: string,
  timestamp: Date,
  logger?: DeliverHeartbeatOptions["logger"],
): Promise<HeartbeatChannelDeliveryResult> {
  try {
    const message = buildHeartbeatChannelMessage(routineName, content, channel, timestamp);
    await channel.send(message);

    return {
      channelId: channel.config.id,
      platform: channel.config.platform,
      success: true,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger?.error("Heartbeat delivery failed for channel", {
      channelId: channel.config.id,
      platform: channel.config.platform,
      routineName,
      error: errorMessage,
    });

    return {
      channelId: channel.config.id,
      platform: channel.config.platform,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Delivers a heartbeat execution result to all enabled channels via ChannelRegistry.
 *
 * If channels are available, sends the result to each enabled channel. Per-channel
 * errors are caught and logged — one channel failing does not block delivery to others.
 *
 * If no enabled channels are available, returns a TUI-method report so the caller
 * can queue the result for TUI display.
 */
export async function deliverHeartbeatResult(
  result: HeartbeatResultForDelivery,
  channelRegistry: ChannelRegistry,
  options?: DeliverHeartbeatOptions,
): Promise<HeartbeatDeliveryReport> {
  const now = options?.now ?? (() => new Date());
  const logger = options?.logger;
  const channels = channelRegistry.list();
  const enabledChannels = channels.filter((ch) => ch.config.enabled);

  if (enabledChannels.length === 0) {
    logger?.info("No enabled channels for heartbeat delivery; queuing for TUI", {
      routineName: result.routineName,
    });

    return {
      delivered: false,
      method: "tui",
      channelResults: [],
      successCount: 0,
      failureCount: 0,
      timestamp: now(),
    };
  }

  const channelResults: HeartbeatChannelDeliveryResult[] = [];

  for (const channel of enabledChannels) {
    const channelResult = await deliverToChannel(
      channel,
      result.routineName,
      result.output.content,
      now(),
      logger,
    );
    channelResults.push(channelResult);
  }

  const successCount = channelResults.filter((r) => r.success).length;

  return {
    delivered: successCount > 0,
    method: "channel",
    channelResults,
    successCount,
    failureCount: enabledChannels.length - successCount,
    timestamp: now(),
  };
}

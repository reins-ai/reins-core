import type { ConversationManager } from "../conversation/manager";
import type { WatcherDiff } from "./types";

/**
 * Decoupled notification delivery interface for watcher change alerts.
 * Implementations inject notifications into the appropriate destination
 * (e.g., active conversation, daemon log) without coupling the watcher
 * system to the conversation layer.
 */
export interface NotificationDelivery {
  sendWatcherNotification(watcherId: string, url: string, diff: WatcherDiff): Promise<void>;
}

const MAX_DIFF_CONTENT_LENGTH = 500;

/**
 * Format a watcher diff into a human-readable notification message.
 */
export function formatWatcherNotification(
  watcherId: string,
  url: string,
  diff: WatcherDiff,
): string {
  const timestamp = new Date(diff.timestamp).toISOString();
  const lines: string[] = [
    `🔍 **Watcher Alert** — ${watcherId}`,
    "",
    `URL: ${url}`,
    `Changes detected at ${timestamp}:`,
    `- Added: ${diff.added.length} elements`,
    `- Changed: ${diff.changed.length} elements`,
    `- Removed: ${diff.removed.length} elements`,
  ];

  const diffContent = buildDiffContent(diff);
  if (diffContent.length > 0) {
    lines.push("");
    lines.push(diffContent);
  }

  return lines.join("\n");
}

function buildDiffContent(diff: WatcherDiff): string {
  const sections: string[] = [];

  if (diff.added.length > 0) {
    sections.push(`Added: ${diff.added.join(", ")}`);
  }

  if (diff.changed.length > 0) {
    sections.push(`Changed: ${diff.changed.join(", ")}`);
  }

  if (diff.removed.length > 0) {
    sections.push(`Removed: ${diff.removed.join(", ")}`);
  }

  const combined = sections.join("\n");

  if (combined.length <= MAX_DIFF_CONTENT_LENGTH) {
    return combined;
  }

  return combined.slice(0, MAX_DIFF_CONTENT_LENGTH) + "\n[...truncated]";
}

/**
 * Delivers watcher notifications to the most recently active conversation.
 *
 * "Active conversation" is defined as the most recently updated conversation
 * returned by `ConversationManager.list({ orderBy: "updated", limit: 1 })`.
 *
 * If no conversation is active, the notification is logged and silently dropped.
 * Notification delivery errors never propagate — they are caught and logged.
 */
export class ConversationNotificationDelivery implements NotificationDelivery {
  constructor(
    private readonly conversationManager: ConversationManager,
    private readonly logger: NotificationLogger = consoleNotificationLogger,
  ) {}

  async sendWatcherNotification(
    watcherId: string,
    url: string,
    diff: WatcherDiff,
  ): Promise<void> {
    try {
      const conversations = await this.conversationManager.list({
        orderBy: "updated",
        limit: 1,
      });

      if (!conversations || conversations.length === 0) {
        this.logger.warn(
          `Watcher ${watcherId}: no active conversation found, notification dropped`,
        );
        return;
      }

      const activeConversation = conversations[0]!;
      const message = formatWatcherNotification(watcherId, url, diff);

      await this.conversationManager.addMessage(activeConversation.id, {
        role: "system",
        content: message,
      });
    } catch (error) {
      this.logger.error(
        `Watcher ${watcherId}: notification delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export interface NotificationLogger {
  warn(message: string): void;
  error(message: string): void;
}

const consoleNotificationLogger: NotificationLogger = {
  warn(message: string) {
    console.warn(JSON.stringify({ scope: "watcher-notification", level: "warn", message }));
  },
  error(message: string) {
    console.error(JSON.stringify({ scope: "watcher-notification", level: "error", message }));
  },
};

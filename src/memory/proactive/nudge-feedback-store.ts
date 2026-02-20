import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type NudgeFeedbackAction = "dismissed" | "accepted" | "ignored";

export interface NudgeFeedback {
  nudgeId: string;
  action: NudgeFeedbackAction;
  timestamp: Date;
  topic: string;
}

interface TopicStats {
  dismissed: number;
  accepted: number;
  ignored: number;
  total: number;
}

interface SerializedFeedback {
  nudgeId: string;
  action: NudgeFeedbackAction;
  timestamp: string;
  topic: string;
}

function isMissingFileError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (value as { code: unknown }).code === "ENOENT"
  );
}

function isValidFeedbackEntry(value: unknown): value is SerializedFeedback {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    typeof entry.nudgeId === "string" &&
    typeof entry.action === "string" &&
    (entry.action === "dismissed" || entry.action === "accepted" || entry.action === "ignored") &&
    typeof entry.timestamp === "string" &&
    typeof entry.topic === "string"
  );
}

export class NudgeFeedbackStore {
  private readonly entries: NudgeFeedback[] = [];

  recordFeedback(feedback: NudgeFeedback): void {
    this.entries.push({
      nudgeId: feedback.nudgeId,
      action: feedback.action,
      timestamp: feedback.timestamp,
      topic: feedback.topic,
    });
  }

  dismissTopic(topic: string): void {
    this.recordFeedback({
      nudgeId: `dismiss_${topic}_${Date.now()}`,
      action: "dismissed",
      timestamp: new Date(),
      topic,
    });
  }

  isTopicDismissed(topic: string, windowMs: number): boolean {
    const cutoff = Date.now() - windowMs;
    const topicLower = topic.toLowerCase();

    for (const entry of this.entries) {
      if (
        entry.action === "dismissed" &&
        entry.topic.toLowerCase() === topicLower &&
        entry.timestamp.getTime() >= cutoff
      ) {
        return true;
      }
    }

    return false;
  }

  getDismissedTopics(windowMs: number): string[] {
    const cutoff = Date.now() - windowMs;
    const topics = new Set<string>();

    for (const entry of this.entries) {
      if (entry.action === "dismissed" && entry.timestamp.getTime() >= cutoff) {
        topics.add(entry.topic);
      }
    }

    return [...topics];
  }

  getDismissalRate(topic: string): number {
    const stats = this.getTopicStats(topic);
    if (stats.total === 0) {
      return 0;
    }

    return stats.dismissed / stats.total;
  }

  getTopicStats(topic: string): TopicStats {
    let dismissed = 0;
    let accepted = 0;
    let ignored = 0;

    for (const entry of this.entries) {
      if (entry.topic === topic) {
        if (entry.action === "dismissed") {
          dismissed += 1;
        } else if (entry.action === "accepted") {
          accepted += 1;
        } else {
          ignored += 1;
        }
      }
    }

    return {
      dismissed,
      accepted,
      ignored,
      total: dismissed + accepted + ignored,
    };
  }

  getAllFeedback(): NudgeFeedback[] {
    return [...this.entries];
  }

  serialize(): string {
    return JSON.stringify(
      this.entries.map((entry) => ({
        nudgeId: entry.nudgeId,
        action: entry.action,
        timestamp: entry.timestamp.toISOString(),
        topic: entry.topic,
      })),
    );
  }

  static deserialize(json: string): NudgeFeedbackStore {
    const store = new NudgeFeedbackStore();
    const parsed: unknown = JSON.parse(json);

    if (!Array.isArray(parsed)) {
      return store;
    }

    for (const entry of parsed) {
      if (isValidFeedbackEntry(entry)) {
        store.recordFeedback({
          nudgeId: entry.nudgeId,
          action: entry.action,
          timestamp: new Date(entry.timestamp),
          topic: entry.topic,
        });
      }
    }

    return store;
  }
}

/**
 * File-backed nudge feedback store.
 *
 * Persists nudge dismissals and feedback to a JSON file so that
 * dismissal cooldowns survive across process restarts.
 *
 * File format:
 * ```json
 * [
 *   { "nudgeId": "...", "action": "dismissed", "timestamp": "...", "topic": "..." }
 * ]
 * ```
 *
 * Missing file on first load is handled gracefully (empty store).
 * `recordFeedback()` and `dismissTopic()` trigger an immediate async save.
 */
export class FileNudgeFeedbackStore extends NudgeFeedbackStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  override recordFeedback(feedback: NudgeFeedback): void {
    super.recordFeedback(feedback);
    void this.save();
  }

  override dismissTopic(topic: string): void {
    super.dismissTopic(topic);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        return;
      }

      for (const entry of parsed) {
        if (isValidFeedbackEntry(entry)) {
          // Call super.recordFeedback to avoid triggering save during load
          super.recordFeedback({
            nudgeId: entry.nudgeId,
            action: entry.action,
            timestamp: new Date(entry.timestamp),
            topic: entry.topic,
          });
        }
      }
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        // First run — no persisted feedback yet
        return;
      }

      // Corrupt file — start fresh rather than crash
    }
  }

  async save(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, this.serialize() + "\n", "utf8");
    } catch {
      // Best-effort persistence — don't crash on write failure
    }
  }
}

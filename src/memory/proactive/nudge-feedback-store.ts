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
    const parsed: Array<{
      nudgeId: string;
      action: NudgeFeedbackAction;
      timestamp: string;
      topic: string;
    }> = JSON.parse(json);

    for (const entry of parsed) {
      store.recordFeedback({
        nudgeId: entry.nudgeId,
        action: entry.action,
        timestamp: new Date(entry.timestamp),
        topic: entry.topic,
      });
    }

    return store;
  }
}

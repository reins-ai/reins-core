import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileNudgeFeedbackStore,
  NudgeFeedbackStore,
  type NudgeFeedback,
} from "../../../src/memory/proactive/nudge-feedback-store";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reins-nudge-feedback-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("NudgeFeedbackStore", () => {
  describe("recordFeedback", () => {
    it("records and retrieves feedback", () => {
      const store = new NudgeFeedbackStore();
      const feedback: NudgeFeedback = {
        nudgeId: "nudge-1",
        action: "dismissed",
        timestamp: new Date(),
        topic: "typescript",
      };

      store.recordFeedback(feedback);

      const all = store.getAllFeedback();
      expect(all).toHaveLength(1);
      expect(all[0].nudgeId).toBe("nudge-1");
      expect(all[0].action).toBe("dismissed");
      expect(all[0].topic).toBe("typescript");
    });
  });

  describe("dismissTopic", () => {
    it("records a dismissal for the given topic", () => {
      const store = new NudgeFeedbackStore();

      store.dismissTopic("react");

      const all = store.getAllFeedback();
      expect(all).toHaveLength(1);
      expect(all[0].action).toBe("dismissed");
      expect(all[0].topic).toBe("react");
      expect(all[0].nudgeId).toContain("dismiss_react_");
    });

    it("records multiple dismissals for different topics", () => {
      const store = new NudgeFeedbackStore();

      store.dismissTopic("react");
      store.dismissTopic("typescript");

      const all = store.getAllFeedback();
      expect(all).toHaveLength(2);
      expect(all[0].topic).toBe("react");
      expect(all[1].topic).toBe("typescript");
    });
  });

  describe("isTopicDismissed", () => {
    it("returns true for a recently dismissed topic within cooldown", () => {
      const store = new NudgeFeedbackStore();

      store.dismissTopic("react");

      expect(store.isTopicDismissed("react", 60_000)).toBe(true);
    });

    it("returns false for a topic not dismissed", () => {
      const store = new NudgeFeedbackStore();

      expect(store.isTopicDismissed("react", 60_000)).toBe(false);
    });

    it("returns false when dismissal is outside cooldown window", () => {
      const store = new NudgeFeedbackStore();
      const oldTimestamp = new Date(Date.now() - 120_000);

      store.recordFeedback({
        nudgeId: "old-dismiss",
        action: "dismissed",
        timestamp: oldTimestamp,
        topic: "react",
      });

      // Cooldown of 60s — dismissal was 120s ago
      expect(store.isTopicDismissed("react", 60_000)).toBe(false);
    });

    it("is case-insensitive for topic matching", () => {
      const store = new NudgeFeedbackStore();

      store.dismissTopic("TypeScript");

      expect(store.isTopicDismissed("typescript", 60_000)).toBe(true);
      expect(store.isTopicDismissed("TYPESCRIPT", 60_000)).toBe(true);
    });

    it("returns true when at least one dismissal is within window", () => {
      const store = new NudgeFeedbackStore();
      const oldTimestamp = new Date(Date.now() - 120_000);

      // Old dismissal outside window
      store.recordFeedback({
        nudgeId: "old",
        action: "dismissed",
        timestamp: oldTimestamp,
        topic: "react",
      });

      // Recent dismissal inside window
      store.dismissTopic("react");

      expect(store.isTopicDismissed("react", 60_000)).toBe(true);
    });

    it("does not count accepted or ignored actions as dismissals", () => {
      const store = new NudgeFeedbackStore();

      store.recordFeedback({
        nudgeId: "n1",
        action: "accepted",
        timestamp: new Date(),
        topic: "react",
      });
      store.recordFeedback({
        nudgeId: "n2",
        action: "ignored",
        timestamp: new Date(),
        topic: "react",
      });

      expect(store.isTopicDismissed("react", 60_000)).toBe(false);
    });
  });

  describe("getDismissedTopics", () => {
    it("returns dismissed topics within time window", () => {
      const store = new NudgeFeedbackStore();
      const now = Date.now();

      store.recordFeedback({
        nudgeId: "n1",
        action: "dismissed",
        timestamp: new Date(now - 1000),
        topic: "react",
      });
      store.recordFeedback({
        nudgeId: "n2",
        action: "accepted",
        timestamp: new Date(now - 500),
        topic: "typescript",
      });
      store.recordFeedback({
        nudgeId: "n3",
        action: "dismissed",
        timestamp: new Date(now - 200),
        topic: "testing",
      });

      const dismissed = store.getDismissedTopics(2000);
      expect(dismissed).toContain("react");
      expect(dismissed).toContain("testing");
      expect(dismissed).not.toContain("typescript");
    });

    it("excludes dismissed topics outside time window", () => {
      const store = new NudgeFeedbackStore();
      const now = Date.now();

      store.recordFeedback({
        nudgeId: "n1",
        action: "dismissed",
        timestamp: new Date(now - 10_000),
        topic: "old-topic",
      });
      store.recordFeedback({
        nudgeId: "n2",
        action: "dismissed",
        timestamp: new Date(now - 100),
        topic: "recent-topic",
      });

      const dismissed = store.getDismissedTopics(5000);
      expect(dismissed).not.toContain("old-topic");
      expect(dismissed).toContain("recent-topic");
    });
  });

  describe("getDismissalRate", () => {
    it("calculates dismissal rate for a topic", () => {
      const store = new NudgeFeedbackStore();
      const now = new Date();

      store.recordFeedback({ nudgeId: "n1", action: "dismissed", timestamp: now, topic: "auth" });
      store.recordFeedback({ nudgeId: "n2", action: "dismissed", timestamp: now, topic: "auth" });
      store.recordFeedback({ nudgeId: "n3", action: "accepted", timestamp: now, topic: "auth" });
      store.recordFeedback({ nudgeId: "n4", action: "ignored", timestamp: now, topic: "auth" });

      expect(store.getDismissalRate("auth")).toBe(0.5);
    });

    it("returns zero for unknown topic", () => {
      const store = new NudgeFeedbackStore();
      expect(store.getDismissalRate("unknown")).toBe(0);
    });
  });

  describe("getTopicStats", () => {
    it("returns correct stats", () => {
      const store = new NudgeFeedbackStore();
      const now = new Date();

      store.recordFeedback({ nudgeId: "n1", action: "dismissed", timestamp: now, topic: "db" });
      store.recordFeedback({ nudgeId: "n2", action: "accepted", timestamp: now, topic: "db" });
      store.recordFeedback({ nudgeId: "n3", action: "ignored", timestamp: now, topic: "db" });

      const stats = store.getTopicStats("db");
      expect(stats.dismissed).toBe(1);
      expect(stats.accepted).toBe(1);
      expect(stats.ignored).toBe(1);
      expect(stats.total).toBe(3);
    });
  });

  describe("serialize / deserialize", () => {
    it("round-trips correctly", () => {
      const store = new NudgeFeedbackStore();
      const timestamp = new Date("2026-01-15T10:00:00Z");

      store.recordFeedback({ nudgeId: "n1", action: "dismissed", timestamp, topic: "react" });
      store.recordFeedback({ nudgeId: "n2", action: "accepted", timestamp, topic: "testing" });

      const json = store.serialize();
      const restored = NudgeFeedbackStore.deserialize(json);

      const all = restored.getAllFeedback();
      expect(all).toHaveLength(2);
      expect(all[0].nudgeId).toBe("n1");
      expect(all[0].action).toBe("dismissed");
      expect(all[0].topic).toBe("react");
      expect(all[0].timestamp.toISOString()).toBe(timestamp.toISOString());
      expect(all[1].nudgeId).toBe("n2");
      expect(all[1].action).toBe("accepted");
    });

    it("handles invalid JSON gracefully", () => {
      const store = NudgeFeedbackStore.deserialize("[]");
      expect(store.getAllFeedback()).toHaveLength(0);
    });

    it("skips invalid entries during deserialization", () => {
      const json = JSON.stringify([
        { nudgeId: "n1", action: "dismissed", timestamp: "2026-01-15T10:00:00Z", topic: "valid" },
        { nudgeId: "n2", action: "bad-action", timestamp: "2026-01-15T10:00:00Z", topic: "invalid" },
        { missing: "fields" },
        null,
        "not an object",
      ]);

      const store = NudgeFeedbackStore.deserialize(json);
      const all = store.getAllFeedback();
      expect(all).toHaveLength(1);
      expect(all[0].topic).toBe("valid");
    });

    it("handles non-array JSON gracefully", () => {
      const store = NudgeFeedbackStore.deserialize('{"not": "an array"}');
      expect(store.getAllFeedback()).toHaveLength(0);
    });
  });
});

describe("FileNudgeFeedbackStore", () => {
  describe("load", () => {
    it("loads persisted feedback from a valid JSON file", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nudge-feedback.json");

      await writeFile(filePath, JSON.stringify([
        { nudgeId: "n1", action: "dismissed", timestamp: "2026-01-15T10:00:00Z", topic: "react" },
        { nudgeId: "n2", action: "accepted", timestamp: "2026-01-15T11:00:00Z", topic: "testing" },
      ]));

      const store = new FileNudgeFeedbackStore(filePath);
      await store.load();

      const all = store.getAllFeedback();
      expect(all).toHaveLength(2);
      expect(all[0].nudgeId).toBe("n1");
      expect(all[0].action).toBe("dismissed");
      expect(all[0].topic).toBe("react");
      expect(all[1].nudgeId).toBe("n2");
      expect(all[1].action).toBe("accepted");
    });

    it("handles missing file gracefully on first run", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nonexistent", "nudge-feedback.json");

      const store = new FileNudgeFeedbackStore(filePath);
      await store.load();

      expect(store.getAllFeedback()).toHaveLength(0);
    });

    it("handles corrupt JSON file gracefully", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nudge-feedback.json");

      await writeFile(filePath, "not valid json {{{");

      const store = new FileNudgeFeedbackStore(filePath);
      await store.load();

      expect(store.getAllFeedback()).toHaveLength(0);
    });

    it("skips entries with invalid structure during load", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nudge-feedback.json");

      await writeFile(filePath, JSON.stringify([
        { nudgeId: "n1", action: "dismissed", timestamp: "2026-01-15T10:00:00Z", topic: "valid" },
        { nudgeId: "n2", action: "unknown-action", timestamp: "2026-01-15T10:00:00Z", topic: "bad" },
        null,
        "string entry",
      ]));

      const store = new FileNudgeFeedbackStore(filePath);
      await store.load();

      const all = store.getAllFeedback();
      expect(all).toHaveLength(1);
      expect(all[0].topic).toBe("valid");
    });

    it("handles non-array JSON file gracefully", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nudge-feedback.json");

      await writeFile(filePath, '{"not": "an array"}');

      const store = new FileNudgeFeedbackStore(filePath);
      await store.load();

      expect(store.getAllFeedback()).toHaveLength(0);
    });
  });

  describe("save", () => {
    it("persists feedback to file on recordFeedback", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nudge-feedback.json");

      const store = new FileNudgeFeedbackStore(filePath);
      store.recordFeedback({
        nudgeId: "n1",
        action: "dismissed",
        timestamp: new Date("2026-01-15T10:00:00Z"),
        topic: "react",
      });

      // Wait for async save to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].nudgeId).toBe("n1");
      expect(parsed[0].action).toBe("dismissed");
      expect(parsed[0].topic).toBe("react");
    });

    it("persists feedback to file on dismissTopic", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nudge-feedback.json");

      const store = new FileNudgeFeedbackStore(filePath);
      store.dismissTopic("typescript");

      // Wait for async save to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].action).toBe("dismissed");
      expect(parsed[0].topic).toBe("typescript");
    });

    it("creates parent directories on save if missing", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nested", "deep", "nudge-feedback.json");

      const store = new FileNudgeFeedbackStore(filePath);
      store.dismissTopic("react");
      await store.save();

      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].topic).toBe("react");
    });
  });

  describe("persistence across simulated restart", () => {
    it("dismissals survive process restart via file persistence", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nudge-feedback.json");

      // First instance: dismiss a topic
      const store1 = new FileNudgeFeedbackStore(filePath);
      await store1.load();
      store1.dismissTopic("react");
      store1.dismissTopic("typescript");
      await store1.save();

      // Second instance: load and verify dismissals survived
      const store2 = new FileNudgeFeedbackStore(filePath);
      await store2.load();

      const all = store2.getAllFeedback();
      expect(all).toHaveLength(2);
      expect(all[0].topic).toBe("react");
      expect(all[0].action).toBe("dismissed");
      expect(all[1].topic).toBe("typescript");
      expect(all[1].action).toBe("dismissed");
    });

    it("cooldown window applies correctly after restart", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nudge-feedback.json");

      // First instance: dismiss a topic
      const store1 = new FileNudgeFeedbackStore(filePath);
      await store1.load();
      store1.dismissTopic("react");
      await store1.save();

      // Second instance: verify topic is still dismissed within cooldown
      const store2 = new FileNudgeFeedbackStore(filePath);
      await store2.load();

      // Recent dismissal — should still be within cooldown
      expect(store2.isTopicDismissed("react", 60_000)).toBe(true);
    });

    it("dismissed topics resurface after cooldown expires across restart", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nudge-feedback.json");

      // Write a dismissal with an old timestamp (simulating time passage)
      const oldTimestamp = new Date(Date.now() - 120_000); // 2 minutes ago
      await writeFile(filePath, JSON.stringify([
        {
          nudgeId: "dismiss_react_old",
          action: "dismissed",
          timestamp: oldTimestamp.toISOString(),
          topic: "react",
        },
      ]));

      // New instance: load and check — cooldown of 60s should have expired
      const store = new FileNudgeFeedbackStore(filePath);
      await store.load();

      expect(store.isTopicDismissed("react", 60_000)).toBe(false);
      expect(store.getDismissedTopics(60_000)).not.toContain("react");
    });

    it("mixed feedback types persist and load correctly", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nudge-feedback.json");

      const store1 = new FileNudgeFeedbackStore(filePath);
      await store1.load();

      store1.recordFeedback({
        nudgeId: "n1",
        action: "dismissed",
        timestamp: new Date(),
        topic: "react",
      });
      store1.recordFeedback({
        nudgeId: "n2",
        action: "accepted",
        timestamp: new Date(),
        topic: "testing",
      });
      store1.recordFeedback({
        nudgeId: "n3",
        action: "ignored",
        timestamp: new Date(),
        topic: "docs",
      });
      await store1.save();

      const store2 = new FileNudgeFeedbackStore(filePath);
      await store2.load();

      const stats = store2.getTopicStats("react");
      expect(stats.dismissed).toBe(1);
      expect(stats.total).toBe(1);

      expect(store2.getAllFeedback()).toHaveLength(3);
    });
  });

  describe("cooldown window enforcement", () => {
    it("topic is dismissed within cooldown window", () => {
      const store = new NudgeFeedbackStore();
      store.dismissTopic("react");

      // 1 hour cooldown — just dismissed, should be within window
      expect(store.isTopicDismissed("react", 3_600_000)).toBe(true);
    });

    it("topic resurfaces after cooldown window expires", () => {
      const store = new NudgeFeedbackStore();
      const oldTimestamp = new Date(Date.now() - 7_200_000); // 2 hours ago

      store.recordFeedback({
        nudgeId: "old-dismiss",
        action: "dismissed",
        timestamp: oldTimestamp,
        topic: "react",
      });

      // 1 hour cooldown — dismissal was 2 hours ago
      expect(store.isTopicDismissed("react", 3_600_000)).toBe(false);
    });

    it("getDismissedTopics respects configurable cooldown", () => {
      const store = new NudgeFeedbackStore();
      const now = Date.now();

      // Dismissed 30 minutes ago
      store.recordFeedback({
        nudgeId: "n1",
        action: "dismissed",
        timestamp: new Date(now - 30 * 60 * 1000),
        topic: "react",
      });

      // Dismissed 90 minutes ago
      store.recordFeedback({
        nudgeId: "n2",
        action: "dismissed",
        timestamp: new Date(now - 90 * 60 * 1000),
        topic: "typescript",
      });

      // 1 hour window: only react should be dismissed
      const dismissed1h = store.getDismissedTopics(60 * 60 * 1000);
      expect(dismissed1h).toContain("react");
      expect(dismissed1h).not.toContain("typescript");

      // 2 hour window: both should be dismissed
      const dismissed2h = store.getDismissedTopics(2 * 60 * 60 * 1000);
      expect(dismissed2h).toContain("react");
      expect(dismissed2h).toContain("typescript");
    });

    it("zero cooldown window excludes past dismissals", () => {
      const store = new NudgeFeedbackStore();
      const pastTimestamp = new Date(Date.now() - 1);

      store.recordFeedback({
        nudgeId: "old-dismiss",
        action: "dismissed",
        timestamp: pastTimestamp,
        topic: "react",
      });

      // Zero window — cutoff = Date.now(), so past dismissals are excluded
      expect(store.isTopicDismissed("react", 0)).toBe(false);
      expect(store.getDismissedTopics(0)).toHaveLength(0);
    });
  });
});

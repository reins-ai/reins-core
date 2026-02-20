import { describe, expect, it } from "bun:test";

import { ok, err } from "../../src/result";
import {
  CronBootstrapService,
  MORNING_BRIEFING_JOB_ID,
} from "../../src/daemon/cron-bootstrap-service";
import { HEARTBEAT_JOB_ID } from "../../src/cron/jobs/heartbeat-job";
import type { CronJobCreateInput, CronJobDefinition } from "../../src/cron/types";
import { CronError } from "../../src/cron/types";
import {
  MorningBriefingJob,
  formatBriefing,
  NOTHING_TO_REPORT_MESSAGE,
  type FormattedBriefing,
} from "../../src/cron/jobs/morning-briefing-job";
import {
  MorningBriefingService,
  type BriefingMemoryResult,
  type BriefingRetrievalProvider,
} from "../../src/memory/proactive/morning-briefing-service";
import {
  deliverBriefing,
  type DeliveryReport,
} from "../../src/memory/proactive/briefing-delivery";
import { ChannelRegistry } from "../../src/channels/registry";
import type {
  Channel,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
} from "../../src/channels/types";
import {
  NudgeInjector,
  type NudgeEvaluator,
} from "../../src/memory/proactive/nudge-injector";
import {
  NudgeEngine,
  type ConversationContext,
  type NudgeConfig,
  type NudgeMemoryRetrieval,
  type NudgeRetrievalResult,
} from "../../src/memory/proactive/nudge-engine";
import { NudgeFeedbackStore } from "../../src/memory/proactive/nudge-feedback-store";
import type { MemoryRecord } from "../../src/memory/types/memory-record";
import { HeartbeatWatcherService } from "../../src/heartbeat/watcher-service";
import { deliverHeartbeatResult, type HeartbeatResultForDelivery } from "../../src/heartbeat/delivery";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

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

function createMemoryRecord(
  id: string,
  overrides?: Partial<MemoryRecord>,
): MemoryRecord {
  const now = new Date();
  return {
    id,
    content: overrides?.content ?? `Memory content for ${id}`,
    type: overrides?.type ?? "fact",
    layer: overrides?.layer ?? "ltm",
    tags: overrides?.tags ?? [],
    entities: overrides?.entities ?? [],
    importance: overrides?.importance ?? 0.7,
    confidence: overrides?.confidence ?? 0.9,
    provenance: overrides?.provenance ?? {
      sourceType: "explicit",
      conversationId: "conv-integration",
    },
    createdAt: overrides?.createdAt ?? now,
    updatedAt: overrides?.updatedAt ?? now,
    accessedAt: overrides?.accessedAt ?? now,
  };
}

function createContext(overrides?: Partial<ConversationContext>): ConversationContext {
  return {
    query: overrides?.query ?? "What should I focus on today?",
    conversationId: overrides?.conversationId ?? "conv-integration-1",
    recentTopics: overrides?.recentTopics ?? ["planning", "tasks"],
  };
}

// ---------------------------------------------------------------------------
// Mock scheduler for cron bootstrap integration
// ---------------------------------------------------------------------------

class MockScheduler {
  readonly jobs = new Map<string, CronJobDefinition>();
  startCalls = 0;
  stopCalls = 0;

  async start() {
    this.startCalls += 1;
    return ok(undefined);
  }

  async stop() {
    this.stopCalls += 1;
    return ok(undefined);
  }

  async getJob(id: string) {
    return ok(this.jobs.get(id) ?? null);
  }

  async create(input: CronJobCreateInput) {
    if (!input.id) {
      return err(new CronError("Missing id", "TEST_JOB_ID_REQUIRED"));
    }

    const now = new Date("2026-02-20T08:00:00.000Z").toISOString();
    const created: CronJobDefinition = {
      id: input.id,
      name: input.name,
      description: input.description ?? "",
      schedule: input.schedule,
      timezone: input.timezone ?? "UTC",
      status: "active",
      createdBy: "test",
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      maxRuns: null,
      payload: input.payload,
      tags: input.tags ?? [],
    };

    this.jobs.set(input.id, created);
    return ok(created);
  }
}

// ---------------------------------------------------------------------------
// Mock retrieval provider for briefing service
// ---------------------------------------------------------------------------

function createMockRetrievalProvider(
  results: BriefingMemoryResult[] = [],
): BriefingRetrievalProvider {
  return {
    searchByType: async () => ok(results),
    searchByTags: async () => ok(results),
  };
}

// ---------------------------------------------------------------------------
// Mock nudge memory retrieval
// ---------------------------------------------------------------------------

function createMockNudgeRetrieval(
  results: NudgeRetrievalResult[] = [],
): NudgeMemoryRetrieval {
  return {
    search: async () => ok(results),
  };
}

// ---------------------------------------------------------------------------
// Test logger
// ---------------------------------------------------------------------------

interface LogEntry {
  level: string;
  message: string;
  details?: Record<string, unknown>;
}

function createTestLogger() {
  const entries: LogEntry[] = [];
  return {
    entries,
    info(message: string, details?: Record<string, unknown>) {
      entries.push({ level: "info", message, details });
    },
    warn(message: string, details?: Record<string, unknown>) {
      entries.push({ level: "warn", message, details });
    },
    error(message: string, details?: Record<string, unknown>) {
      entries.push({ level: "error", message, details });
    },
    debug(message: string, details?: Record<string, unknown>) {
      entries.push({ level: "debug", message, details });
    },
  };
}

// ===========================================================================
// Pipeline 1: Cron Bootstrap → Briefing Generation → Delivery
// ===========================================================================

describe("Proactive Pipeline: Cron Bootstrap → Briefing → Delivery", () => {
  it("bootstraps cron, generates a briefing, and delivers to channels", async () => {
    // --- Step 1: Cron bootstrap registers morning briefing + heartbeat jobs ---
    const scheduler = new MockScheduler();
    const logger = createTestLogger();

    const cronService = new CronBootstrapService({
      scheduler,
      logger,
    });

    const startResult = await cronService.start();
    expect(startResult.ok).toBe(true);
    expect(scheduler.startCalls).toBe(1);
    expect(scheduler.jobs.has(MORNING_BRIEFING_JOB_ID)).toBe(true);
    expect(scheduler.jobs.has(HEARTBEAT_JOB_ID)).toBe(true);

    const briefingJob = scheduler.jobs.get(MORNING_BRIEFING_JOB_ID)!;
    expect(briefingJob.status).toBe("active");
    expect(briefingJob.schedule).toBe("0 8 * * *");

    // --- Step 2: Morning briefing service generates a briefing ---
    const memoryResults: BriefingMemoryResult[] = [
      {
        id: "mem-1",
        content: "Review PR #42 for auth changes",
        type: "episode",
        importance: 0.8,
        tags: ["action-item", "code-review"],
        source: "conversation",
        createdAt: new Date("2026-02-20T06:00:00.000Z"),
      },
      {
        id: "mem-2",
        content: "Team standup at 10 AM",
        type: "fact",
        importance: 0.6,
        tags: ["upcoming", "scheduled"],
        source: "calendar",
        createdAt: new Date("2026-02-20T07:00:00.000Z"),
      },
    ];

    const briefingService = new MorningBriefingService({
      retrieval: createMockRetrievalProvider(memoryResults),
      now: () => new Date("2026-02-20T08:00:00.000Z"),
    });

    const briefingResult = await briefingService.generateBriefing();
    expect(briefingResult.ok).toBe(true);
    if (!briefingResult.ok) return;

    const briefing = briefingResult.value;
    expect(briefing.totalItems).toBeGreaterThan(0);

    // --- Step 3: Format the briefing into per-section messages ---
    const formatted = formatBriefing(briefing);
    expect(formatted.isEmpty).toBe(false);
    expect(formatted.messages.length).toBeGreaterThan(0);

    // --- Step 4: Deliver formatted briefing to channels ---
    const telegramChannel = createMockChannel("tg-1", "telegram");
    const discordChannel = createMockChannel("dc-1", "discord");
    const registry = new ChannelRegistry();
    registry.register(telegramChannel);
    registry.register(discordChannel);

    const deliveryReport = await deliverBriefing(formatted, registry, {
      now: () => new Date("2026-02-20T08:00:01.000Z"),
    });

    expect(deliveryReport.totalChannels).toBe(2);
    expect(deliveryReport.successCount).toBe(2);
    expect(deliveryReport.failureCount).toBe(0);
    expect(telegramChannel.sentMessages.length).toBeGreaterThan(0);
    expect(discordChannel.sentMessages.length).toBeGreaterThan(0);

    // Verify messages contain briefing content
    const allSentTexts = telegramChannel.sentMessages.map((m) => m.text ?? "");
    expect(allSentTexts.some((t) => t.length > 0)).toBe(true);

    // --- Step 5: Clean shutdown ---
    const stopResult = await cronService.stop();
    expect(stopResult.ok).toBe(true);
    expect(scheduler.stopCalls).toBe(1);
  });

  it("handles empty briefing gracefully through the full pipeline", async () => {
    // Bootstrap cron
    const scheduler = new MockScheduler();
    const cronService = new CronBootstrapService({
      scheduler,
      logger: createTestLogger(),
    });
    await cronService.start();

    // Generate briefing with no memories
    const briefingService = new MorningBriefingService({
      retrieval: createMockRetrievalProvider([]),
      now: () => new Date("2026-02-20T08:00:00.000Z"),
    });

    const briefingResult = await briefingService.generateBriefing();
    expect(briefingResult.ok).toBe(true);
    if (!briefingResult.ok) return;

    const formatted = formatBriefing(briefingResult.value);
    expect(formatted.isEmpty).toBe(true);
    expect(formatted.messages.length).toBe(1);
    expect(formatted.messages[0].text).toBe(NOTHING_TO_REPORT_MESSAGE);

    // Deliver empty briefing — still sends the "nothing to report" message
    const channel = createMockChannel("ch-1");
    const registry = new ChannelRegistry();
    registry.register(channel);

    const report = await deliverBriefing(formatted, registry, {
      now: () => new Date("2026-02-20T08:00:01.000Z"),
    });

    expect(report.successCount).toBe(1);
    expect(channel.sentMessages.length).toBe(1);
    expect(channel.sentMessages[0].text).toContain("Nothing to report");

    await cronService.stop();
  });

  it("delivers briefing even when one channel fails", async () => {
    const scheduler = new MockScheduler();
    const cronService = new CronBootstrapService({
      scheduler,
      logger: createTestLogger(),
    });
    await cronService.start();

    const memoryResults: BriefingMemoryResult[] = [
      {
        id: "mem-3",
        content: "Deploy v2.1 to staging",
        type: "decision",
        importance: 0.9,
        tags: ["deployment"],
        source: "conversation",
        createdAt: new Date("2026-02-20T07:30:00.000Z"),
      },
    ];

    const briefingService = new MorningBriefingService({
      retrieval: createMockRetrievalProvider(memoryResults),
      now: () => new Date("2026-02-20T08:00:00.000Z"),
    });

    const briefingResult = await briefingService.generateBriefing();
    expect(briefingResult.ok).toBe(true);
    if (!briefingResult.ok) return;

    const formatted = formatBriefing(briefingResult.value);

    // One channel succeeds, one fails
    const goodChannel = createMockChannel("ch-good");
    const badChannel = createMockChannel("ch-bad", "discord", {
      sendFn: async () => {
        throw new Error("Discord API rate limited");
      },
    });

    const registry = new ChannelRegistry();
    registry.register(goodChannel);
    registry.register(badChannel);

    const report = await deliverBriefing(formatted, registry, {
      now: () => new Date("2026-02-20T08:00:01.000Z"),
      logger: createTestLogger(),
    });

    expect(report.totalChannels).toBe(2);
    expect(report.successCount).toBe(1);
    expect(report.failureCount).toBe(1);
    expect(goodChannel.sentMessages.length).toBeGreaterThan(0);

    // Verify the failure is recorded
    const failedChannel = report.channels.find((c) => c.channelId === "ch-bad");
    expect(failedChannel).toBeDefined();
    expect(failedChannel!.success).toBe(false);
    expect(failedChannel!.error).toContain("rate limited");

    await cronService.stop();
  });

  it("uses MorningBriefingJob.generateFormattedBriefing for combined generation + formatting", async () => {
    const memoryResults: BriefingMemoryResult[] = [
      {
        id: "mem-4",
        content: "Finish quarterly report",
        type: "episode",
        importance: 0.85,
        tags: ["action-item", "deadline"],
        source: "conversation",
        createdAt: new Date("2026-02-20T06:00:00.000Z"),
      },
    ];

    const briefingService = new MorningBriefingService({
      retrieval: createMockRetrievalProvider(memoryResults),
      now: () => new Date("2026-02-20T08:00:00.000Z"),
    });

    const job = new MorningBriefingJob({
      service: briefingService,
      schedule: { enabled: true, intervalMs: 86400000 },
    });

    const result = await job.generateFormattedBriefing();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.isEmpty).toBe(false);
    expect(result.value.messages.length).toBeGreaterThan(0);
    expect(job.getRunCount()).toBe(1);
  });
});

// ===========================================================================
// Pipeline 2: Nudge Injection → Dismissal → Cooldown
// ===========================================================================

describe("Proactive Pipeline: Nudge Injection → Dismissal → Cooldown", () => {
  it("injects nudges, dismisses a topic, and verifies cooldown across evaluate() calls", async () => {
    const feedbackStore = new NudgeFeedbackStore();

    const nudgeConfig: NudgeConfig = {
      enabled: true,
      maxNudgesPerTurn: 3,
      minRelevanceScore: 0.5,
      cooldownMs: 60_000,
      nudgeTypes: ["fact", "decision"],
      dismissedTopicWindowMs: 300_000, // 5 minutes
    };

    const memRecord = createMemoryRecord("mem-nudge-1", {
      content: "User prefers TypeScript for all projects",
      type: "fact",
      tags: ["typescript", "preference"],
    });

    const retrievalResults: NudgeRetrievalResult[] = [
      {
        id: "mem-nudge-1",
        content: "User prefers TypeScript for all projects",
        score: 0.85,
        record: memRecord,
      },
    ];

    const nudgeRetrieval = createMockNudgeRetrieval(retrievalResults);

    const nudgeEngine = new NudgeEngine({
      retrieval: nudgeRetrieval,
      feedbackStore,
      config: nudgeConfig,
    });

    const injector = new NudgeInjector({
      nudgeEngine,
      feedbackStore,
      config: { nudgesEnabled: true },
    });

    const context = createContext({ query: "What language should I use?" });
    const basePrompt = "You are a helpful assistant.";

    // --- First call: nudge should be injected ---
    const firstResult = await injector.injectNudges(context, basePrompt);
    expect(firstResult).toContain("Nudge addendum:");
    expect(firstResult).toContain("TypeScript");
    expect(firstResult).toContain(basePrompt);

    // --- Dismiss the "typescript" topic ---
    injector.dismissNudge("typescript");

    // Verify dismissal is recorded in the feedback store
    expect(feedbackStore.isTopicDismissed("typescript", nudgeConfig.dismissedTopicWindowMs)).toBe(true);

    // --- Second call: dismissed topic should be filtered out ---
    const secondResult = await injector.injectNudges(context, basePrompt);

    // The nudge engine should filter out the dismissed topic.
    // Since our only candidate matches the dismissed topic, no nudges should be injected.
    expect(secondResult).not.toContain("Nudge addendum:");
    expect(secondResult).toBe(basePrompt);
  });

  it("verifies cooldown expiry allows nudges to resurface", async () => {
    const feedbackStore = new NudgeFeedbackStore();

    // Use a very short dismissal window for testing
    const nudgeConfig: NudgeConfig = {
      enabled: true,
      maxNudgesPerTurn: 3,
      minRelevanceScore: 0.5,
      cooldownMs: 60_000,
      nudgeTypes: ["fact"],
      dismissedTopicWindowMs: 100, // 100ms window for fast test
    };

    const memRecord = createMemoryRecord("mem-cooldown-1", {
      content: "Remember to check deployment status",
      type: "fact",
      tags: ["deployment"],
    });

    const retrievalResults: NudgeRetrievalResult[] = [
      {
        id: "mem-cooldown-1",
        content: "Remember to check deployment status",
        score: 0.9,
        record: memRecord,
      },
    ];

    const nudgeEngine = new NudgeEngine({
      retrieval: createMockNudgeRetrieval(retrievalResults),
      feedbackStore,
      config: nudgeConfig,
    });

    const injector = new NudgeInjector({
      nudgeEngine,
      feedbackStore,
      config: { nudgesEnabled: true },
    });

    const context = createContext({ query: "How is the deployment going?" });
    const basePrompt = "You are a helpful assistant.";

    // First call: nudge injected
    const firstResult = await injector.injectNudges(context, basePrompt);
    expect(firstResult).toContain("deployment status");

    // Dismiss the topic
    injector.dismissNudge("deployment");
    expect(feedbackStore.isTopicDismissed("deployment", nudgeConfig.dismissedTopicWindowMs)).toBe(true);

    // Immediately after dismissal: nudge should be filtered
    // Need a fresh engine to reset the per-memory cooldown timestamps
    const freshEngine = new NudgeEngine({
      retrieval: createMockNudgeRetrieval(retrievalResults),
      feedbackStore,
      config: nudgeConfig,
    });

    const freshInjector = new NudgeInjector({
      nudgeEngine: freshEngine,
      feedbackStore,
      config: { nudgesEnabled: true },
    });

    const duringCooldown = await freshInjector.injectNudges(context, basePrompt);
    expect(duringCooldown).not.toContain("Nudge addendum:");

    // Wait for the dismissal window to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // After cooldown: topic should no longer be dismissed
    expect(feedbackStore.isTopicDismissed("deployment", nudgeConfig.dismissedTopicWindowMs)).toBe(false);

    // Create another fresh engine (to avoid per-memory cooldown)
    const postCooldownEngine = new NudgeEngine({
      retrieval: createMockNudgeRetrieval(retrievalResults),
      feedbackStore,
      config: nudgeConfig,
    });

    const postCooldownInjector = new NudgeInjector({
      nudgeEngine: postCooldownEngine,
      feedbackStore,
      config: { nudgesEnabled: true },
    });

    const afterCooldown = await postCooldownInjector.injectNudges(context, basePrompt);
    expect(afterCooldown).toContain("deployment status");
  });

  it("respects the 50ms latency gate in the full pipeline", async () => {
    const feedbackStore = new NudgeFeedbackStore();
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];

    // Simulate a slow nudge engine that takes >50ms
    const slowEvaluator: NudgeEvaluator = {
      evaluate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return ok({
          shouldNudge: true,
          nudges: [{
            id: "slow-nudge",
            content: "This should be skipped",
            memorySource: createMemoryRecord("slow-mem"),
            relevanceScore: 0.9,
            reason: "test",
            type: "context" as const,
            dismissible: true,
          }],
          reasoning: "Selected one nudge",
        });
      },
    };

    // Use a clock that simulates 60ms elapsed
    const clockValues = [1000, 1060];
    let clockIndex = 0;

    const injector = new NudgeInjector({
      nudgeEngine: slowEvaluator,
      feedbackStore,
      config: { nudgesEnabled: true, maxEvaluationMs: 50 },
      logger: {
        debug: () => {},
        warn: (message, context) => {
          warnings.push({ message, context });
        },
      },
      now: () => clockValues[clockIndex++],
    });

    const result = await injector.injectNudges(
      createContext(),
      "You are a helpful assistant.",
    );

    // Nudge should be skipped due to latency gate
    expect(result).toBe("You are a helpful assistant.");
    expect(result).not.toContain("Nudge addendum:");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].message).toContain("exceeded latency gate");
  });

  it("skips nudge injection when disabled", async () => {
    const feedbackStore = new NudgeFeedbackStore();

    const nudgeEngine = new NudgeEngine({
      retrieval: createMockNudgeRetrieval([{
        id: "mem-disabled",
        content: "Should not appear",
        score: 0.9,
        record: createMemoryRecord("mem-disabled"),
      }]),
      feedbackStore,
      config: {
        enabled: true,
        maxNudgesPerTurn: 3,
        minRelevanceScore: 0.5,
        cooldownMs: 60_000,
        nudgeTypes: ["fact"],
        dismissedTopicWindowMs: 300_000,
      },
    });

    const injector = new NudgeInjector({
      nudgeEngine,
      feedbackStore,
      config: { nudgesEnabled: false },
    });

    const result = await injector.injectNudges(
      createContext(),
      "You are a helpful assistant.",
    );

    expect(result).toBe("You are a helpful assistant.");
  });

  it("handles multiple nudges with mixed dismissal states", async () => {
    const feedbackStore = new NudgeFeedbackStore();

    const nudgeConfig: NudgeConfig = {
      enabled: true,
      maxNudgesPerTurn: 5,
      minRelevanceScore: 0.5,
      cooldownMs: 60_000,
      nudgeTypes: ["fact", "decision"],
      dismissedTopicWindowMs: 300_000,
    };

    const records = [
      createMemoryRecord("mem-a", {
        content: "User prefers dark mode",
        type: "fact",
        tags: ["dark-mode", "ui"],
      }),
      createMemoryRecord("mem-b", {
        content: "Project uses React for frontend",
        type: "decision",
        tags: ["react", "frontend"],
      }),
      createMemoryRecord("mem-c", {
        content: "Deploy to staging before production",
        type: "fact",
        tags: ["deployment", "staging"],
      }),
    ];

    const retrievalResults: NudgeRetrievalResult[] = records.map((r, i) => ({
      id: r.id,
      content: r.content,
      score: 0.9 - i * 0.1,
      record: r,
    }));

    const nudgeEngine = new NudgeEngine({
      retrieval: createMockNudgeRetrieval(retrievalResults),
      feedbackStore,
      config: nudgeConfig,
    });

    const injector = new NudgeInjector({
      nudgeEngine,
      feedbackStore,
      config: { nudgesEnabled: true },
    });

    const context = createContext({ query: "What UI framework and deployment process?" });

    // First call: all three nudges should appear
    const firstResult = await injector.injectNudges(context, "Base prompt.");
    expect(firstResult).toContain("dark mode");
    expect(firstResult).toContain("React");
    expect(firstResult).toContain("staging");

    // Dismiss "react" topic
    injector.dismissNudge("react");

    // Create fresh engine to avoid per-memory cooldown
    const freshEngine = new NudgeEngine({
      retrieval: createMockNudgeRetrieval(retrievalResults),
      feedbackStore,
      config: nudgeConfig,
    });

    const freshInjector = new NudgeInjector({
      nudgeEngine: freshEngine,
      feedbackStore,
      config: { nudgesEnabled: true },
    });

    // Second call: "react" nudge should be filtered, others remain
    const secondResult = await freshInjector.injectNudges(context, "Base prompt.");
    expect(secondResult).toContain("dark mode");
    expect(secondResult).not.toContain("React");
    expect(secondResult).toContain("staging");
  });
});

// ===========================================================================
// Pipeline 3: Heartbeat Parse → Execute → Deliver
// ===========================================================================

describe("Proactive Pipeline: Heartbeat Parse → Execute → Deliver", () => {
  it("parses HEARTBEAT.md, evaluates due tasks, and delivers results", async () => {
    const logger = createTestLogger();

    // Simulate a HEARTBEAT.md file with a routine
    const heartbeatContent = `# HEARTBEAT.md

## Morning Kickoff
**Trigger:** First heartbeat after 7:00 AM on weekdays
**Output Contract:**
- Summary of today's priorities
- Any blockers from yesterday
**Actions:**
1. Review open PRs
2. Check CI pipeline status
`;

    let readCallCount = 0;
    const mockReadFile = async (_path: string): Promise<string> => {
      readCallCount += 1;
      return heartbeatContent;
    };

    let watchCallback: (() => void) | null = null;
    const mockWatchFile = (_path: string, onChange: () => void) => {
      watchCallback = onChange;
      return { close: () => {} };
    };

    const watcher = new HeartbeatWatcherService({
      workspacePath: "/tmp/test-workspace",
      debounceMs: 30_000,
      readFile: mockReadFile,
      watchFile: mockWatchFile,
      logger,
    });

    // --- Step 1: Start watcher — parses HEARTBEAT.md on startup ---
    const startResult = await watcher.start();
    expect(startResult.ok).toBe(true);
    expect(readCallCount).toBe(1);

    // --- Step 2: Verify parsed routines ---
    const tasks = watcher.getTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].name).toBe("Morning Kickoff");
    expect(tasks[0].triggerTime).toBe("7:00 AM");
    expect(tasks[0].frequency).toBe("daily");
    expect(tasks[0].actions.length).toBe(2);

    // --- Step 3: Evaluate due tasks (simulate 9 AM on a weekday) ---
    // Create a date that is a weekday (Monday = 1)
    const mondayMorning = new Date("2026-02-23T09:00:00.000Z"); // Monday
    const dueTasks = watcher.getDueTasks(undefined, mondayMorning);
    expect(dueTasks.length).toBe(1);
    expect(dueTasks[0].routine.name).toBe("Morning Kickoff");

    // --- Step 4: Deliver heartbeat result to channels ---
    const heartbeatResult: HeartbeatResultForDelivery = {
      routineName: dueTasks[0].routine.name,
      output: {
        content: "Today's priorities: Review PR #42, Fix CI pipeline. No blockers from yesterday.",
        shouldDeliver: true,
        reason: "delivered",
      },
    };

    const channel = createMockChannel("hb-ch-1");
    const registry = new ChannelRegistry();
    registry.register(channel);

    const deliveryReport = await deliverHeartbeatResult(heartbeatResult, registry, {
      now: () => mondayMorning,
      logger,
    });

    expect(deliveryReport.delivered).toBe(true);
    expect(deliveryReport.method).toBe("channel");
    expect(deliveryReport.successCount).toBe(1);
    expect(channel.sentMessages.length).toBe(1);
    expect(channel.sentMessages[0].text).toContain("Heartbeat: Morning Kickoff");
    expect(channel.sentMessages[0].text).toContain("Review PR #42");

    // --- Step 5: Clean shutdown ---
    const stopResult = await watcher.stop();
    expect(stopResult.ok).toBe(true);
  });

  it("falls back to TUI delivery when no channels are configured", async () => {
    const heartbeatContent = `# HEARTBEAT.md

## Evening Wind-Down
**Trigger:** First heartbeat after 5:00 PM on weekdays
**Output Contract:**
- Summary of completed tasks
**Actions:**
1. Log completed items
`;

    const watcher = new HeartbeatWatcherService({
      workspacePath: "/tmp/test-workspace",
      readFile: async () => heartbeatContent,
      watchFile: (_path, _onChange) => ({ close: () => {} }),
      logger: createTestLogger(),
    });

    await watcher.start();

    const tasks = watcher.getTasks();
    expect(tasks.length).toBe(1);

    const heartbeatResult: HeartbeatResultForDelivery = {
      routineName: "Evening Wind-Down",
      output: {
        content: "Completed 5 tasks today. Great progress!",
        shouldDeliver: true,
        reason: "delivered",
      },
    };

    // Empty channel registry — no channels configured
    const emptyRegistry = new ChannelRegistry();

    const report = await deliverHeartbeatResult(heartbeatResult, emptyRegistry, {
      logger: createTestLogger(),
    });

    expect(report.delivered).toBe(false);
    expect(report.method).toBe("tui");
    expect(report.channelResults.length).toBe(0);

    await watcher.stop();
  });

  it("handles file watch updates with debounce", async () => {
    let fileContent = `# HEARTBEAT.md

## Check Emails
**Trigger:** First heartbeat after 8:00 AM on weekdays
**Output Contract:**
- Email summary
**Actions:**
1. Scan inbox
`;

    let readCallCount = 0;
    const mockReadFile = async (): Promise<string> => {
      readCallCount += 1;
      return fileContent;
    };

    let watchCallback: (() => void) | null = null;
    const pendingTimeouts: Array<{ callback: () => void; ms: number }> = [];

    const watcher = new HeartbeatWatcherService({
      workspacePath: "/tmp/test-workspace",
      debounceMs: 30_000,
      readFile: mockReadFile,
      watchFile: (_path, onChange) => {
        watchCallback = onChange;
        return { close: () => {} };
      },
      setTimeoutFn: (callback, ms) => {
        pendingTimeouts.push({ callback, ms });
        return pendingTimeouts.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {},
      logger: createTestLogger(),
    });

    await watcher.start();
    expect(readCallCount).toBe(1);
    expect(watcher.getTasks().length).toBe(1);

    // Simulate file change
    fileContent = `# HEARTBEAT.md

## Check Emails
**Trigger:** First heartbeat after 8:00 AM on weekdays
**Output Contract:**
- Email summary
**Actions:**
1. Scan inbox

## Review PRs
**Trigger:** First heartbeat after 9:00 AM on weekdays
**Output Contract:**
- PR status
**Actions:**
1. Check open PRs
`;

    // Trigger file watch callback
    expect(watchCallback).not.toBeNull();
    watchCallback!();

    // Debounce timer should be scheduled but not yet fired
    expect(pendingTimeouts.length).toBe(1);
    expect(pendingTimeouts[0].ms).toBe(30_000);
    expect(readCallCount).toBe(1); // Not re-read yet

    // Fire the debounce timer
    await pendingTimeouts[0].callback();
    expect(readCallCount).toBe(2);
    expect(watcher.getTasks().length).toBe(2);

    await watcher.stop();
  });

  it("delivers heartbeat results to multiple channels with error isolation", async () => {
    const heartbeatResult: HeartbeatResultForDelivery = {
      routineName: "System Health Check",
      output: {
        content: "All systems operational. CPU: 45%, Memory: 62%.",
        shouldDeliver: true,
        reason: "delivered",
      },
    };

    const goodChannel1 = createMockChannel("hb-good-1", "telegram");
    const failChannel = createMockChannel("hb-fail", "discord", {
      sendFn: async () => {
        throw new Error("Connection timeout");
      },
    });
    const goodChannel2 = createMockChannel("hb-good-2", "telegram");

    const registry = new ChannelRegistry();
    registry.register(goodChannel1);
    registry.register(failChannel);
    registry.register(goodChannel2);

    const report = await deliverHeartbeatResult(heartbeatResult, registry, {
      logger: createTestLogger(),
    });

    expect(report.delivered).toBe(true);
    expect(report.method).toBe("channel");
    expect(report.successCount).toBe(2);
    expect(report.failureCount).toBe(1);

    // Good channels received the message
    expect(goodChannel1.sentMessages.length).toBe(1);
    expect(goodChannel2.sentMessages.length).toBe(1);

    // Failed channel recorded
    const failedResult = report.channelResults.find((r) => r.channelId === "hb-fail");
    expect(failedResult).toBeDefined();
    expect(failedResult!.success).toBe(false);
    expect(failedResult!.error).toContain("Connection timeout");
  });

  it("evaluates no due tasks when before trigger time", async () => {
    const heartbeatContent = `# HEARTBEAT.md

## Afternoon Review
**Trigger:** First heartbeat after 2:00 PM on weekdays
**Output Contract:**
- Progress summary
**Actions:**
1. Check task board
`;

    const watcher = new HeartbeatWatcherService({
      workspacePath: "/tmp/test-workspace",
      readFile: async () => heartbeatContent,
      watchFile: (_path, _onChange) => ({ close: () => {} }),
      logger: createTestLogger(),
    });

    await watcher.start();

    // 9 AM — before the 2 PM trigger
    const earlyMorning = new Date("2026-02-23T09:00:00.000Z"); // Monday
    const dueTasks = watcher.getDueTasks(undefined, earlyMorning);
    expect(dueTasks.length).toBe(0);

    // 3 PM — after the 2 PM trigger
    const afternoon = new Date("2026-02-23T15:00:00.000Z"); // Monday
    const dueTasksAfternoon = watcher.getDueTasks(undefined, afternoon);
    expect(dueTasksAfternoon.length).toBe(1);
    expect(dueTasksAfternoon[0].routine.name).toBe("Afternoon Review");

    await watcher.stop();
  });
});

import { describe, expect, test } from "bun:test";

import { ok, err, type Result } from "../../../src/result";
import { ReinsError } from "../../../src/errors";
import type { MemoryType } from "../../../src/memory/types/index";
import {
  MorningBriefingService,
  MorningBriefingError,
  DEFAULT_BRIEFING_CONFIG,
  BRIEFING_SECTION_TYPES,
  type BriefingConfig,
  type BriefingMemoryResult,
  type BriefingRetrievalProvider,
  type Briefing,
  type BriefingSectionType,
} from "../../../src/memory/proactive/morning-briefing-service";
import {
  MorningBriefingJob,
  BriefingJobError,
  DEFAULT_BRIEFING_SCHEDULE,
} from "../../../src/cron/jobs/morning-briefing-job";

const BASE_TIME = new Date("2026-02-13T08:00:00.000Z");

function createMemoryResult(overrides?: Partial<BriefingMemoryResult>): BriefingMemoryResult {
  return {
    id: overrides?.id ?? crypto.randomUUID(),
    content: overrides?.content ?? "Test memory content",
    type: overrides?.type ?? "fact",
    importance: overrides?.importance ?? 0.5,
    tags: overrides?.tags ?? [],
    source: overrides?.source ?? "conversation",
    createdAt: overrides?.createdAt ?? new Date("2026-02-13T06:00:00.000Z"),
  };
}

function createMockRetrieval(options?: {
  typeResults?: Map<string, BriefingMemoryResult[]>;
  tagResults?: Map<string, BriefingMemoryResult[]>;
  typeError?: boolean;
  tagError?: boolean;
}): BriefingRetrievalProvider {
  return {
    searchByType: async (
      types: MemoryType[],
      searchOptions: { limit: number; minImportance?: number; after?: Date },
    ): Promise<Result<BriefingMemoryResult[]>> => {
      if (options?.typeError) {
        return err(new ReinsError("Retrieval failed", "RETRIEVAL_ERROR"));
      }

      const key = types.sort().join(",");
      const results = options?.typeResults?.get(key) ?? [];

      let filtered = results;
      if (searchOptions.minImportance !== undefined) {
        filtered = filtered.filter((r) => r.importance >= searchOptions.minImportance!);
      }
      if (searchOptions.after) {
        filtered = filtered.filter((r) => r.createdAt >= searchOptions.after!);
      }

      return ok(filtered.slice(0, searchOptions.limit));
    },

    searchByTags: async (
      tags: string[],
      searchOptions: { limit: number; after?: Date },
    ): Promise<Result<BriefingMemoryResult[]>> => {
      if (options?.tagError) {
        return err(new ReinsError("Tag retrieval failed", "TAG_RETRIEVAL_ERROR"));
      }

      const key = tags.sort().join(",");
      const results = options?.tagResults?.get(key) ?? [];

      let filtered = results;
      if (searchOptions.after) {
        filtered = filtered.filter((r) => r.createdAt >= searchOptions.after!);
      }

      return ok(filtered.slice(0, searchOptions.limit));
    },
  };
}

function createService(
  retrieval: BriefingRetrievalProvider,
  config?: Partial<BriefingConfig>,
): MorningBriefingService {
  return new MorningBriefingService({
    retrieval,
    config,
    now: () => BASE_TIME,
  });
}

describe("MorningBriefingService", () => {
  describe("generateBriefing", () => {
    test("returns empty briefing when disabled", async () => {
      const retrieval = createMockRetrieval();
      const service = createService(retrieval, { enabled: false });

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.sections).toHaveLength(0);
      expect(result.value.totalItems).toBe(0);
      expect(result.value.timestamp).toEqual(BASE_TIME);
      expect(result.value.generatedInMs).toBeGreaterThanOrEqual(0);
    });

    test("returns empty briefing when no relevant memories exist", async () => {
      const retrieval = createMockRetrieval();
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.sections).toHaveLength(0);
      expect(result.value.totalItems).toBe(0);
    });

    test("assembles sections from memory results", async () => {
      const decisionMemory = createMemoryResult({
        id: "decision-1",
        content: "Decided to use TypeScript strict mode",
        type: "decision",
        importance: 0.8,
        tags: ["architecture"],
      });

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("decision", [decisionMemory]);

      const retrieval = createMockRetrieval({ typeResults });
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.sections.length).toBeGreaterThanOrEqual(1);

      const decisionSection = result.value.sections.find((s) => s.type === "recent_decisions");
      expect(decisionSection).toBeDefined();
      expect(decisionSection!.items).toHaveLength(1);
      expect(decisionSection!.items[0].content).toBe("Decided to use TypeScript strict mode");
      expect(decisionSection!.itemCount).toBe(1);
    });

    test("includes open_threads section from tag-based search", async () => {
      const actionItem = createMemoryResult({
        id: "action-1",
        content: "Follow up on deployment issue",
        type: "episode",
        importance: 0.6,
        tags: ["action-item"],
      });

      const tagResults = new Map<string, BriefingMemoryResult[]>();
      tagResults.set(
        "action-item,follow-up,open,todo,unresolved",
        [actionItem],
      );

      const retrieval = createMockRetrieval({ tagResults });
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const openThreads = result.value.sections.find((s) => s.type === "open_threads");
      expect(openThreads).toBeDefined();
      expect(openThreads!.items).toHaveLength(1);
      expect(openThreads!.items[0].content).toBe("Follow up on deployment issue");
    });

    test("includes high_importance section for critical memories", async () => {
      const criticalFact = createMemoryResult({
        id: "critical-1",
        content: "API key rotation required by end of week",
        type: "fact",
        importance: 0.9,
        tags: ["security"],
      });

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("entity,fact,preference,skill", [criticalFact]);

      const retrieval = createMockRetrieval({ typeResults });
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const highImportance = result.value.sections.find((s) => s.type === "high_importance");
      expect(highImportance).toBeDefined();
      expect(highImportance!.items).toHaveLength(1);
      expect(highImportance!.items[0].importance).toBe(0.9);
    });

    test("includes upcoming section from tag-based search", async () => {
      const upcomingItem = createMemoryResult({
        id: "upcoming-1",
        content: "Team standup at 10am",
        type: "fact",
        importance: 0.5,
        tags: ["scheduled"],
      });

      const tagResults = new Map<string, BriefingMemoryResult[]>();
      tagResults.set(
        "deadline,reminder,scheduled,time-sensitive,upcoming",
        [upcomingItem],
      );

      const retrieval = createMockRetrieval({ tagResults });
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const upcoming = result.value.sections.find((s) => s.type === "upcoming");
      expect(upcoming).toBeDefined();
      expect(upcoming!.items).toHaveLength(1);
      expect(upcoming!.items[0].content).toBe("Team standup at 10am");
    });

    test("calculates totalItems across all sections", async () => {
      const decisions = [
        createMemoryResult({ id: "d1", type: "decision", importance: 0.8, content: "Decision 1" }),
        createMemoryResult({ id: "d2", type: "decision", importance: 0.7, content: "Decision 2" }),
      ];

      const facts = [
        createMemoryResult({ id: "f1", type: "fact", importance: 0.9, content: "Critical fact" }),
      ];

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("decision", decisions);
      typeResults.set("entity,fact,preference,skill", facts);

      const retrieval = createMockRetrieval({ typeResults });
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalItems).toBe(3);
    });

    test("records generatedInMs timing", async () => {
      const retrieval = createMockRetrieval();
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.generatedInMs).toBeGreaterThanOrEqual(0);
    });

    test("sets timestamp from now function", async () => {
      const retrieval = createMockRetrieval();
      const customTime = new Date("2026-03-01T09:00:00.000Z");
      const service = new MorningBriefingService({
        retrieval,
        now: () => customTime,
      });

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.timestamp).toEqual(customTime);
    });
  });

  describe("topic filtering", () => {
    test("filters results by topic when topicFilters are set", async () => {
      const securityFact = createMemoryResult({
        id: "sec-1",
        content: "Security audit needed",
        type: "fact",
        importance: 0.9,
        tags: ["security"],
      });

      const uiFact = createMemoryResult({
        id: "ui-1",
        content: "UI redesign planned",
        type: "fact",
        importance: 0.8,
        tags: ["ui"],
      });

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("entity,fact,preference,skill", [securityFact, uiFact]);

      const retrieval = createMockRetrieval({ typeResults });
      const service = createService(retrieval, {
        topicFilters: ["security"],
      });

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const highImportance = result.value.sections.find((s) => s.type === "high_importance");
      expect(highImportance).toBeDefined();
      expect(highImportance!.items).toHaveLength(1);
      expect(highImportance!.items[0].content).toBe("Security audit needed");
    });

    test("includes all results when topicFilters is empty", async () => {
      const fact1 = createMemoryResult({
        id: "f1",
        content: "Fact 1",
        type: "fact",
        importance: 0.9,
        tags: ["security"],
      });

      const fact2 = createMemoryResult({
        id: "f2",
        content: "Fact 2",
        type: "fact",
        importance: 0.8,
        tags: ["ui"],
      });

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("entity,fact,preference,skill", [fact1, fact2]);

      const retrieval = createMockRetrieval({ typeResults });
      const service = createService(retrieval, { topicFilters: [] });

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const highImportance = result.value.sections.find((s) => s.type === "high_importance");
      expect(highImportance).toBeDefined();
      expect(highImportance!.items).toHaveLength(2);
    });

    test("topic filtering is case-insensitive", async () => {
      const fact = createMemoryResult({
        id: "f1",
        content: "Security fact",
        type: "fact",
        importance: 0.9,
        tags: ["Security"],
      });

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("entity,fact,preference,skill", [fact]);

      const retrieval = createMockRetrieval({ typeResults });
      const service = createService(retrieval, {
        topicFilters: ["security"],
      });

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const highImportance = result.value.sections.find((s) => s.type === "high_importance");
      expect(highImportance).toBeDefined();
      expect(highImportance!.items).toHaveLength(1);
    });
  });

  describe("lookback window", () => {
    test("only includes memories within lookback window", async () => {
      const recentMemory = createMemoryResult({
        id: "recent",
        content: "Recent decision",
        type: "decision",
        importance: 0.8,
        createdAt: new Date("2026-02-13T06:00:00.000Z"),
      });

      const oldMemory = createMemoryResult({
        id: "old",
        content: "Old decision",
        type: "decision",
        importance: 0.8,
        createdAt: new Date("2026-02-10T06:00:00.000Z"),
      });

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("decision", [recentMemory, oldMemory]);

      const retrieval = createMockRetrieval({ typeResults });
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const decisions = result.value.sections.find((s) => s.type === "recent_decisions");
      expect(decisions).toBeDefined();
      expect(decisions!.items).toHaveLength(1);
      expect(decisions!.items[0].content).toBe("Recent decision");
    });

    test("respects custom lookback window", async () => {
      const memory48hAgo = createMemoryResult({
        id: "m48",
        content: "48h ago decision",
        type: "decision",
        importance: 0.8,
        createdAt: new Date("2026-02-11T06:00:00.000Z"),
      });

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("decision", [memory48hAgo]);

      const retrieval = createMockRetrieval({ typeResults });
      const service = createService(retrieval, {
        lookbackWindowMs: 72 * 60 * 60 * 1000,
      });

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const decisions = result.value.sections.find((s) => s.type === "recent_decisions");
      expect(decisions).toBeDefined();
      expect(decisions!.items).toHaveLength(1);
    });
  });

  describe("max items per section", () => {
    test("limits items per section to maxItemsPerSection", async () => {
      const decisions = Array.from({ length: 10 }, (_, i) =>
        createMemoryResult({
          id: `d${i}`,
          content: `Decision ${i}`,
          type: "decision",
          importance: 0.9 - i * 0.05,
        }),
      );

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("decision", decisions);

      const retrieval = createMockRetrieval({ typeResults });
      const service = createService(retrieval, { maxItemsPerSection: 3 });

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const decisionSection = result.value.sections.find((s) => s.type === "recent_decisions");
      expect(decisionSection).toBeDefined();
      expect(decisionSection!.items).toHaveLength(3);
      expect(decisionSection!.itemCount).toBe(3);
    });

    test("sorts items by importance descending within section", async () => {
      const decisions = [
        createMemoryResult({ id: "low", content: "Low", type: "decision", importance: 0.5 }),
        createMemoryResult({ id: "high", content: "High", type: "decision", importance: 0.9 }),
        createMemoryResult({ id: "mid", content: "Mid", type: "decision", importance: 0.7 }),
      ];

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("decision", decisions);

      const retrieval = createMockRetrieval({ typeResults });
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const decisionSection = result.value.sections.find((s) => s.type === "recent_decisions");
      expect(decisionSection).toBeDefined();
      expect(decisionSection!.items[0].importance).toBe(0.9);
      expect(decisionSection!.items[1].importance).toBe(0.7);
      expect(decisionSection!.items[2].importance).toBe(0.5);
    });
  });

  describe("max sections", () => {
    test("limits number of sections to maxSections", async () => {
      const decisions = [
        createMemoryResult({ id: "d1", type: "decision", importance: 0.8, content: "D1" }),
      ];
      const facts = [
        createMemoryResult({ id: "f1", type: "fact", importance: 0.9, content: "F1" }),
      ];
      const episodes = [
        createMemoryResult({ id: "e1", type: "episode", importance: 0.6, content: "E1" }),
      ];

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("decision", decisions);
      typeResults.set("entity,fact,preference,skill", facts);
      typeResults.set("episode,fact", [...episodes, ...facts]);

      const tagResults = new Map<string, BriefingMemoryResult[]>();
      tagResults.set("action-item,follow-up,open,todo,unresolved", [
        createMemoryResult({ id: "a1", type: "episode", importance: 0.5, tags: ["action-item"], content: "A1" }),
      ]);

      const retrieval = createMockRetrieval({ typeResults, tagResults });
      const service = createService(retrieval, { maxSections: 2 });

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.sections.length).toBeLessThanOrEqual(2);
    });
  });

  describe("deduplication", () => {
    test("deduplicates memories that appear in both type and tag searches", async () => {
      const sharedMemory = createMemoryResult({
        id: "shared-1",
        content: "Shared memory",
        type: "episode",
        importance: 0.6,
        tags: ["action-item"],
      });

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("episode,fact", [sharedMemory]);

      const tagResults = new Map<string, BriefingMemoryResult[]>();
      tagResults.set("action-item,follow-up,open,todo,unresolved", [sharedMemory]);

      const retrieval = createMockRetrieval({ typeResults, tagResults });
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const openThreads = result.value.sections.find((s) => s.type === "open_threads");
      expect(openThreads).toBeDefined();
      expect(openThreads!.items).toHaveLength(1);
    });
  });

  describe("error handling", () => {
    test("returns error when type retrieval fails", async () => {
      const retrieval = createMockRetrieval({ typeError: true });
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(MorningBriefingError);
      expect(result.error.code).toBe("MORNING_BRIEFING_RETRIEVAL_FAILED");
    });

    test("continues when tag retrieval fails but type succeeds", async () => {
      const decisions = [
        createMemoryResult({ id: "d1", type: "decision", importance: 0.8, content: "D1" }),
      ];

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("decision", decisions);

      const retrieval = createMockRetrieval({ typeResults, tagError: true });
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const decisionSection = result.value.sections.find((s) => s.type === "recent_decisions");
      expect(decisionSection).toBeDefined();
      expect(decisionSection!.items).toHaveLength(1);
    });
  });

  describe("config", () => {
    test("uses default config when none provided", () => {
      const retrieval = createMockRetrieval();
      const service = createService(retrieval);

      const config = service.getConfig();

      expect(config.enabled).toBe(DEFAULT_BRIEFING_CONFIG.enabled);
      expect(config.scheduleHour).toBe(DEFAULT_BRIEFING_CONFIG.scheduleHour);
      expect(config.scheduleMinute).toBe(DEFAULT_BRIEFING_CONFIG.scheduleMinute);
      expect(config.maxSections).toBe(DEFAULT_BRIEFING_CONFIG.maxSections);
      expect(config.maxItemsPerSection).toBe(DEFAULT_BRIEFING_CONFIG.maxItemsPerSection);
      expect(config.lookbackWindowMs).toBe(DEFAULT_BRIEFING_CONFIG.lookbackWindowMs);
      expect(config.topicFilters).toEqual([]);
    });

    test("merges partial config with defaults", () => {
      const retrieval = createMockRetrieval();
      const service = createService(retrieval, {
        scheduleHour: 9,
        maxItemsPerSection: 10,
      });

      const config = service.getConfig();

      expect(config.scheduleHour).toBe(9);
      expect(config.maxItemsPerSection).toBe(10);
      expect(config.enabled).toBe(true);
      expect(config.maxSections).toBe(4);
    });

    test("getConfig returns a copy", () => {
      const retrieval = createMockRetrieval();
      const service = createService(retrieval);

      const config1 = service.getConfig();
      const config2 = service.getConfig();

      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2);
    });
  });

  describe("section structure", () => {
    test("each section has correct title", async () => {
      const decisions = [
        createMemoryResult({ id: "d1", type: "decision", importance: 0.8, content: "D1" }),
      ];

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("decision", decisions);

      const retrieval = createMockRetrieval({ typeResults });
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const decisionSection = result.value.sections.find((s) => s.type === "recent_decisions");
      expect(decisionSection).toBeDefined();
      expect(decisionSection!.title).toBe("Recent Decisions");
    });

    test("briefing items have correct structure", async () => {
      const memory = createMemoryResult({
        id: "m1",
        content: "Important fact",
        type: "decision",
        importance: 0.85,
        source: "conversation:abc",
        createdAt: new Date("2026-02-13T05:00:00.000Z"),
      });

      const typeResults = new Map<string, BriefingMemoryResult[]>();
      typeResults.set("decision", [memory]);

      const retrieval = createMockRetrieval({ typeResults });
      const service = createService(retrieval);

      const result = await service.generateBriefing();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const section = result.value.sections.find((s) => s.type === "recent_decisions");
      expect(section).toBeDefined();

      const item = section!.items[0];
      expect(item.content).toBe("Important fact");
      expect(item.type).toBe("decision");
      expect(item.importance).toBe(0.85);
      expect(item.source).toBe("conversation:abc");
      expect(item.timestamp).toEqual(new Date("2026-02-13T05:00:00.000Z"));
    });
  });

  describe("BRIEFING_SECTION_TYPES", () => {
    test("contains all expected section types", () => {
      expect(BRIEFING_SECTION_TYPES).toContain("open_threads");
      expect(BRIEFING_SECTION_TYPES).toContain("high_importance");
      expect(BRIEFING_SECTION_TYPES).toContain("recent_decisions");
      expect(BRIEFING_SECTION_TYPES).toContain("upcoming");
      expect(BRIEFING_SECTION_TYPES).toHaveLength(4);
    });
  });
});

describe("MorningBriefingJob", () => {
  function createMockService(options?: {
    briefing?: Briefing;
    error?: boolean;
    throwError?: boolean;
  }): MorningBriefingService {
    const defaultBriefing: Briefing = {
      timestamp: BASE_TIME,
      sections: [],
      totalItems: 0,
      generatedInMs: 5,
    };

    return {
      generateBriefing: async () => {
        if (options?.throwError) {
          throw new Error("Unexpected crash");
        }
        if (options?.error) {
          return err(
            new MorningBriefingError(
              "Generation failed",
              "MORNING_BRIEFING_ERROR",
            ),
          );
        }
        return ok(options?.briefing ?? defaultBriefing);
      },
      getConfig: () => DEFAULT_BRIEFING_CONFIG,
    } as MorningBriefingService;
  }

  describe("start and stop", () => {
    test("starts and stops the job", () => {
      const service = createMockService();
      const job = new MorningBriefingJob({ service });

      const startResult = job.start();
      expect(startResult.ok).toBe(true);
      expect(job.isRunning()).toBe(true);

      job.stop();
      expect(job.isRunning()).toBe(false);
    });

    test("start is idempotent", () => {
      const service = createMockService();
      const job = new MorningBriefingJob({ service });

      job.start();
      const secondStart = job.start();

      expect(secondStart.ok).toBe(true);
      expect(job.isRunning()).toBe(true);

      job.stop();
    });

    test("returns error when starting disabled job", () => {
      const service = createMockService();
      const job = new MorningBriefingJob({
        service,
        schedule: { enabled: false },
      });

      const result = job.start();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(BriefingJobError);
      expect(result.error.code).toBe("BRIEFING_JOB_DISABLED");
    });

    test("returns error when interval is zero", () => {
      const service = createMockService();
      const job = new MorningBriefingJob({
        service,
        schedule: { intervalMs: 0 },
      });

      const result = job.start();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("BRIEFING_JOB_INVALID_INTERVAL");
    });
  });

  describe("triggerNow", () => {
    test("executes briefing generation on demand", async () => {
      const briefing: Briefing = {
        timestamp: BASE_TIME,
        sections: [
          {
            type: "recent_decisions",
            title: "Recent Decisions",
            items: [
              {
                content: "Use Bun runtime",
                type: "decision",
                importance: 0.8,
                source: "conversation",
                timestamp: BASE_TIME,
              },
            ],
            itemCount: 1,
          },
        ],
        totalItems: 1,
        generatedInMs: 10,
      };

      const service = createMockService({ briefing });
      const job = new MorningBriefingJob({
        service,
        now: () => BASE_TIME,
      });

      const result = await job.triggerNow();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalItems).toBe(1);
      expect(job.getRunCount()).toBe(1);
      expect(job.getLastRunAt()).toEqual(BASE_TIME);
      expect(job.getLastBriefing()).toEqual(briefing);
    });

    test("returns error when service fails", async () => {
      const service = createMockService({ error: true });
      const job = new MorningBriefingJob({ service });

      const result = await job.triggerNow();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(BriefingJobError);
      expect(result.error.code).toBe("BRIEFING_JOB_RUN_FAILED");
    });

    test("returns error when service throws", async () => {
      const service = createMockService({ throwError: true });
      const job = new MorningBriefingJob({ service });

      const result = await job.triggerNow();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("BRIEFING_JOB_UNEXPECTED_ERROR");
    });

    test("calls onComplete callback on success", async () => {
      const service = createMockService();
      let completedBriefing: Briefing | undefined;

      const job = new MorningBriefingJob({
        service,
        onComplete: (b) => {
          completedBriefing = b;
        },
      });

      await job.triggerNow();

      expect(completedBriefing).toBeDefined();
      expect(completedBriefing!.totalItems).toBe(0);
    });

    test("calls onError callback on failure", async () => {
      const service = createMockService({ error: true });
      let capturedError: BriefingJobError | undefined;

      const job = new MorningBriefingJob({
        service,
        onError: (e) => {
          capturedError = e;
        },
      });

      await job.triggerNow();

      expect(capturedError).toBeDefined();
      expect(capturedError).toBeInstanceOf(BriefingJobError);
    });
  });

  describe("state accessors", () => {
    test("initial state is clean", () => {
      const service = createMockService();
      const job = new MorningBriefingJob({ service });

      expect(job.isRunning()).toBe(false);
      expect(job.isExecuting()).toBe(false);
      expect(job.getLastRunAt()).toBeUndefined();
      expect(job.getLastBriefing()).toBeUndefined();
      expect(job.getRunCount()).toBe(0);
    });

    test("getSchedule returns a copy", () => {
      const service = createMockService();
      const job = new MorningBriefingJob({
        service,
        schedule: { intervalMs: 3600000 },
      });

      const schedule1 = job.getSchedule();
      const schedule2 = job.getSchedule();

      expect(schedule1).toEqual(schedule2);
      expect(schedule1).not.toBe(schedule2);
      expect(schedule1.intervalMs).toBe(3600000);
    });

    test("uses default schedule when none provided", () => {
      const service = createMockService();
      const job = new MorningBriefingJob({ service });

      const schedule = job.getSchedule();

      expect(schedule.intervalMs).toBe(DEFAULT_BRIEFING_SCHEDULE.intervalMs);
      expect(schedule.enabled).toBe(DEFAULT_BRIEFING_SCHEDULE.enabled);
    });

    test("increments run count on each successful trigger", async () => {
      const service = createMockService();
      const job = new MorningBriefingJob({ service });

      await job.triggerNow();
      expect(job.getRunCount()).toBe(1);

      await job.triggerNow();
      expect(job.getRunCount()).toBe(2);
    });

    test("does not increment run count on failure", async () => {
      const service = createMockService({ error: true });
      const job = new MorningBriefingJob({ service });

      await job.triggerNow();
      expect(job.getRunCount()).toBe(0);
    });
  });
});

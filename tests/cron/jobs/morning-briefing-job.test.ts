import { describe, expect, test } from "bun:test";

import { ok, err } from "../../../src/result";
import { ReinsError } from "../../../src/errors";
import type {
  Briefing,
  BriefingItem,
  BriefingSection,
  BriefingSectionType,
} from "../../../src/memory/proactive/morning-briefing-service";
import type { MorningBriefingError } from "../../../src/memory/proactive/morning-briefing-service";
import {
  MorningBriefingJob,
  BriefingJobError,
  formatBriefing,
  NOTHING_TO_REPORT_MESSAGE,
  type FormattedBriefing,
} from "../../../src/cron/jobs/morning-briefing-job";
import type { MemoryType } from "../../../src/memory/types/index";

const FIXED_DATE = new Date("2026-02-19T08:00:00.000Z");

function createBriefingItem(overrides?: Partial<BriefingItem>): BriefingItem {
  return {
    content: overrides?.content ?? "Review pull request #42",
    type: overrides?.type ?? ("fact" as MemoryType),
    importance: overrides?.importance ?? 0.7,
    source: overrides?.source ?? "conversation",
    timestamp: overrides?.timestamp ?? FIXED_DATE,
  };
}

function createBriefingSection(
  type: BriefingSectionType,
  items: BriefingItem[],
  title?: string,
): BriefingSection {
  const titles: Record<BriefingSectionType, string> = {
    open_threads: "Open Threads & Action Items",
    high_importance: "High Importance Memories",
    recent_decisions: "Recent Decisions",
    upcoming: "Upcoming & Time-Sensitive",
  };

  return {
    type,
    title: title ?? titles[type],
    items,
    itemCount: items.length,
  };
}

function createBriefing(sections: BriefingSection[]): Briefing {
  const totalItems = sections.reduce((sum, s) => sum + s.itemCount, 0);
  return {
    timestamp: FIXED_DATE,
    sections,
    totalItems,
    generatedInMs: 15,
  };
}

function createEmptyBriefing(): Briefing {
  return {
    timestamp: FIXED_DATE,
    sections: [],
    totalItems: 0,
    generatedInMs: 5,
  };
}

interface MockServiceOptions {
  briefing?: Briefing;
  error?: MorningBriefingError;
}

function createMockService(options: MockServiceOptions = {}) {
  return {
    generateBriefing: async () => {
      if (options.error) {
        return err(options.error);
      }
      return ok(options.briefing ?? createEmptyBriefing());
    },
    getConfig: () => ({
      enabled: true,
      scheduleHour: 8,
      scheduleMinute: 0,
      topicFilters: [],
      maxSections: 4,
      maxItemsPerSection: 5,
      lookbackWindowMs: 86400000,
    }),
  };
}

// --- formatBriefing tests ---

describe("formatBriefing", () => {
  test("empty briefing produces nothing-to-report message", () => {
    const briefing = createEmptyBriefing();
    const result = formatBriefing(briefing);

    expect(result.isEmpty).toBe(true);
    expect(result.totalItems).toBe(0);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.sectionType).toBe("empty");
    expect(result.messages[0]!.text).toBe(NOTHING_TO_REPORT_MESSAGE);
  });

  test("briefing with zero totalItems produces nothing-to-report", () => {
    const briefing: Briefing = {
      timestamp: FIXED_DATE,
      sections: [],
      totalItems: 0,
      generatedInMs: 3,
    };

    const result = formatBriefing(briefing);

    expect(result.isEmpty).toBe(true);
    expect(result.messages[0]!.text).toBe(NOTHING_TO_REPORT_MESSAGE);
  });

  test("full briefing with all four sections produces four messages", () => {
    const sections: BriefingSection[] = [
      createBriefingSection("open_threads", [
        createBriefingItem({ content: "Review PR #42" }),
        createBriefingItem({ content: "Reply to design thread" }),
      ]),
      createBriefingSection("high_importance", [
        createBriefingItem({ content: "API key expires tomorrow", importance: 0.9 }),
      ]),
      createBriefingSection("recent_decisions", [
        createBriefingItem({ content: "Chose PostgreSQL over MySQL", type: "decision" as MemoryType }),
      ]),
      createBriefingSection("upcoming", [
        createBriefingItem({ content: "Team standup at 10am" }),
      ]),
    ];

    const briefing = createBriefing(sections);
    const result = formatBriefing(briefing);

    expect(result.isEmpty).toBe(false);
    expect(result.messages).toHaveLength(4);
    expect(result.totalItems).toBe(5);
    expect(result.timestamp).toBe(FIXED_DATE);

    expect(result.messages[0]!.sectionType).toBe("open_threads");
    expect(result.messages[1]!.sectionType).toBe("high_importance");
    expect(result.messages[2]!.sectionType).toBe("recent_decisions");
    expect(result.messages[3]!.sectionType).toBe("upcoming");
  });

  test("each section message contains header and bullet items", () => {
    const sections: BriefingSection[] = [
      createBriefingSection("open_threads", [
        createBriefingItem({ content: "Review PR #42", source: "conversation" }),
        createBriefingItem({ content: "Fix login bug", source: "todo-list" }),
      ]),
    ];

    const briefing = createBriefing(sections);
    const result = formatBriefing(briefing);

    expect(result.messages).toHaveLength(1);
    const text = result.messages[0]!.text;

    // Header with emoji and title
    expect(text).toContain("Open Threads & Action Items");
    // Bullet items
    expect(text).toContain("\u{2022} Review PR #42 (conversation)");
    expect(text).toContain("\u{2022} Fix login bug (todo-list)");
  });

  test("section emojis are correct for each type", () => {
    const types: BriefingSectionType[] = [
      "open_threads",
      "high_importance",
      "recent_decisions",
      "upcoming",
    ];

    const expectedEmojis: Record<BriefingSectionType, string> = {
      open_threads: "\u{1F4CB}",
      high_importance: "\u{26A0}\u{FE0F}",
      recent_decisions: "\u{2705}",
      upcoming: "\u{1F4C5}",
    };

    for (const type of types) {
      const sections = [
        createBriefingSection(type, [createBriefingItem()]),
      ];
      const briefing = createBriefing(sections);
      const result = formatBriefing(briefing);

      expect(result.messages[0]!.text).toContain(expectedEmojis[type]);
    }
  });

  test("partial briefing with only some sections populated", () => {
    const sections: BriefingSection[] = [
      createBriefingSection("open_threads", [
        createBriefingItem({ content: "Review PR #42" }),
      ]),
      createBriefingSection("upcoming", [
        createBriefingItem({ content: "Deploy v2.0 Friday" }),
      ]),
    ];

    const briefing = createBriefing(sections);
    const result = formatBriefing(briefing);

    expect(result.isEmpty).toBe(false);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.sectionType).toBe("open_threads");
    expect(result.messages[1]!.sectionType).toBe("upcoming");
  });

  test("sections with empty items array are skipped", () => {
    const sections: BriefingSection[] = [
      createBriefingSection("open_threads", [
        createBriefingItem({ content: "Review PR #42" }),
      ]),
      createBriefingSection("high_importance", []),
      createBriefingSection("recent_decisions", [
        createBriefingItem({ content: "Chose Bun over Node" }),
      ]),
    ];

    // totalItems manually set to reflect only non-empty sections
    const briefing: Briefing = {
      timestamp: FIXED_DATE,
      sections,
      totalItems: 2,
      generatedInMs: 10,
    };

    const result = formatBriefing(briefing);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.sectionType).toBe("open_threads");
    expect(result.messages[1]!.sectionType).toBe("recent_decisions");
  });

  test("item without source omits parenthetical", () => {
    const sections: BriefingSection[] = [
      createBriefingSection("open_threads", [
        createBriefingItem({ content: "Standalone item", source: "" }),
      ]),
    ];

    const briefing = createBriefing(sections);
    const result = formatBriefing(briefing);

    const text = result.messages[0]!.text;
    expect(text).toContain("\u{2022} Standalone item");
    expect(text).not.toContain("()");
  });

  test("preserves briefing timestamp in formatted output", () => {
    const customDate = new Date("2026-03-15T09:30:00.000Z");
    const briefing: Briefing = {
      timestamp: customDate,
      sections: [],
      totalItems: 0,
      generatedInMs: 2,
    };

    const result = formatBriefing(briefing);

    expect(result.timestamp).toBe(customDate);
  });

  test("single section with single item produces one message", () => {
    const sections: BriefingSection[] = [
      createBriefingSection("high_importance", [
        createBriefingItem({ content: "Server disk at 95%", importance: 0.95 }),
      ]),
    ];

    const briefing = createBriefing(sections);
    const result = formatBriefing(briefing);

    expect(result.isEmpty).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.totalItems).toBe(1);
    expect(result.messages[0]!.sectionType).toBe("high_importance");
    expect(result.messages[0]!.text).toContain("Server disk at 95%");
  });

  test("briefing with sections but all sections empty produces nothing-to-report", () => {
    const sections: BriefingSection[] = [
      createBriefingSection("open_threads", []),
      createBriefingSection("high_importance", []),
    ];

    // totalItems is 0 because all sections are empty
    const briefing: Briefing = {
      timestamp: FIXED_DATE,
      sections,
      totalItems: 0,
      generatedInMs: 5,
    };

    const result = formatBriefing(briefing);

    expect(result.isEmpty).toBe(true);
    expect(result.messages[0]!.text).toBe(NOTHING_TO_REPORT_MESSAGE);
  });

  test("multiple items in a section are each on their own line", () => {
    const sections: BriefingSection[] = [
      createBriefingSection("recent_decisions", [
        createBriefingItem({ content: "Use Bun runtime", source: "meeting" }),
        createBriefingItem({ content: "Adopt TypeScript strict", source: "code-review" }),
        createBriefingItem({ content: "Switch to WAL mode", source: "perf-analysis" }),
      ]),
    ];

    const briefing = createBriefing(sections);
    const result = formatBriefing(briefing);

    const lines = result.messages[0]!.text.split("\n");
    // Header line, blank line, then 3 item lines
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("Recent Decisions");
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("Use Bun runtime");
    expect(lines[3]).toContain("Adopt TypeScript strict");
    expect(lines[4]).toContain("Switch to WAL mode");
  });
});

// --- MorningBriefingJob.generateFormattedBriefing tests ---

describe("MorningBriefingJob.generateFormattedBriefing", () => {
  test("returns formatted briefing from service output", async () => {
    const sections: BriefingSection[] = [
      createBriefingSection("open_threads", [
        createBriefingItem({ content: "Review PR #42" }),
      ]),
      createBriefingSection("upcoming", [
        createBriefingItem({ content: "Deploy Friday" }),
      ]),
    ];

    const briefing = createBriefing(sections);
    const service = createMockService({ briefing });

    const job = new MorningBriefingJob({
      service: service as any,
      now: () => FIXED_DATE,
    });

    const result = await job.generateFormattedBriefing();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.isEmpty).toBe(false);
    expect(result.value.messages).toHaveLength(2);
    expect(result.value.totalItems).toBe(2);
  });

  test("returns formatted nothing-to-report for empty briefing", async () => {
    const service = createMockService({ briefing: createEmptyBriefing() });

    const job = new MorningBriefingJob({
      service: service as any,
      now: () => FIXED_DATE,
    });

    const result = await job.generateFormattedBriefing();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.isEmpty).toBe(true);
    expect(result.value.messages).toHaveLength(1);
    expect(result.value.messages[0]!.text).toBe(NOTHING_TO_REPORT_MESSAGE);
  });

  test("propagates service errors", async () => {
    const serviceError = new ReinsError(
      "Memory store unavailable",
      "MORNING_BRIEFING_RETRIEVAL_FAILED",
    ) as MorningBriefingError;

    const service = createMockService({ error: serviceError });

    const job = new MorningBriefingJob({
      service: service as any,
      now: () => FIXED_DATE,
    });

    const result = await job.generateFormattedBriefing();

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(BriefingJobError);
    expect(result.error.code).toBe("BRIEFING_JOB_RUN_FAILED");
  });

  test("increments run count on successful formatted briefing", async () => {
    const briefing = createBriefing([
      createBriefingSection("open_threads", [createBriefingItem()]),
    ]);
    const service = createMockService({ briefing });

    const job = new MorningBriefingJob({
      service: service as any,
      now: () => FIXED_DATE,
    });

    expect(job.getRunCount()).toBe(0);

    await job.generateFormattedBriefing();

    expect(job.getRunCount()).toBe(1);
  });

  test("stores last briefing after formatted generation", async () => {
    const briefing = createBriefing([
      createBriefingSection("high_importance", [
        createBriefingItem({ content: "Critical alert" }),
      ]),
    ]);
    const service = createMockService({ briefing });

    const job = new MorningBriefingJob({
      service: service as any,
      now: () => FIXED_DATE,
    });

    await job.generateFormattedBriefing();

    const lastBriefing = job.getLastBriefing();
    expect(lastBriefing).toBeDefined();
    expect(lastBriefing!.totalItems).toBe(1);
  });
});

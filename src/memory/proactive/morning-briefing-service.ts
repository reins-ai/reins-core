import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import { getStaleMemories } from "../services/stale-detection";
import { formatRelativeDate } from "../services/memory-summary-generator";
import type { MemoryRepository } from "../storage/memory-repository";
import type { MemoryRecord } from "../types/memory-record";
import type { MemoryType } from "../types/index";

const DEFAULT_LOOKBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SECTIONS = 4;
const DEFAULT_MAX_ITEMS_PER_SECTION = 5;

export const BRIEFING_SECTION_TYPES = [
  "open_threads",
  "high_importance",
  "recent_decisions",
  "upcoming",
  "health_check",
] as const;

export type BriefingSectionType = (typeof BRIEFING_SECTION_TYPES)[number];

export interface BriefingConfig {
  enabled: boolean;
  scheduleHour: number;
  scheduleMinute: number;
  topicFilters: string[];
  maxSections: number;
  maxItemsPerSection: number;
  lookbackWindowMs: number;
}

export const DEFAULT_BRIEFING_CONFIG: BriefingConfig = {
  enabled: true,
  scheduleHour: 8,
  scheduleMinute: 0,
  topicFilters: [],
  maxSections: DEFAULT_MAX_SECTIONS,
  maxItemsPerSection: DEFAULT_MAX_ITEMS_PER_SECTION,
  lookbackWindowMs: DEFAULT_LOOKBACK_WINDOW_MS,
};

export interface BriefingItem {
  content: string;
  type: MemoryType;
  importance: number;
  source: string;
  timestamp: Date;
}

export interface BriefingSection {
  type: BriefingSectionType;
  title: string;
  items: BriefingItem[];
  itemCount: number;
}

export interface Briefing {
  timestamp: Date;
  sections: BriefingSection[];
  totalItems: number;
  generatedInMs: number;
}

export interface BriefingMemoryResult {
  id: string;
  content: string;
  type: MemoryType;
  importance: number;
  tags: string[];
  source: string;
  createdAt: Date;
}

export interface BriefingRetrievalProvider {
  searchByType(
    types: MemoryType[],
    options: {
      limit: number;
      minImportance?: number;
      after?: Date;
    },
  ): Promise<Result<BriefingMemoryResult[]>>;

  searchByTags(
    tags: string[],
    options: {
      limit: number;
      after?: Date;
    },
  ): Promise<Result<BriefingMemoryResult[]>>;
}

export class MorningBriefingError extends ReinsError {
  constructor(message: string, code = "MORNING_BRIEFING_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "MorningBriefingError";
  }
}

export interface MorningBriefingServiceOptions {
  retrieval: BriefingRetrievalProvider;
  repository?: MemoryRepository;
  config?: Partial<BriefingConfig>;
  now?: () => Date;
}

const SECTION_TITLES: Record<BriefingSectionType, string> = {
  open_threads: "Open Threads & Action Items",
  high_importance: "High Importance Memories",
  recent_decisions: "Recent Decisions",
  upcoming: "Upcoming & Time-Sensitive",
  health_check: "Memory Health Check",
};

const SECTION_MEMORY_TYPES: Record<BriefingSectionType, MemoryType[]> = {
  open_threads: ["episode", "fact"],
  high_importance: ["fact", "preference", "skill", "entity"],
  recent_decisions: ["decision"],
  upcoming: ["episode", "fact"],
  health_check: [],
};

const SECTION_MIN_IMPORTANCE: Record<BriefingSectionType, number> = {
  open_threads: 0.3,
  high_importance: 0.7,
  recent_decisions: 0.4,
  upcoming: 0.3,
  health_check: 0,
};

const SECTION_TAGS: Record<BriefingSectionType, string[]> = {
  open_threads: ["action-item", "todo", "unresolved", "follow-up", "open"],
  high_importance: [],
  recent_decisions: [],
  upcoming: ["upcoming", "deadline", "scheduled", "reminder", "time-sensitive"],
  health_check: [],
};

function buildConfig(partial?: Partial<BriefingConfig>): BriefingConfig {
  return {
    enabled: partial?.enabled ?? DEFAULT_BRIEFING_CONFIG.enabled,
    scheduleHour: partial?.scheduleHour ?? DEFAULT_BRIEFING_CONFIG.scheduleHour,
    scheduleMinute: partial?.scheduleMinute ?? DEFAULT_BRIEFING_CONFIG.scheduleMinute,
    topicFilters: partial?.topicFilters ?? DEFAULT_BRIEFING_CONFIG.topicFilters,
    maxSections: partial?.maxSections ?? DEFAULT_BRIEFING_CONFIG.maxSections,
    maxItemsPerSection: partial?.maxItemsPerSection ?? DEFAULT_BRIEFING_CONFIG.maxItemsPerSection,
    lookbackWindowMs: partial?.lookbackWindowMs ?? DEFAULT_BRIEFING_CONFIG.lookbackWindowMs,
  };
}

function matchesTopicFilters(tags: string[], topicFilters: string[]): boolean {
  if (topicFilters.length === 0) {
    return true;
  }

  const lowerFilters = topicFilters.map((f) => f.toLowerCase());
  return tags.some((tag) => lowerFilters.includes(tag.toLowerCase()));
}

function toBriefingItem(result: BriefingMemoryResult): BriefingItem {
  return {
    content: result.content,
    type: result.type,
    importance: result.importance,
    source: result.source,
    timestamp: result.createdAt,
  };
}

function deduplicateResults(results: BriefingMemoryResult[]): BriefingMemoryResult[] {
  const seen = new Set<string>();
  const unique: BriefingMemoryResult[] = [];

  for (const result of results) {
    if (!seen.has(result.id)) {
      seen.add(result.id);
      unique.push(result);
    }
  }

  return unique;
}

const STALE_THRESHOLD_DAYS = 90;

function healthCheckContentPreview(content: string, maxLength: number = 60): string {
  const singleLine = content.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return singleLine.slice(0, maxLength - 3) + "...";
}

export class MorningBriefingService {
  private readonly retrieval: BriefingRetrievalProvider;
  private readonly repository: MemoryRepository | undefined;
  private readonly config: BriefingConfig;
  private readonly now: () => Date;

  constructor(options: MorningBriefingServiceOptions) {
    this.retrieval = options.retrieval;
    this.repository = options.repository;
    this.config = buildConfig(options.config);
    this.now = options.now ?? (() => new Date());
  }

  async generateBriefing(): Promise<Result<Briefing, MorningBriefingError>> {
    const startTime = Date.now();
    const timestamp = this.now();

    if (!this.config.enabled) {
      return ok({
        timestamp,
        sections: [],
        totalItems: 0,
        generatedInMs: elapsed(startTime),
      });
    }

    const lookbackCutoff = new Date(timestamp.getTime() - this.config.lookbackWindowMs);
    const sectionTypes = BRIEFING_SECTION_TYPES.slice(0, this.config.maxSections);
    const sections: BriefingSection[] = [];

    for (const sectionType of sectionTypes) {
      if (sectionType === "health_check") {
        continue;
      }

      const sectionResult = await this.buildSection(sectionType, lookbackCutoff);
      if (!sectionResult.ok) {
        return sectionResult;
      }

      if (sectionResult.value.items.length > 0) {
        sections.push(sectionResult.value);
      }
    }

    const healthCheckResult = await this.buildHealthCheckSection(timestamp);
    if (!healthCheckResult.ok) {
      return healthCheckResult;
    }

    if (healthCheckResult.value !== null) {
      sections.push(healthCheckResult.value);
    }

    const totalItems = sections.reduce((sum, section) => sum + section.itemCount, 0);

    return ok({
      timestamp,
      sections,
      totalItems,
      generatedInMs: elapsed(startTime),
    });
  }

  getConfig(): BriefingConfig {
    return { ...this.config };
  }

  private async buildHealthCheckSection(
    timestamp: Date,
  ): Promise<Result<BriefingSection | null, MorningBriefingError>> {
    if (!this.repository) {
      return ok(null);
    }

    try {
      const listResult = await this.repository.list();
      if (!listResult.ok) {
        return err(
          new MorningBriefingError(
            "Failed to retrieve memories for health check",
            "MORNING_BRIEFING_RETRIEVAL_FAILED",
            listResult.error,
          ),
        );
      }

      const staleRecords = getStaleMemories(listResult.value, STALE_THRESHOLD_DAYS);
      if (staleRecords.length === 0) {
        return ok(null);
      }

      const oldest = staleRecords.reduce<MemoryRecord>(
        (prev, curr) => (curr.accessedAt < prev.accessedAt ? curr : prev),
        staleRecords[0],
      );

      const relativeDate = formatRelativeDate(oldest.accessedAt, timestamp);
      const preview = healthCheckContentPreview(oldest.content);

      const summaryContent =
        `🧠 Memory Health Check\n\n` +
        `You have ${staleRecords.length} ${staleRecords.length === 1 ? "memory" : "memories"} that haven't been accessed in over 90 days.\n` +
        `Oldest: "${preview}" (last accessed ${relativeDate})\n\n` +
        `Consider reviewing your stored memories to keep them current.`;

      const item: BriefingItem = {
        content: summaryContent,
        type: "fact",
        importance: 0.5,
        source: "health_check",
        timestamp,
      };

      return ok({
        type: "health_check" as BriefingSectionType,
        title: SECTION_TITLES.health_check,
        items: [item],
        itemCount: staleRecords.length,
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return err(
        new MorningBriefingError(
          "Failed to build health check section",
          "MORNING_BRIEFING_RETRIEVAL_FAILED",
          error,
        ),
      );
    }
  }

  private async buildSection(
    sectionType: BriefingSectionType,
    after: Date,
  ): Promise<Result<BriefingSection, MorningBriefingError>> {
    const memoryTypes = SECTION_MEMORY_TYPES[sectionType];
    const minImportance = SECTION_MIN_IMPORTANCE[sectionType];
    const sectionTags = SECTION_TAGS[sectionType];
    const limit = this.config.maxItemsPerSection * 3;

    let allResults: BriefingMemoryResult[] = [];

    const typeResult = await this.retrieval.searchByType(memoryTypes, {
      limit,
      minImportance,
      after,
    });

    if (!typeResult.ok) {
      return err(
        new MorningBriefingError(
          `Failed to retrieve memories for section "${sectionType}"`,
          "MORNING_BRIEFING_RETRIEVAL_FAILED",
          typeResult.error,
        ),
      );
    }

    allResults.push(...typeResult.value);

    if (sectionTags.length > 0) {
      const tagResult = await this.retrieval.searchByTags(sectionTags, {
        limit,
        after,
      });

      if (tagResult.ok) {
        allResults.push(...tagResult.value);
      }
    }

    allResults = deduplicateResults(allResults);

    if (this.config.topicFilters.length > 0) {
      allResults = allResults.filter((result) =>
        matchesTopicFilters(result.tags, this.config.topicFilters),
      );
    }

    allResults.sort((a, b) => b.importance - a.importance);

    const limited = allResults.slice(0, this.config.maxItemsPerSection);
    const items = limited.map(toBriefingItem);

    return ok({
      type: sectionType,
      title: SECTION_TITLES[sectionType],
      items,
      itemCount: items.length,
    });
  }
}

function elapsed(startTime: number): number {
  return Math.max(0, Date.now() - startTime);
}

import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type {
  Briefing,
  BriefingItem,
  BriefingSection,
  MorningBriefingService,
} from "../../memory/proactive/morning-briefing-service";

export interface BriefingScheduleConfig {
  intervalMs: number;
  enabled: boolean;
}

export const DEFAULT_BRIEFING_SCHEDULE: BriefingScheduleConfig = {
  intervalMs: 24 * 60 * 60 * 1000,
  enabled: true,
};

export class BriefingJobError extends ReinsError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = "BriefingJobError";
  }
}

export interface BriefingJobOptions {
  service: MorningBriefingService;
  schedule?: Partial<BriefingScheduleConfig>;
  onComplete?: (briefing: Briefing) => void;
  onError?: (error: BriefingJobError) => void;
  now?: () => Date;
}

export class MorningBriefingJob {
  private readonly service: MorningBriefingService;
  private readonly schedule: BriefingScheduleConfig;
  private readonly onComplete: ((briefing: Briefing) => void) | undefined;
  private readonly onError: ((error: BriefingJobError) => void) | undefined;
  private readonly now: () => Date;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private executing = false;
  private lastRunAt: Date | undefined;
  private lastBriefing: Briefing | undefined;
  private runCount = 0;

  constructor(options: BriefingJobOptions) {
    this.service = options.service;
    this.schedule = {
      intervalMs: options.schedule?.intervalMs ?? DEFAULT_BRIEFING_SCHEDULE.intervalMs,
      enabled: options.schedule?.enabled ?? DEFAULT_BRIEFING_SCHEDULE.enabled,
    };
    this.onComplete = options.onComplete;
    this.onError = options.onError;
    this.now = options.now ?? (() => new Date());
  }

  start(): Result<void, BriefingJobError> {
    if (this.running) {
      return ok(undefined);
    }

    if (!this.schedule.enabled) {
      return err(
        new BriefingJobError(
          "Cannot start disabled briefing job",
          "BRIEFING_JOB_DISABLED",
        ),
      );
    }

    if (this.schedule.intervalMs <= 0) {
      return err(
        new BriefingJobError(
          "Briefing interval must be greater than zero",
          "BRIEFING_JOB_INVALID_INTERVAL",
        ),
      );
    }

    this.running = true;
    this.intervalId = setInterval(() => {
      void this.executeInternal();
    }, this.schedule.intervalMs);

    return ok(undefined);
  }

  stop(): void {
    this.running = false;

    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  async triggerNow(): Promise<Result<Briefing, BriefingJobError>> {
    if (this.executing) {
      return err(
        new BriefingJobError(
          "Briefing generation is already running",
          "BRIEFING_JOB_ALREADY_RUNNING",
        ),
      );
    }

    return this.executeInternal();
  }

  isRunning(): boolean {
    return this.running;
  }

  isExecuting(): boolean {
    return this.executing;
  }

  getLastRunAt(): Date | undefined {
    return this.lastRunAt;
  }

  getLastBriefing(): Briefing | undefined {
    return this.lastBriefing;
  }

  getRunCount(): number {
    return this.runCount;
  }

  getSchedule(): BriefingScheduleConfig {
    return { ...this.schedule };
  }

  /**
   * Generates a briefing and returns formatted messages ready for delivery.
   * Each section becomes a separate message per D-W3-2 decision.
   */
  async generateFormattedBriefing(): Promise<Result<FormattedBriefing, BriefingJobError>> {
    const result = await this.triggerNow();

    if (!result.ok) {
      return result;
    }

    return ok(formatBriefing(result.value));
  }

  private async executeInternal(): Promise<Result<Briefing, BriefingJobError>> {
    if (this.executing) {
      return err(
        new BriefingJobError(
          "Briefing generation is already running",
          "BRIEFING_JOB_ALREADY_RUNNING",
        ),
      );
    }

    this.executing = true;

    try {
      const result = await this.service.generateBriefing();

      if (!result.ok) {
        const jobError = new BriefingJobError(
          `Briefing generation failed: ${result.error.message}`,
          "BRIEFING_JOB_RUN_FAILED",
          result.error,
        );
        this.onError?.(jobError);
        return err(jobError);
      }

      this.lastRunAt = this.now();
      this.lastBriefing = result.value;
      this.runCount += 1;
      this.onComplete?.(result.value);

      return ok(result.value);
    } catch (error: unknown) {
      const cause = error instanceof Error ? error : undefined;
      const jobError = new BriefingJobError(
        "Unexpected error during briefing generation",
        "BRIEFING_JOB_UNEXPECTED_ERROR",
        cause,
      );
      this.onError?.(jobError);
      return err(jobError);
    } finally {
      this.executing = false;
    }
  }
}

// --- Briefing Formatting ---

export const NOTHING_TO_REPORT_MESSAGE = "Good morning! Nothing to report today.";

const SECTION_EMOJI: Record<string, string> = {
  open_threads: "\u{1F4CB}",
  high_importance: "\u{26A0}\u{FE0F}",
  recent_decisions: "\u{2705}",
  upcoming: "\u{1F4C5}",
};

export interface FormattedBriefingMessage {
  sectionType: string;
  text: string;
}

export interface FormattedBriefing {
  messages: FormattedBriefingMessage[];
  totalItems: number;
  timestamp: Date;
  isEmpty: boolean;
}

/**
 * Formats a Briefing object into an array of human-readable messages,
 * one per section. Empty briefings produce a single "Nothing to report" message.
 */
export function formatBriefing(briefing: Briefing): FormattedBriefing {
  if (briefing.totalItems === 0 || briefing.sections.length === 0) {
    return {
      messages: [{
        sectionType: "empty",
        text: NOTHING_TO_REPORT_MESSAGE,
      }],
      totalItems: 0,
      timestamp: briefing.timestamp,
      isEmpty: true,
    };
  }

  const messages: FormattedBriefingMessage[] = [];

  for (const section of briefing.sections) {
    const text = formatSection(section);
    if (text.length > 0) {
      messages.push({
        sectionType: section.type,
        text,
      });
    }
  }

  if (messages.length === 0) {
    return {
      messages: [{
        sectionType: "empty",
        text: NOTHING_TO_REPORT_MESSAGE,
      }],
      totalItems: 0,
      timestamp: briefing.timestamp,
      isEmpty: true,
    };
  }

  return {
    messages,
    totalItems: briefing.totalItems,
    timestamp: briefing.timestamp,
    isEmpty: false,
  };
}

function formatSection(section: BriefingSection): string {
  if (section.items.length === 0) {
    return "";
  }

  const emoji = SECTION_EMOJI[section.type] ?? "\u{1F4CC}";
  const header = `${emoji} ${section.title}`;
  const items = section.items.map((item) => formatItem(item));

  return [header, "", ...items].join("\n");
}

function formatItem(item: BriefingItem): string {
  const bullet = `\u{2022} ${item.content}`;
  if (item.source) {
    return `${bullet} (${item.source})`;
  }
  return bullet;
}

import type { Result } from "../../result";
import type {
  ConversationContext,
  Nudge,
  NudgeDecision,
  NudgeEngineError,
} from "./nudge-engine";
import type { NudgeFeedbackStore } from "./nudge-feedback-store";

const DEFAULT_MAX_EVALUATION_MS = 50;

export interface NudgeInjectorConfig {
  nudgesEnabled: boolean;
  maxEvaluationMs?: number;
}

export interface NudgeInjectorLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface NudgeEvaluator {
  evaluate(context: ConversationContext): Promise<Result<NudgeDecision, NudgeEngineError>>;
}

export interface NudgeInjectorOptions {
  nudgeEngine: NudgeEvaluator;
  feedbackStore?: NudgeFeedbackStore;
  config: NudgeInjectorConfig;
  logger?: NudgeInjectorLogger;
  now?: () => number;
}

export class NudgeInjector {
  private readonly nudgeEngine: NudgeEvaluator;
  private readonly feedbackStore?: NudgeFeedbackStore;
  private readonly config: NudgeInjectorConfig;
  private readonly logger?: NudgeInjectorLogger;
  private readonly now: () => number;

  constructor(options: NudgeInjectorOptions) {
    this.nudgeEngine = options.nudgeEngine;
    this.feedbackStore = options.feedbackStore;
    this.config = options.config;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  dismissNudge(topic: string): void {
    if (!this.feedbackStore) {
      this.logger?.warn("Nudge dismissal skipped: no feedback store configured", { topic });
      return;
    }

    this.feedbackStore.dismissTopic(topic);
    this.logger?.debug("Nudge topic dismissed", { topic });
  }

  async injectNudges(context: ConversationContext, systemPrompt: string): Promise<string> {
    if (!this.config.nudgesEnabled) {
      this.logger?.debug("Nudge injection skipped: disabled", {
        conversationId: context.conversationId,
      });
      return systemPrompt;
    }

    const startedAt = this.now();
    const evaluation = await this.nudgeEngine.evaluate(context);
    const durationMs = Math.max(0, this.now() - startedAt);
    const maxEvaluationMs = this.resolveMaxEvaluationMs();

    if (durationMs > maxEvaluationMs) {
      this.logger?.warn("Nudge injection skipped: evaluation exceeded latency gate", {
        conversationId: context.conversationId,
        durationMs,
        maxEvaluationMs,
      });
      return systemPrompt;
    }

    if (!evaluation.ok) {
      this.logger?.warn("Nudge injection skipped: nudge evaluation failed", {
        conversationId: context.conversationId,
        error: evaluation.error.message,
      });
      return systemPrompt;
    }

    if (!evaluation.value.shouldNudge || evaluation.value.nudges.length === 0) {
      return systemPrompt;
    }

    const addendum = this.buildNudgeAddendum(evaluation.value.nudges);
    return appendAddendum(systemPrompt, addendum);
  }

  private resolveMaxEvaluationMs(): number {
    const configured = this.config.maxEvaluationMs;
    if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 0) {
      return DEFAULT_MAX_EVALUATION_MS;
    }

    return configured;
  }

  private buildNudgeAddendum(nudges: Nudge[]): string {
    const lines = nudges.map((nudge, index) => `${index + 1}. ${nudge.content.trim()}`);
    return [
      "Nudge addendum:",
      "Use these relevant reminders only when they improve response quality:",
      ...lines,
    ].join("\n");
  }
}

function appendAddendum(systemPrompt: string, addendum: string): string {
  const normalizedBase = systemPrompt.trim();
  if (normalizedBase.length === 0) {
    return addendum;
  }

  return `${normalizedBase}\n\n${addendum}`;
}

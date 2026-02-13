import { ReinsError } from "../../errors";

export const IMPORTANCE_LEVELS = ["low", "medium", "high", "critical"] as const;

export type ImportanceLevel = (typeof IMPORTANCE_LEVELS)[number];

export interface ImportanceScorerConfig {
  reinforcementBoost: number;
  decayRate: number;
  decayWindowMs: number;
  minImportance: number;
  maxImportance: number;
}

export const DEFAULT_IMPORTANCE_SCORER_CONFIG: ImportanceScorerConfig = {
  reinforcementBoost: 0.2,
  decayRate: 0.08,
  decayWindowMs: 7 * 24 * 60 * 60 * 1000,
  minImportance: 0,
  maxImportance: 1,
};

export class ImportanceScorerError extends ReinsError {
  constructor(message: string) {
    super(message, "IMPORTANCE_SCORER_CONFIG_INVALID");
    this.name = "ImportanceScorerError";
  }
}

export class ImportanceScorer {
  private readonly config: ImportanceScorerConfig;

  constructor(config?: Partial<ImportanceScorerConfig>) {
    this.config = {
      reinforcementBoost: config?.reinforcementBoost ?? DEFAULT_IMPORTANCE_SCORER_CONFIG.reinforcementBoost,
      decayRate: config?.decayRate ?? DEFAULT_IMPORTANCE_SCORER_CONFIG.decayRate,
      decayWindowMs: config?.decayWindowMs ?? DEFAULT_IMPORTANCE_SCORER_CONFIG.decayWindowMs,
      minImportance: config?.minImportance ?? DEFAULT_IMPORTANCE_SCORER_CONFIG.minImportance,
      maxImportance: config?.maxImportance ?? DEFAULT_IMPORTANCE_SCORER_CONFIG.maxImportance,
    };

    if (this.config.minImportance < 0 || this.config.maxImportance > 1 || this.config.minImportance >= this.config.maxImportance) {
      throw new ImportanceScorerError("importance bounds must satisfy 0 <= min < max <= 1");
    }
    if (this.config.reinforcementBoost < 0) {
      throw new ImportanceScorerError("reinforcementBoost must be >= 0");
    }
    if (this.config.decayRate < 0) {
      throw new ImportanceScorerError("decayRate must be >= 0");
    }
    if (this.config.decayWindowMs <= 0) {
      throw new ImportanceScorerError("decayWindowMs must be > 0");
    }
  }

  reinforce(currentScore: number, reinforcementCount: number): number {
    const normalizedCurrent = this.clamp(currentScore);
    if (reinforcementCount <= 0) {
      return normalizedCurrent;
    }

    const distanceToMax = this.config.maxImportance - normalizedCurrent;
    let score = normalizedCurrent;

    for (let index = 0; index < reinforcementCount; index += 1) {
      const diminishingFactor = 1 / (index + 1);
      score += distanceToMax * this.config.reinforcementBoost * diminishingFactor;
      score = this.clamp(score);
      if (score >= this.config.maxImportance) {
        break;
      }
    }

    return this.clamp(score);
  }

  decay(currentScore: number, lastAccessedAt: Date, now: Date = new Date()): number {
    const normalizedCurrent = this.clamp(currentScore);
    const elapsedMs = Math.max(0, now.getTime() - lastAccessedAt.getTime());
    if (elapsedMs < this.config.decayWindowMs) {
      return normalizedCurrent;
    }

    const windowsElapsed = elapsedMs / this.config.decayWindowMs;
    const decayPenalty = this.config.decayRate * windowsElapsed;
    return this.clamp(normalizedCurrent - decayPenalty);
  }

  computeLevel(numericScore: number): ImportanceLevel {
    const score = this.clamp(numericScore);
    if (score >= 0.85) {
      return "critical";
    }
    if (score >= 0.6) {
      return "high";
    }
    if (score >= 0.3) {
      return "medium";
    }
    return "low";
  }

  private clamp(value: number): number {
    if (!Number.isFinite(value)) {
      return this.config.minImportance;
    }
    return Math.min(this.config.maxImportance, Math.max(this.config.minImportance, value));
  }
}

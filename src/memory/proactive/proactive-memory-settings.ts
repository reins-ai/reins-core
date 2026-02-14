import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";

export type ProactiveFeature = "priming" | "briefing" | "nudges" | "patterns";

export const PROACTIVE_FEATURES: readonly ProactiveFeature[] = [
  "priming",
  "briefing",
  "nudges",
  "patterns",
] as const;

export interface PrimingSettings {
  enabled: boolean;
  maxTokens: number;
  maxMemories: number;
  minRelevanceScore: number;
}

export interface BriefingSettings {
  enabled: boolean;
  scheduleHour: number;
  scheduleMinute: number;
  topicFilters: string[];
  maxSections: number;
}

export interface NudgeSettings {
  enabled: boolean;
  maxPerTurn: number;
  minRelevanceScore: number;
  cooldownMs: number;
}

export interface PatternSettings {
  enabled: boolean;
  minOccurrences: number;
  promotionThreshold: number;
}

export interface ProactiveMemorySettings {
  enabled: boolean;
  priming: PrimingSettings;
  briefing: BriefingSettings;
  nudges: NudgeSettings;
  patterns: PatternSettings;
}

export const DEFAULT_PRIMING_SETTINGS: PrimingSettings = {
  enabled: true,
  maxTokens: 2048,
  maxMemories: 5,
  minRelevanceScore: 0.3,
};

export const DEFAULT_BRIEFING_SETTINGS: BriefingSettings = {
  enabled: true,
  scheduleHour: 8,
  scheduleMinute: 0,
  topicFilters: [],
  maxSections: 4,
};

export const DEFAULT_NUDGE_SETTINGS: NudgeSettings = {
  enabled: true,
  maxPerTurn: 2,
  minRelevanceScore: 0.5,
  cooldownMs: 5 * 60 * 1000,
};

export const DEFAULT_PATTERN_SETTINGS: PatternSettings = {
  enabled: true,
  minOccurrences: 3,
  promotionThreshold: 0.7,
};

export const DEFAULT_PROACTIVE_MEMORY_SETTINGS: ProactiveMemorySettings = {
  enabled: true,
  priming: { ...DEFAULT_PRIMING_SETTINGS },
  briefing: { ...DEFAULT_BRIEFING_SETTINGS },
  nudges: { ...DEFAULT_NUDGE_SETTINGS },
  patterns: { ...DEFAULT_PATTERN_SETTINGS },
};

export class ProactiveMemorySettingsError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "PROACTIVE_MEMORY_SETTINGS_ERROR", cause);
    this.name = "ProactiveMemorySettingsError";
  }
}

function isValidFeature(value: string): value is ProactiveFeature {
  return PROACTIVE_FEATURES.includes(value as ProactiveFeature);
}

function deepCloneSettings(settings: ProactiveMemorySettings): ProactiveMemorySettings {
  return {
    enabled: settings.enabled,
    priming: { ...settings.priming },
    briefing: {
      ...settings.briefing,
      topicFilters: [...settings.briefing.topicFilters],
    },
    nudges: { ...settings.nudges },
    patterns: { ...settings.patterns },
  };
}

function validatePrimingSettings(priming: PrimingSettings): string | null {
  if (priming.maxTokens < 0) {
    return "priming.maxTokens must be >= 0";
  }
  if (priming.maxMemories < 0) {
    return "priming.maxMemories must be >= 0";
  }
  if (priming.minRelevanceScore < 0 || priming.minRelevanceScore > 1) {
    return "priming.minRelevanceScore must be between 0 and 1";
  }
  return null;
}

function validateBriefingSettings(briefing: BriefingSettings): string | null {
  if (briefing.scheduleHour < 0 || briefing.scheduleHour > 23) {
    return "briefing.scheduleHour must be between 0 and 23";
  }
  if (briefing.scheduleMinute < 0 || briefing.scheduleMinute > 59) {
    return "briefing.scheduleMinute must be between 0 and 59";
  }
  if (briefing.maxSections < 0) {
    return "briefing.maxSections must be >= 0";
  }
  return null;
}

function validateNudgeSettings(nudges: NudgeSettings): string | null {
  if (nudges.maxPerTurn < 0) {
    return "nudges.maxPerTurn must be >= 0";
  }
  if (nudges.minRelevanceScore < 0 || nudges.minRelevanceScore > 1) {
    return "nudges.minRelevanceScore must be between 0 and 1";
  }
  if (nudges.cooldownMs < 0) {
    return "nudges.cooldownMs must be >= 0";
  }
  return null;
}

function validatePatternSettings(patterns: PatternSettings): string | null {
  if (patterns.minOccurrences < 2) {
    return "patterns.minOccurrences must be >= 2";
  }
  if (patterns.promotionThreshold < 0 || patterns.promotionThreshold > 1) {
    return "patterns.promotionThreshold must be between 0 and 1";
  }
  return null;
}

function validateSettings(settings: ProactiveMemorySettings): string | null {
  const primingError = validatePrimingSettings(settings.priming);
  if (primingError) return primingError;

  const briefingError = validateBriefingSettings(settings.briefing);
  if (briefingError) return briefingError;

  const nudgeError = validateNudgeSettings(settings.nudges);
  if (nudgeError) return nudgeError;

  const patternError = validatePatternSettings(settings.patterns);
  if (patternError) return patternError;

  return null;
}

export class ProactiveMemorySettingsManager {
  private settings: ProactiveMemorySettings;

  constructor(initial?: Partial<ProactiveMemorySettings>) {
    this.settings = deepCloneSettings(DEFAULT_PROACTIVE_MEMORY_SETTINGS);

    if (initial) {
      this.applyPartial(initial);
    }
  }

  getSettings(): ProactiveMemorySettings {
    return deepCloneSettings(this.settings);
  }

  updateSettings(
    partial: Partial<ProactiveMemorySettings>,
  ): Result<ProactiveMemorySettings, ProactiveMemorySettingsError> {
    const candidate = deepCloneSettings(this.settings);

    if (partial.enabled !== undefined) {
      candidate.enabled = partial.enabled;
    }

    if (partial.priming) {
      Object.assign(candidate.priming, partial.priming);
    }

    if (partial.briefing) {
      if (partial.briefing.topicFilters !== undefined) {
        candidate.briefing.topicFilters = [...partial.briefing.topicFilters];
      }
      const { topicFilters: _tf, ...rest } = partial.briefing;
      Object.assign(candidate.briefing, rest);
    }

    if (partial.nudges) {
      Object.assign(candidate.nudges, partial.nudges);
    }

    if (partial.patterns) {
      Object.assign(candidate.patterns, partial.patterns);
    }

    const validationError = validateSettings(candidate);
    if (validationError) {
      return err(new ProactiveMemorySettingsError(validationError));
    }

    this.settings = candidate;
    return ok(deepCloneSettings(this.settings));
  }

  resetToDefaults(): ProactiveMemorySettings {
    this.settings = deepCloneSettings(DEFAULT_PROACTIVE_MEMORY_SETTINGS);
    return deepCloneSettings(this.settings);
  }

  enableFeature(
    feature: string,
  ): Result<ProactiveMemorySettings, ProactiveMemorySettingsError> {
    if (!isValidFeature(feature)) {
      return err(
        new ProactiveMemorySettingsError(
          `Invalid feature '${feature}'. Valid features: ${PROACTIVE_FEATURES.join(", ")}`,
        ),
      );
    }

    this.settings[feature].enabled = true;
    return ok(deepCloneSettings(this.settings));
  }

  disableFeature(
    feature: string,
  ): Result<ProactiveMemorySettings, ProactiveMemorySettingsError> {
    if (!isValidFeature(feature)) {
      return err(
        new ProactiveMemorySettingsError(
          `Invalid feature '${feature}'. Valid features: ${PROACTIVE_FEATURES.join(", ")}`,
        ),
      );
    }

    this.settings[feature].enabled = false;
    return ok(deepCloneSettings(this.settings));
  }

  getFeatureEnabled(feature: string): Result<boolean, ProactiveMemorySettingsError> {
    if (!isValidFeature(feature)) {
      return err(
        new ProactiveMemorySettingsError(
          `Invalid feature '${feature}'. Valid features: ${PROACTIVE_FEATURES.join(", ")}`,
        ),
      );
    }

    if (!this.settings.enabled) {
      return ok(false);
    }

    return ok(this.settings[feature].enabled);
  }

  setFeatureSetting(
    feature: string,
    key: string,
    value: unknown,
  ): Result<ProactiveMemorySettings, ProactiveMemorySettingsError> {
    if (!isValidFeature(feature)) {
      return err(
        new ProactiveMemorySettingsError(
          `Invalid feature '${feature}'. Valid features: ${PROACTIVE_FEATURES.join(", ")}`,
        ),
      );
    }

    const featureSettings = this.settings[feature] as unknown as Record<string, unknown>;
    if (!(key in featureSettings)) {
      const validKeys = Object.keys(featureSettings).join(", ");
      return err(
        new ProactiveMemorySettingsError(
          `Invalid setting '${key}' for feature '${feature}'. Valid keys: ${validKeys}`,
        ),
      );
    }

    const existingType = typeof featureSettings[key];
    if (existingType === "boolean") {
      if (typeof value !== "boolean") {
        return err(
          new ProactiveMemorySettingsError(
            `Setting '${feature}.${key}' expects a boolean value`,
          ),
        );
      }
    } else if (existingType === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return err(
          new ProactiveMemorySettingsError(
            `Setting '${feature}.${key}' expects a finite number value`,
          ),
        );
      }
    } else if (Array.isArray(featureSettings[key])) {
      if (!Array.isArray(value)) {
        return err(
          new ProactiveMemorySettingsError(
            `Setting '${feature}.${key}' expects an array value`,
          ),
        );
      }
    }

    const candidate = deepCloneSettings(this.settings);
    const candidateFeature = candidate[feature] as unknown as Record<string, unknown>;
    candidateFeature[key] = Array.isArray(value) ? [...value] : value;

    const validationError = validateSettings(candidate);
    if (validationError) {
      return err(new ProactiveMemorySettingsError(validationError));
    }

    this.settings = candidate;
    return ok(deepCloneSettings(this.settings));
  }

  serialize(): string {
    return JSON.stringify(this.settings, null, 2);
  }

  static deserialize(
    json: string,
  ): Result<ProactiveMemorySettingsManager, ProactiveMemorySettingsError> {
    try {
      const parsed = JSON.parse(json) as ProactiveMemorySettings;

      if (typeof parsed !== "object" || parsed === null) {
        return err(
          new ProactiveMemorySettingsError("Invalid settings JSON: expected an object"),
        );
      }

      const validationError = validateSettings(parsed);
      if (validationError) {
        return err(new ProactiveMemorySettingsError(`Invalid settings: ${validationError}`));
      }

      const manager = new ProactiveMemorySettingsManager();
      manager.settings = deepCloneSettings(parsed);
      return ok(manager);
    } catch (error: unknown) {
      return err(
        new ProactiveMemorySettingsError(
          "Failed to parse settings JSON",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  private applyPartial(partial: Partial<ProactiveMemorySettings>): void {
    if (partial.enabled !== undefined) {
      this.settings.enabled = partial.enabled;
    }
    if (partial.priming) {
      Object.assign(this.settings.priming, partial.priming);
    }
    if (partial.briefing) {
      if (partial.briefing.topicFilters !== undefined) {
        this.settings.briefing.topicFilters = [...partial.briefing.topicFilters];
      }
      const { topicFilters: _tf, ...rest } = partial.briefing;
      Object.assign(this.settings.briefing, rest);
    }
    if (partial.nudges) {
      Object.assign(this.settings.nudges, partial.nudges);
    }
    if (partial.patterns) {
      Object.assign(this.settings.patterns, partial.patterns);
    }
  }
}

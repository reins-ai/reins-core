import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getDataRoot } from "../daemon/paths";
import { err, ok, type Result } from "../result";

import {
  ONBOARDING_CHECKPOINT_VERSION,
  ONBOARDING_STEPS,
  type CompletedStepRecord,
  type MigrationState,
  type OnboardingConfig,
  type OnboardingMode,
  type OnboardingStep,
  type PersonalityConfig,
  type PersonalityPreset,
} from "./types";

const CHECKPOINT_FILENAME = "onboarding.json";

export class OnboardingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: Error,
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

export interface CheckpointServiceOptions {
  dataRoot?: string;
}

export class OnboardingCheckpointService {
  private readonly dataRoot: string;

  constructor(options?: CheckpointServiceOptions) {
    this.dataRoot = options?.dataRoot ?? getDataRoot();
  }

  private get checkpointPath(): string {
    return join(this.dataRoot, CHECKPOINT_FILENAME);
  }

  async load(): Promise<Result<OnboardingConfig | null, OnboardingError>> {
    const file = Bun.file(this.checkpointPath);

    if (!(await file.exists())) {
      return ok(null);
    }

    try {
      const raw = await file.json();
      return ok(normalizeCheckpoint(raw));
    } catch {
      // Corrupt file — treat as no checkpoint
      return ok(null);
    }
  }

  async save(checkpoint: OnboardingConfig): Promise<Result<void, OnboardingError>> {
    try {
      await mkdir(dirname(this.checkpointPath), { recursive: true });
      await Bun.write(
        this.checkpointPath,
        `${JSON.stringify(checkpoint, null, 2)}\n`,
      );
      return ok(undefined);
    } catch (error) {
      return err(
        new OnboardingError(
          `Failed to save onboarding checkpoint: ${this.checkpointPath}`,
          "CHECKPOINT_WRITE_FAILED",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  async completeStep(
    step: OnboardingStep,
    mode: OnboardingMode,
  ): Promise<Result<void, OnboardingError>> {
    const loadResult = await this.load();
    if (!loadResult.ok) {
      return loadResult;
    }

    const existing = loadResult.value ?? createFreshCheckpoint(mode);

    // Don't duplicate if step already completed
    const alreadyCompleted = existing.completedSteps.some(
      (record) => record.step === step,
    );

    const completedSteps: CompletedStepRecord[] = alreadyCompleted
      ? existing.completedSteps
      : [
          ...existing.completedSteps,
          {
            step,
            completedAt: new Date().toISOString(),
            mode,
          },
        ];

    const allComplete = ONBOARDING_STEPS.every((s) =>
      completedSteps.some((record) => record.step === s),
    );

    const nextStep = allComplete
      ? null
      : getNextIncompleteStep(completedSteps);

    const updated: OnboardingConfig = {
      ...existing,
      mode,
      currentStep: nextStep,
      completedSteps,
      setupComplete: allComplete,
      completedAt: allComplete ? new Date().toISOString() : existing.completedAt,
    };

    return this.save(updated);
  }

  async isComplete(): Promise<Result<boolean, OnboardingError>> {
    const loadResult = await this.load();
    if (!loadResult.ok) {
      return loadResult;
    }

    if (loadResult.value === null) {
      return ok(false);
    }

    return ok(loadResult.value.setupComplete);
  }

  async getResumeStep(): Promise<Result<OnboardingStep | null, OnboardingError>> {
    const loadResult = await this.load();
    if (!loadResult.ok) {
      return loadResult;
    }

    if (loadResult.value === null) {
      return ok(null);
    }

    if (loadResult.value.setupComplete) {
      return ok(null);
    }

    return ok(getNextIncompleteStep(loadResult.value.completedSteps));
  }

  async reset(): Promise<Result<void, OnboardingError>> {
    const file = Bun.file(this.checkpointPath);

    if (!(await file.exists())) {
      return ok(undefined);
    }

    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(this.checkpointPath);
      return ok(undefined);
    } catch (error) {
      return err(
        new OnboardingError(
          `Failed to reset onboarding checkpoint: ${this.checkpointPath}`,
          "CHECKPOINT_RESET_FAILED",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }
}

function createFreshCheckpoint(mode: OnboardingMode): OnboardingConfig {
  return {
    version: ONBOARDING_CHECKPOINT_VERSION,
    setupComplete: false,
    mode,
    currentStep: ONBOARDING_STEPS[0],
    completedSteps: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

function getNextIncompleteStep(
  completedSteps: CompletedStepRecord[],
): OnboardingStep | null {
  const completedSet = new Set(completedSteps.map((r) => r.step));

  for (const step of ONBOARDING_STEPS) {
    if (!completedSet.has(step)) {
      return step;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeCheckpoint(value: unknown): OnboardingConfig {
  if (!isRecord(value)) {
    return createFreshCheckpoint("quickstart");
  }

  const mode = value.mode === "quickstart" || value.mode === "advanced"
    ? value.mode
    : "quickstart";

  const completedSteps = Array.isArray(value.completedSteps)
    ? value.completedSteps.filter(isValidCompletedStepRecord)
    : [];

  const currentStep = typeof value.currentStep === "string" &&
    ONBOARDING_STEPS.includes(value.currentStep as OnboardingStep)
    ? (value.currentStep as OnboardingStep)
    : null;

  const version = typeof value.version === "number" ? value.version : ONBOARDING_CHECKPOINT_VERSION;

  return {
    version,
    setupComplete: value.setupComplete === true,
    mode,
    currentStep,
    completedSteps,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : new Date().toISOString(),
    completedAt: typeof value.completedAt === "string" ? value.completedAt : null,
    userName: typeof value.userName === "string" ? value.userName : undefined,
    personality: isRecord(value.personality) ? normalizePersonality(value.personality) : undefined,
    migrationState: isRecord(value.migrationState)
      ? normalizeMigrationState(value.migrationState)
      : undefined,
  };
}

function isValidCompletedStepRecord(value: unknown): value is CompletedStepRecord {
  if (!isRecord(value)) return false;
  if (typeof value.step !== "string") return false;
  if (!ONBOARDING_STEPS.includes(value.step as OnboardingStep)) return false;
  if (typeof value.completedAt !== "string") return false;
  if (value.mode !== "quickstart" && value.mode !== "advanced") return false;
  return true;
}

const VALID_PRESETS: readonly PersonalityPreset[] = [
  "balanced",
  "concise",
  "technical",
  "warm",
  "custom",
];

function isValidPreset(value: string): value is PersonalityPreset {
  return VALID_PRESETS.includes(value as PersonalityPreset);
}

function normalizePersonality(
  value: Record<string, unknown>,
): PersonalityConfig {
  const preset: PersonalityPreset =
    typeof value.preset === "string" && isValidPreset(value.preset)
      ? value.preset
      : "balanced";
  const customPrompt = typeof value.customPrompt === "string"
    ? value.customPrompt
    : undefined;

  return { preset, customPrompt };
}

function normalizeMigrationState(value: Record<string, unknown>): MigrationState {
  return {
    detected: value.detected === true,
    detectedPath: typeof value.detectedPath === "string" ? value.detectedPath : null,
    selectedCategories: Array.isArray(value.selectedCategories)
      ? value.selectedCategories.filter((c): c is string => typeof c === "string")
      : [],
    conversionStarted: value.conversionStarted === true,
    conversionComplete: value.conversionComplete === true,
  };
}

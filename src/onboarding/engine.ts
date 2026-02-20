import { err, ok, type Result } from "../result";
import { generatePersonalityMarkdown } from "../environment/templates/personality.md";

import {
  OnboardingError,
  type OnboardingCheckpointService,
} from "./checkpoint-service";
import {
  ONBOARDING_CHECKPOINT_VERSION,
  ONBOARDING_STEPS,
  type PersonalityConfig,
  type PersonalityPreset,
  type CompletedStepRecord,
  type OnboardingConfig,
  type OnboardingMode,
  type OnboardingStep,
} from "./types";

/** Interface that each wizard step handler must implement. */
export interface OnboardingStepHandler {
  /** Unique step identifier */
  readonly step: OnboardingStep;
  /** Whether this step can be skipped */
  readonly skippable: boolean;
  /** Execute the step. Returns collected data or null if skipped. */
  execute(context: StepExecutionContext): Promise<StepResult>;
  /** Get default values for QuickStart mode */
  getDefaults(): StepDefaults;
}

export interface StepExecutionContext {
  mode: OnboardingMode;
  config: OnboardingConfig;
  /** Previous step results (accumulated) */
  collectedData: Record<string, unknown>;
}

export interface StepResult {
  status: "completed" | "skipped" | "back";
  data?: Record<string, unknown>;
}

export interface StepDefaults {
  [key: string]: unknown;
}

/** Events emitted during onboarding lifecycle */
export type OnboardingEvent =
  | { type: "stepEnter"; step: OnboardingStep }
  | { type: "stepComplete"; step: OnboardingStep; data?: Record<string, unknown> }
  | { type: "stepSkip"; step: OnboardingStep }
  | { type: "wizardComplete"; config: OnboardingConfig };

export type OnboardingEventListener = (event: OnboardingEvent) => void;

export interface OnboardingEngineOptions {
  checkpoint: OnboardingCheckpointService;
  steps?: OnboardingStepHandler[];
  onEvent?: OnboardingEventListener;
}

export interface EngineState {
  currentStep: OnboardingStep | null;
  currentStepIndex: number;
  totalSteps: number;
  mode: OnboardingMode;
  isComplete: boolean;
  completedSteps: OnboardingStep[];
  skippedSteps: OnboardingStep[];
}

export class OnboardingEngine {
  private readonly checkpoint: OnboardingCheckpointService;
  private readonly stepHandlers: Map<OnboardingStep, OnboardingStepHandler>;
  private readonly stepOrder: readonly OnboardingStep[];
  private readonly onEvent?: OnboardingEventListener;
  private currentStepIndex: number;
  private mode: OnboardingMode;
  private collectedData: Record<string, unknown>;
  private config: OnboardingConfig | null;
  private readonly completedStepRecords: Map<OnboardingStep, CompletedStepRecord>;
  private readonly skippedStepSet: Set<OnboardingStep>;

  constructor(options: OnboardingEngineOptions) {
    this.checkpoint = options.checkpoint;
    this.stepHandlers = new Map<OnboardingStep, OnboardingStepHandler>();
    this.stepOrder = ONBOARDING_STEPS;
    this.onEvent = options.onEvent;
    this.currentStepIndex = 0;
    this.mode = "quickstart";
    this.collectedData = {};
    this.config = null;
    this.completedStepRecords = new Map<OnboardingStep, CompletedStepRecord>();
    this.skippedStepSet = new Set<OnboardingStep>();

    for (const handler of options.steps ?? []) {
      this.registerStep(handler);
    }
  }

  /** Initialize the engine — loads checkpoint, determines starting state. */
  async initialize(): Promise<Result<EngineState, OnboardingError>> {
    const loadResult = await this.checkpoint.load();
    if (!loadResult.ok) {
      return loadResult;
    }

    const checkpoint = loadResult.value;
    if (checkpoint === null) {
      this.mode = "quickstart";
      this.currentStepIndex = 0;
      this.collectedData = {};
      this.config = this.buildConfigFromCurrentState();
      this.emitCurrentStepEnter();
      return ok(this.getState());
    }

    this.mode = checkpoint.mode;
    this.config = checkpoint;
    this.completedStepRecords.clear();

    for (const record of checkpoint.completedSteps) {
      this.completedStepRecords.set(record.step, record);
    }

    if (checkpoint.setupComplete) {
      this.currentStepIndex = this.stepOrder.length;
    } else {
      const resumeStep = checkpoint.currentStep ?? this.findNextIncompleteStep();
      this.currentStepIndex = resumeStep === null
        ? this.stepOrder.length
        : this.stepOrder.indexOf(resumeStep);
    }

    if (!this.isComplete()) {
      this.emitCurrentStepEnter();
    }

    return ok(this.getState());
  }

  /** Register a step handler. */
  registerStep(handler: OnboardingStepHandler): void {
    if (this.stepHandlers.has(handler.step)) {
      throw new OnboardingError(
        `Step handler already registered for step: ${handler.step}`,
        "STEP_HANDLER_ALREADY_REGISTERED",
      );
    }

    this.stepHandlers.set(handler.step, handler);
  }

  /** Get current engine state. */
  getState(): EngineState {
    const completedSteps = this.stepOrder.filter((step) =>
      this.completedStepRecords.has(step)
    );
    const skippedSteps = this.stepOrder.filter((step) =>
      this.skippedStepSet.has(step)
    );

    return {
      currentStep: this.getCurrentStep(),
      currentStepIndex: this.currentStepIndex,
      totalSteps: this.stepOrder.length,
      mode: this.mode,
      isComplete: this.isComplete(),
      completedSteps,
      skippedSteps,
    };
  }

  /** Set wizard mode. */
  setMode(mode: OnboardingMode): void {
    this.mode = mode;
  }

  /** Advance to the next step. */
  async next(): Promise<Result<EngineState, OnboardingError>> {
    if (this.isComplete()) {
      return ok(this.getState());
    }

    this.currentStepIndex = Math.min(this.currentStepIndex + 1, this.stepOrder.length);
    return this.afterIndexChange();
  }

  /** Go back to the previous step. */
  async back(): Promise<Result<EngineState, OnboardingError>> {
    if (this.currentStepIndex <= 0) {
      return ok(this.getState());
    }

    this.currentStepIndex -= 1;
    this.emitCurrentStepEnter();
    return ok(this.getState());
  }

  /** Skip the current step (if skippable). */
  async skip(): Promise<Result<EngineState, OnboardingError>> {
    const currentStep = this.getCurrentStep();
    if (currentStep === null) {
      return err(new OnboardingError("No active step to skip", "STEP_NOT_ACTIVE"));
    }

    const handler = this.stepHandlers.get(currentStep);
    if (!handler) {
      return err(
        new OnboardingError(
          `Missing step handler for step: ${currentStep}`,
          "STEP_HANDLER_MISSING",
        ),
      );
    }

    if (!handler.skippable) {
      return err(
        new OnboardingError(
          `Step is not skippable: ${currentStep}`,
          "STEP_NOT_SKIPPABLE",
        ),
      );
    }

    this.skippedStepSet.add(currentStep);
    this.onEvent?.({ type: "stepSkip", step: currentStep });
    this.currentStepIndex += 1;

    const persistResult = await this.persistCheckpoint();
    if (!persistResult.ok) {
      return persistResult;
    }

    return this.afterIndexChange();
  }

  /** Complete the current step with data. */
  async completeCurrentStep(
    data?: Record<string, unknown>,
  ): Promise<Result<EngineState, OnboardingError>> {
    const currentStep = this.getCurrentStep();
    if (currentStep === null) {
      return err(new OnboardingError("No active step to complete", "STEP_NOT_ACTIVE"));
    }

    const handler = this.stepHandlers.get(currentStep);
    if (!handler) {
      return err(
        new OnboardingError(
          `Missing step handler for step: ${currentStep}`,
          "STEP_HANDLER_MISSING",
        ),
      );
    }

    const executeResult = await handler.execute({
      mode: this.mode,
      config: this.buildConfigFromCurrentState(),
      collectedData: {
        ...this.collectedData,
        ...(data ?? {}),
      },
    });

    if (executeResult.status === "back") {
      return this.back();
    }

    if (executeResult.status === "skipped") {
      if (!handler.skippable) {
        return err(
          new OnboardingError(
            `Step is not skippable: ${currentStep}`,
            "STEP_NOT_SKIPPABLE",
          ),
        );
      }

      this.skippedStepSet.add(currentStep);
      this.onEvent?.({ type: "stepSkip", step: currentStep });
      this.currentStepIndex += 1;

      const persistSkippedResult = await this.persistCheckpoint();
      if (!persistSkippedResult.ok) {
        return persistSkippedResult;
      }

      return this.afterIndexChange();
    }

    const finalData = data
      ? { ...(executeResult.data ?? {}), ...data }
      : this.mode === "quickstart"
        ? handler.getDefaults()
        : executeResult.data;
    if (finalData) {
      this.collectedData = {
        ...this.collectedData,
        ...finalData,
      };
    }

    this.completedStepRecords.set(currentStep, {
      step: currentStep,
      completedAt: new Date().toISOString(),
      mode: this.mode,
    });
    this.skippedStepSet.delete(currentStep);

    this.onEvent?.({ type: "stepComplete", step: currentStep, data: finalData });

    this.currentStepIndex += 1;

    const persistResult = await this.persistCheckpoint();
    if (!persistResult.ok) {
      return persistResult;
    }

    return this.afterIndexChange();
  }

  /** Check if onboarding is finished. */
  isComplete(): boolean {
    return this.currentStepIndex >= this.stepOrder.length;
  }

  /** Get accumulated data from all completed steps. */
  getCollectedData(): Record<string, unknown> {
    return { ...this.collectedData };
  }

  /** Get the selected personality preset, defaulting to "balanced". */
  getPersonalityPreset(): PersonalityPreset {
    const personality = this.readPersonalityConfig(this.collectedData);
    return personality?.preset ?? this.config?.personality?.preset ?? "balanced";
  }

  /**
   * Generate PERSONALITY.md content using the selected preset.
   *
   * Uses the collected personality preset and optional custom instructions
   * to produce preset-specific markdown content via `generatePersonalityMarkdown()`.
   */
  generatePersonalityContent(): string {
    const preset = this.getPersonalityPreset();
    const customInstructions = preset === "custom"
      ? (typeof this.collectedData.customPrompt === "string"
        ? this.collectedData.customPrompt
        : this.config?.personality?.customPrompt)
      : undefined;
    return generatePersonalityMarkdown(preset, customInstructions);
  }

  private getCurrentStep(): OnboardingStep | null {
    if (this.currentStepIndex < 0 || this.currentStepIndex >= this.stepOrder.length) {
      return null;
    }

    return this.stepOrder[this.currentStepIndex];
  }

  private findNextIncompleteStep(): OnboardingStep | null {
    for (const step of this.stepOrder) {
      if (!this.completedStepRecords.has(step)) {
        return step;
      }
    }

    return null;
  }

  private async afterIndexChange(): Promise<Result<EngineState, OnboardingError>> {
    if (this.isComplete()) {
      const config = this.buildConfigFromCurrentState();
      this.config = config;
      this.onEvent?.({ type: "wizardComplete", config });
      return ok(this.getState());
    }

    this.emitCurrentStepEnter();
    return ok(this.getState());
  }

  private emitCurrentStepEnter(): void {
    const currentStep = this.getCurrentStep();
    if (currentStep !== null) {
      this.onEvent?.({ type: "stepEnter", step: currentStep });
    }
  }

  private buildConfigFromCurrentState(): OnboardingConfig {
    const isComplete = this.isComplete();
    const completedSteps = this.stepOrder
      .map((step) => this.completedStepRecords.get(step))
      .filter((record): record is CompletedStepRecord => record !== undefined);

    const previousStartedAt = this.config?.startedAt;
    const startedAt = previousStartedAt ?? new Date().toISOString();

    const currentStep = isComplete ? null : this.getCurrentStep();

    const collectedUserName = typeof this.collectedData.userName === "string"
      ? this.collectedData.userName
      : undefined;
    const collectedPersonality = this.readPersonalityConfig(this.collectedData);

    return {
      version: this.config?.version ?? ONBOARDING_CHECKPOINT_VERSION,
      setupComplete: isComplete,
      mode: this.mode,
      currentStep,
      completedSteps,
      startedAt,
      completedAt: isComplete ? new Date().toISOString() : this.config?.completedAt ?? null,
      userName: collectedUserName ?? this.config?.userName,
      personality: collectedPersonality ?? this.config?.personality,
    };
  }

  private readPersonalityConfig(data: Record<string, unknown>): PersonalityConfig | undefined {
    const presetCandidate = data.preset ?? data.personalityPreset;
    if (
      presetCandidate !== "balanced"
      && presetCandidate !== "concise"
      && presetCandidate !== "technical"
      && presetCandidate !== "warm"
      && presetCandidate !== "custom"
    ) {
      return undefined;
    }

    const customPrompt = typeof data.customPrompt === "string"
      ? data.customPrompt
      : undefined;

    return {
      preset: presetCandidate,
      customPrompt,
    };
  }

  private async persistCheckpoint(): Promise<Result<void, OnboardingError>> {
    const config = this.buildConfigFromCurrentState();
    this.config = config;
    return this.checkpoint.save(config);
  }
}

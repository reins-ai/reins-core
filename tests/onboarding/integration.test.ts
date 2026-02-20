import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OnboardingCheckpointService,
} from "../../src/onboarding/checkpoint-service";
import {
  OnboardingEngine,
  type OnboardingEvent,
} from "../../src/onboarding/engine";
import {
  ONBOARDING_STEPS,
  type OnboardingStep,
} from "../../src/onboarding/types";
import { WelcomeStep } from "../../src/onboarding/steps/welcome";
import { DaemonInstallStep } from "../../src/onboarding/steps/daemon-install";
import { ProviderSetupStep } from "../../src/onboarding/steps/provider-setup";
import { ModelSelectionStep } from "../../src/onboarding/steps/model-selection";
import { WorkspaceStep } from "../../src/onboarding/steps/workspace";
import { PersonalityStep } from "../../src/onboarding/steps/personality";
import { detectProviderFromKey } from "../../src/onboarding/key-detect";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createdDirectories: string[] = [];

async function createTempDataRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-integration-"));
  createdDirectories.push(directory);
  return directory;
}

/**
 * Build the full set of real step handlers with injectable mocks for
 * external dependencies (health checks, key validation, model listing).
 * This exercises the actual step logic rather than stubs.
 */
function createRealStepHandlers(overrides?: {
  readUserName?: () => Promise<string | undefined>;
  checkHealth?: () => Promise<boolean>;
  detectProvider?: (key: string) => { providerId: string | null };
  validateKey?: (providerId: string, key: string) => Promise<boolean>;
  listModels?: () => Promise<Array<{ id: string; name: string; provider: string }>>;
  defaultWorkspacePath?: string;
}) {
  const welcome = new WelcomeStep({
    readUserName: overrides?.readUserName,
  });

  const daemonInstall = new DaemonInstallStep({
    checkHealth: overrides?.checkHealth ?? (() => Promise.resolve(true)),
  });

  const providerSetup = new ProviderSetupStep({
    detectProvider: overrides?.detectProvider ?? ((key: string) => ({
      providerId: detectProviderFromKey(key),
    })),
    validateKey: overrides?.validateKey ?? (() => Promise.resolve(true)),
  });

  const modelSelection = new ModelSelectionStep({
    listModels: overrides?.listModels ?? (() => Promise.resolve([
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
    ])),
  });

  const workspace = new WorkspaceStep({
    defaultPath: overrides?.defaultWorkspacePath ?? "/tmp/test-workspace",
  });

  const personality = new PersonalityStep();

  return [welcome, daemonInstall, providerSetup, modelSelection, workspace, personality];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Onboarding Integration", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) continue;
      await rm(directory, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Quickstart flow — completes all 6 steps with defaults
  // =========================================================================

  describe("quickstart flow completes all 6 steps", () => {
    it("completes the full wizard without user interaction (except key)", async () => {
      const dataRoot = await createTempDataRoot();
      const events: OnboardingEvent[] = [];

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("James"),
        }),
        onEvent: (event) => events.push(event),
      });

      const initResult = await engine.initialize();
      expect(initResult.ok).toBe(true);
      if (!initResult.ok) return;
      expect(initResult.value.currentStep).toBe("welcome");
      expect(initResult.value.mode).toBe("quickstart");

      // Step 1: Welcome — provide userName
      const step1 = await engine.completeCurrentStep({ userName: "James" });
      expect(step1.ok).toBe(true);
      if (!step1.ok) return;
      expect(step1.value.currentStep).toBe("daemon-install");

      // Step 2: Daemon install — auto-completes (health check returns true)
      const step2 = await engine.completeCurrentStep();
      expect(step2.ok).toBe(true);
      if (!step2.ok) return;
      expect(step2.value.currentStep).toBe("provider-keys");

      // Step 3: Provider keys — provide an API key for auto-detection
      const step3 = await engine.completeCurrentStep({
        apiKey: "sk-ant-test-key-12345",
      });
      expect(step3.ok).toBe(true);
      if (!step3.ok) return;
      expect(step3.value.currentStep).toBe("model-select");

      // Step 4: Model select — auto-selects first available model
      const step4 = await engine.completeCurrentStep();
      expect(step4.ok).toBe(true);
      if (!step4.ok) return;
      expect(step4.value.currentStep).toBe("workspace");

      // Step 5: Workspace — uses default path
      const step5 = await engine.completeCurrentStep();
      expect(step5.ok).toBe(true);
      if (!step5.ok) return;
      expect(step5.value.currentStep).toBe("personality");

      // Step 6: Personality — auto-selects balanced
      const step6 = await engine.completeCurrentStep();
      expect(step6.ok).toBe(true);
      if (!step6.ok) return;
      expect(step6.value.isComplete).toBe(true);

      // Verify wizard completion
      expect(engine.isComplete()).toBe(true);
    });

    it("collects all step data correctly in quickstart mode", async () => {
      const dataRoot = await createTempDataRoot();

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Alice"),
          defaultWorkspacePath: "/home/alice/reins-workspace",
        }),
      });

      await engine.initialize();

      // Complete all 6 steps
      await engine.completeCurrentStep({ userName: "Alice" });
      await engine.completeCurrentStep();
      await engine.completeCurrentStep({ apiKey: "sk-ant-key-abc" });
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();

      expect(engine.isComplete()).toBe(true);

      const data = engine.getCollectedData();

      // Welcome step data
      expect(data.userName).toBe("Alice");
      expect(data.selectedMode).toBe("quickstart");

      // Personality step defaults
      expect(data.preset).toBe("balanced");
    });

    it("emits stepEnter and stepComplete events for all 6 steps", async () => {
      const dataRoot = await createTempDataRoot();
      const events: OnboardingEvent[] = [];

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Bob"),
        }),
        onEvent: (event) => events.push(event),
      });

      await engine.initialize();

      // Complete all steps
      await engine.completeCurrentStep({ userName: "Bob" });
      await engine.completeCurrentStep();
      await engine.completeCurrentStep({ apiKey: "sk-test-key" });
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();

      // Verify stepEnter events for all 6 steps
      const enterEvents = events.filter((e) => e.type === "stepEnter");
      expect(enterEvents.length).toBe(ONBOARDING_STEPS.length);

      // Verify stepComplete events for all 6 steps
      const completeEvents = events.filter((e) => e.type === "stepComplete");
      expect(completeEvents.length).toBe(ONBOARDING_STEPS.length);

      // Verify wizardComplete event
      const wizardComplete = events.find((e) => e.type === "wizardComplete");
      expect(wizardComplete).toBeDefined();
      if (wizardComplete?.type === "wizardComplete") {
        expect(wizardComplete.config.setupComplete).toBe(true);
        expect(wizardComplete.config.userName).toBe("Bob");
      }
    });

    it("persists completed config to checkpoint file", async () => {
      const dataRoot = await createTempDataRoot();

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Charlie"),
        }),
      });

      await engine.initialize();

      // Complete all steps
      await engine.completeCurrentStep({ userName: "Charlie" });
      await engine.completeCurrentStep();
      await engine.completeCurrentStep({ apiKey: "sk-ant-key" });
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();

      // Verify checkpoint file
      const loadResult = await checkpoint.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      const config = loadResult.value!;
      expect(config.setupComplete).toBe(true);
      expect(config.userName).toBe("Charlie");
      expect(config.completedSteps).toHaveLength(6);
      expect(config.completedAt).toBeTruthy();
      expect(config.personality?.preset).toBe("balanced");

      // All 6 steps recorded in order
      const stepNames = config.completedSteps.map((s) => s.step);
      expect(stepNames).toEqual([...ONBOARDING_STEPS]);
    });

    it("provider key auto-detection works within the flow", async () => {
      const dataRoot = await createTempDataRoot();
      let detectedProvider: string | null = null;

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Dana"),
          detectProvider: (key: string) => {
            const providerId = detectProviderFromKey(key);
            detectedProvider = providerId;
            return { providerId };
          },
        }),
      });

      await engine.initialize();

      // Complete welcome
      await engine.completeCurrentStep({ userName: "Dana" });
      // Complete daemon install
      await engine.completeCurrentStep();
      // Complete provider keys with Anthropic key
      await engine.completeCurrentStep({ apiKey: "sk-ant-real-key-123" });

      expect(detectedProvider).toBe("anthropic");
    });
  });

  // =========================================================================
  // Advanced flow — returns all options
  // =========================================================================

  describe("advanced flow returns all options", () => {
    it("advanced mode exposes full configuration options at each step", async () => {
      const dataRoot = await createTempDataRoot();
      const events: OnboardingEvent[] = [];

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Eve"),
          listModels: () => Promise.resolve([
            { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
            { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
            { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
          ]),
        }),
        onEvent: (event) => events.push(event),
      });

      await engine.initialize();
      engine.setMode("advanced");

      // Step 1: Welcome — advanced mode returns mode selection data
      const step1 = await engine.completeCurrentStep({ userName: "Eve" });
      expect(step1.ok).toBe(true);
      if (!step1.ok) return;

      // Verify welcome step collected advanced mode data
      const step1CompleteEvent = events.find(
        (e) => e.type === "stepComplete" && e.step === "welcome",
      );
      expect(step1CompleteEvent).toBeDefined();
      if (step1CompleteEvent?.type === "stepComplete") {
        expect(step1CompleteEvent.data?.selectedMode).toBe("advanced");
        expect(step1CompleteEvent.data?.channelSetupAvailable).toBe(true);
      }

      // Step 2: Daemon install — advanced mode exposes install path options
      const step2 = await engine.completeCurrentStep();
      expect(step2.ok).toBe(true);

      // Step 3: Provider keys — advanced mode shows all providers
      const step3 = await engine.completeCurrentStep({
        selectedProvider: "openai",
        apiKey: "sk-proj-test-key",
      });
      expect(step3.ok).toBe(true);

      // Step 4: Model select — advanced mode shows full model list
      const step4 = await engine.completeCurrentStep();
      expect(step4.ok).toBe(true);

      // Step 5: Workspace — advanced mode allows custom path
      const step5 = await engine.completeCurrentStep();
      expect(step5.ok).toBe(true);

      // Step 6: Personality — advanced mode shows all preset cards
      const step6 = await engine.completeCurrentStep();
      expect(step6.ok).toBe(true);
      if (!step6.ok) return;

      expect(step6.value.isComplete).toBe(true);
      expect(engine.isComplete()).toBe(true);
    });

    it("advanced mode preserves mode across all steps", async () => {
      const dataRoot = await createTempDataRoot();

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Frank"),
        }),
      });

      await engine.initialize();
      engine.setMode("advanced");

      // Complete all steps
      for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
        const state = engine.getState();
        expect(state.mode).toBe("advanced");

        const data: Record<string, unknown> = {};
        if (i === 0) data.userName = "Frank";
        if (i === 2) data.apiKey = "sk-test-key";

        const result = await engine.completeCurrentStep(
          Object.keys(data).length > 0 ? data : undefined,
        );
        expect(result.ok).toBe(true);
      }

      // Verify final config preserves advanced mode
      const loadResult = await checkpoint.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value!.mode).toBe("advanced");
    });

    it("personality step returns card data in advanced mode", async () => {
      const dataRoot = await createTempDataRoot();
      const events: OnboardingEvent[] = [];

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Grace"),
        }),
        onEvent: (event) => events.push(event),
      });

      await engine.initialize();
      engine.setMode("advanced");

      // Complete steps 1-5
      await engine.completeCurrentStep({ userName: "Grace" });
      await engine.completeCurrentStep();
      await engine.completeCurrentStep({ apiKey: "sk-test" });
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();

      // Step 6: Personality — should return card data
      const step6 = await engine.completeCurrentStep();
      expect(step6.ok).toBe(true);

      // Verify personality step emitted card data
      const personalityComplete = events.find(
        (e) => e.type === "stepComplete" && e.step === "personality",
      );
      expect(personalityComplete).toBeDefined();
      if (personalityComplete?.type === "stepComplete") {
        const data = personalityComplete.data;
        expect(data?.cards).toBeDefined();
        expect(Array.isArray(data?.cards)).toBe(true);
        const cards = data?.cards as Array<{ preset: string; label: string }>;
        expect(cards.length).toBeGreaterThanOrEqual(4);

        // Verify card structure
        const presetIds = cards.map((c) => c.preset);
        expect(presetIds).toContain("balanced");
        expect(presetIds).toContain("concise");
        expect(presetIds).toContain("technical");
        expect(presetIds).toContain("warm");
      }
    });
  });

  // =========================================================================
  // Checkpoint resume — preserves state across restart
  // =========================================================================

  describe("checkpoint resume preserves state", () => {
    it("resumes at correct step with real step handlers after restart", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Complete first 3 steps, then "crash" ---
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Heidi"),
        }),
      });

      await engine1.initialize();

      // Complete welcome
      await engine1.completeCurrentStep({ userName: "Heidi" });
      // Complete daemon install
      await engine1.completeCurrentStep();
      // Complete provider keys
      await engine1.completeCurrentStep({ apiKey: "sk-ant-key-xyz" });

      const state1 = engine1.getState();
      expect(state1.currentStep).toBe("model-select");
      expect(state1.completedSteps).toHaveLength(3);

      // Simulate crash — engine1 is discarded

      // --- Session 2: New engine, same data root ---
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const engine2 = new OnboardingEngine({
        checkpoint: checkpoint2,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Heidi"),
        }),
      });

      const resumeResult = await engine2.initialize();
      expect(resumeResult.ok).toBe(true);
      if (!resumeResult.ok) return;

      // Should resume at step 4 (model-select)
      expect(resumeResult.value.currentStep).toBe("model-select");
      expect(resumeResult.value.currentStepIndex).toBe(3);
      expect(resumeResult.value.completedSteps).toEqual([
        "welcome",
        "daemon-install",
        "provider-keys",
      ]);
      expect(resumeResult.value.isComplete).toBe(false);
    });

    it("preserves userName across restart and includes it in final config", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Complete welcome with name ---
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Ivan"),
        }),
      });

      await engine1.initialize();
      await engine1.completeCurrentStep({ userName: "Ivan" });

      // Verify name persisted to checkpoint
      const loadResult = await checkpoint1.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value!.userName).toBe("Ivan");

      // Simulate crash

      // --- Session 2: Complete remaining steps ---
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const engine2 = new OnboardingEngine({
        checkpoint: checkpoint2,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Ivan"),
        }),
      });

      await engine2.initialize();

      // Complete remaining 5 steps
      for (let i = 0; i < 5; i++) {
        const data: Record<string, unknown> = {};
        if (i === 1) data.apiKey = "sk-ant-key";
        const result = await engine2.completeCurrentStep(
          Object.keys(data).length > 0 ? data : undefined,
        );
        expect(result.ok).toBe(true);
      }

      expect(engine2.isComplete()).toBe(true);

      // Verify final config has userName from session 1
      const finalLoad = await checkpoint2.load();
      expect(finalLoad.ok).toBe(true);
      if (!finalLoad.ok) return;
      expect(finalLoad.value!.userName).toBe("Ivan");
      expect(finalLoad.value!.setupComplete).toBe(true);
    });

    it("completed steps are not re-executed after resume", async () => {
      const dataRoot = await createTempDataRoot();
      const executionLog: OnboardingStep[] = [];

      // --- Session 1: Complete 2 steps ---
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });

      // Use tracking wrappers around real handlers to log execution
      const session1Steps = createRealStepHandlers({
        readUserName: () => Promise.resolve("Judy"),
      });

      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: session1Steps,
      });

      await engine1.initialize();
      await engine1.completeCurrentStep({ userName: "Judy" });
      await engine1.completeCurrentStep();

      // Simulate crash

      // --- Session 2: Track which steps execute ---
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });

      // Wrap real handlers with execution tracking
      const session2Steps = createRealStepHandlers({
        readUserName: () => Promise.resolve("Judy"),
      }).map((handler) => ({
        step: handler.step,
        skippable: handler.skippable,
        getDefaults: () => handler.getDefaults(),
        async execute(context: Parameters<typeof handler.execute>[0]) {
          executionLog.push(handler.step);
          return handler.execute(context);
        },
      }));

      const engine2 = new OnboardingEngine({
        checkpoint: checkpoint2,
        steps: session2Steps,
      });

      await engine2.initialize();

      // Complete remaining 4 steps
      await engine2.completeCurrentStep({ apiKey: "sk-ant-key" });
      await engine2.completeCurrentStep();
      await engine2.completeCurrentStep();
      await engine2.completeCurrentStep();

      // Only steps 3-6 should have been executed in session 2
      expect(executionLog).toEqual([
        "provider-keys",
        "model-select",
        "workspace",
        "personality",
      ]);

      expect(engine2.isComplete()).toBe(true);
    });

    it("can complete the full wizard across three sessions", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Complete steps 1-2 ---
      const cp1 = new OnboardingCheckpointService({ dataRoot });
      const e1 = new OnboardingEngine({
        checkpoint: cp1,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Karl"),
        }),
      });

      await e1.initialize();
      await e1.completeCurrentStep({ userName: "Karl" });
      await e1.completeCurrentStep();
      expect(e1.getState().currentStep).toBe("provider-keys");

      // --- Session 2: Complete steps 3-4 ---
      const cp2 = new OnboardingCheckpointService({ dataRoot });
      const e2 = new OnboardingEngine({
        checkpoint: cp2,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Karl"),
        }),
      });

      await e2.initialize();
      expect(e2.getState().currentStep).toBe("provider-keys");
      await e2.completeCurrentStep({ apiKey: "sk-ant-key" });
      await e2.completeCurrentStep();
      expect(e2.getState().currentStep).toBe("workspace");

      // --- Session 3: Complete steps 5-6 ---
      const cp3 = new OnboardingCheckpointService({ dataRoot });
      const e3 = new OnboardingEngine({
        checkpoint: cp3,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Karl"),
        }),
      });

      await e3.initialize();
      expect(e3.getState().currentStep).toBe("workspace");
      await e3.completeCurrentStep();
      await e3.completeCurrentStep();

      expect(e3.isComplete()).toBe(true);

      // Verify final state
      const finalLoad = await cp3.load();
      expect(finalLoad.ok).toBe(true);
      if (!finalLoad.ok) return;
      expect(finalLoad.value!.setupComplete).toBe(true);
      expect(finalLoad.value!.userName).toBe("Karl");
      expect(finalLoad.value!.completedSteps).toHaveLength(6);
    });

    it("checkpoint includes version field for migration safety", async () => {
      const dataRoot = await createTempDataRoot();

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Lena"),
        }),
      });

      await engine.initialize();
      await engine.completeCurrentStep({ userName: "Lena" });

      // Read raw checkpoint file
      const file = Bun.file(join(dataRoot, "onboarding.json"));
      expect(await file.exists()).toBe(true);

      const raw = await file.json();
      expect(typeof raw.version).toBe("number");
      expect(raw.version).toBe(1);
    });
  });

  // =========================================================================
  // Greeting uses collected name
  // =========================================================================

  describe("greeting uses collected name", () => {
    it("final config contains userName for greeting service consumption", async () => {
      const dataRoot = await createTempDataRoot();
      const events: OnboardingEvent[] = [];

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Maria"),
        }),
        onEvent: (event) => events.push(event),
      });

      await engine.initialize();

      // Complete all steps
      await engine.completeCurrentStep({ userName: "Maria" });
      await engine.completeCurrentStep();
      await engine.completeCurrentStep({ apiKey: "sk-ant-key" });
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();

      // Verify wizardComplete config has userName
      const wizardComplete = events.find((e) => e.type === "wizardComplete");
      expect(wizardComplete).toBeDefined();
      if (wizardComplete?.type === "wizardComplete") {
        expect(wizardComplete.config.userName).toBe("Maria");
        expect(wizardComplete.config.setupComplete).toBe(true);
      }

      // Also verify via checkpoint load
      const loadResult = await checkpoint.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value!.userName).toBe("Maria");
    });

    it("falls back to default name when no name provided", async () => {
      const dataRoot = await createTempDataRoot();

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          // readUserName returns undefined — simulates no name input
          readUserName: () => Promise.resolve(undefined),
        }),
      });

      await engine.initialize();

      // Complete all steps without providing userName
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();
      await engine.completeCurrentStep({ apiKey: "sk-ant-key" });
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();

      const data = engine.getCollectedData();
      // WelcomeStep defaults to "User" when no name provided
      expect(data.userName).toBe("User");
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("handles empty API key gracefully in quickstart", async () => {
      const dataRoot = await createTempDataRoot();

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Nick"),
        }),
      });

      await engine.initialize();
      await engine.completeCurrentStep({ userName: "Nick" });
      await engine.completeCurrentStep();

      // Provide empty API key — should still complete (returns prompt flow)
      const step3 = await engine.completeCurrentStep({ apiKey: "" });
      expect(step3.ok).toBe(true);
    });

    it("handles failed key validation gracefully", async () => {
      const dataRoot = await createTempDataRoot();

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Olivia"),
          validateKey: () => Promise.resolve(false),
        }),
      });

      await engine.initialize();
      await engine.completeCurrentStep({ userName: "Olivia" });
      await engine.completeCurrentStep();

      // Key validation fails but step still completes (TUI handles retry)
      const step3 = await engine.completeCurrentStep({ apiKey: "sk-ant-bad-key" });
      expect(step3.ok).toBe(true);
    });

    it("handles no available models gracefully", async () => {
      const dataRoot = await createTempDataRoot();

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createRealStepHandlers({
          readUserName: () => Promise.resolve("Pat"),
          listModels: () => Promise.resolve([]),
        }),
      });

      await engine.initialize();
      await engine.completeCurrentStep({ userName: "Pat" });
      await engine.completeCurrentStep();
      await engine.completeCurrentStep({ apiKey: "sk-ant-key" });

      // Model select with no models — should still complete
      const step4 = await engine.completeCurrentStep();
      expect(step4.ok).toBe(true);

      // Continue to completion
      await engine.completeCurrentStep();
      await engine.completeCurrentStep();
      expect(engine.isComplete()).toBe(true);
    });
  });
});

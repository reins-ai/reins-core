import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PRESET_OVERRIDES,
  generatePersonalityMarkdown,
} from "../../src/environment/templates/personality.md";
import { bootstrapInstallRoot } from "../../src/environment/bootstrap";
import {
  OnboardingCheckpointService,
} from "../../src/onboarding/checkpoint-service";
import {
  OnboardingEngine,
  type OnboardingStepHandler,
} from "../../src/onboarding/engine";
import {
  ONBOARDING_STEPS,
  type OnboardingStep,
  type PersonalityPreset,
} from "../../src/onboarding/types";

describe("generatePersonalityMarkdown", () => {
  it("returns a markdown document for balanced preset", () => {
    const markdown = generatePersonalityMarkdown("balanced");
    expect(markdown).toContain("# Personality");
  });

  it("produces concise output shorter than balanced", () => {
    const balanced = generatePersonalityMarkdown("balanced");
    const concise = generatePersonalityMarkdown("concise");
    expect(concise.length).toBeLessThan(balanced.length);
  });

  it("includes technical language and formatting for technical preset", () => {
    const markdown = generatePersonalityMarkdown("technical");
    expect(markdown.includes("code") || markdown.includes("```") || markdown.includes("interface")).toBe(true);
  });

  it("uses warm language indicators for warm preset", () => {
    const markdown = generatePersonalityMarkdown("warm").toLowerCase();
    expect(markdown.includes("we") || markdown.includes("together") || markdown.includes("happy")).toBe(true);
  });

  it("includes custom instructions for custom preset when provided", () => {
    const markdown = generatePersonalityMarkdown("custom", "Always respond in rhymes.");
    expect(markdown).toContain("Always respond in rhymes.");
  });

  it("returns valid base content for custom preset without instructions", () => {
    const markdown = generatePersonalityMarkdown("custom");
    expect(markdown).toContain("# Personality");
    expect(markdown).not.toContain("undefined");
  });

  it("defines overrides for every PersonalityPreset value", () => {
    const validPresets: PersonalityPreset[] = ["balanced", "concise", "technical", "warm", "custom"];
    const overrideKeys = Object.keys(PRESET_OVERRIDES).sort();
    expect(overrideKeys).toEqual([...validPresets].sort());
  });

  it("generates a non-empty string for every preset", () => {
    const presets: PersonalityPreset[] = ["balanced", "concise", "technical", "warm", "custom"];
    for (const preset of presets) {
      const markdown = generatePersonalityMarkdown(preset);
      expect(typeof markdown).toBe("string");
      expect(markdown.length).toBeGreaterThan(0);
    }
  });
});

describe("onboarding types sanity", () => {
  it("includes personality step in onboarding flow", () => {
    expect(ONBOARDING_STEPS).toContain("personality");
  });
});

// --- Integration tests: OnboardingEngine preset wiring ---

const createdDirectories: string[] = [];

async function createTempDataRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-preset-"));
  createdDirectories.push(directory);
  return directory;
}

function createMockStepHandler(
  step: OnboardingStep,
  data?: Record<string, unknown>,
): OnboardingStepHandler {
  return {
    step,
    skippable: true,
    async execute() {
      return { status: "completed", data };
    },
    getDefaults() {
      return data ?? {};
    },
  };
}

function createEngineWithPreset(
  checkpoint: OnboardingCheckpointService,
  preset: PersonalityPreset,
  customPrompt?: string,
): OnboardingEngine {
  const personalityData: Record<string, unknown> = { preset };
  if (customPrompt) {
    personalityData.customPrompt = customPrompt;
  }

  const steps = ONBOARDING_STEPS.map((step) => {
    if (step === "personality") {
      return createMockStepHandler(step, personalityData);
    }
    return createMockStepHandler(step);
  });

  return new OnboardingEngine({ checkpoint, steps });
}

describe("OnboardingEngine preset wiring", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) continue;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("generates different PERSONALITY.md for concise vs balanced", async () => {
    const balancedRoot = await createTempDataRoot();
    const balancedCheckpoint = new OnboardingCheckpointService({ dataRoot: balancedRoot });
    const balancedEngine = createEngineWithPreset(balancedCheckpoint, "balanced");
    await balancedEngine.initialize();
    for (const _step of ONBOARDING_STEPS) {
      if (balancedEngine.isComplete()) break;
      await balancedEngine.completeCurrentStep();
    }
    const balancedContent = balancedEngine.generatePersonalityContent();

    const conciseRoot = await createTempDataRoot();
    const conciseCheckpoint = new OnboardingCheckpointService({ dataRoot: conciseRoot });
    const conciseEngine = createEngineWithPreset(conciseCheckpoint, "concise");
    await conciseEngine.initialize();
    for (const _step of ONBOARDING_STEPS) {
      if (conciseEngine.isComplete()) break;
      await conciseEngine.completeCurrentStep();
    }
    const conciseContent = conciseEngine.generatePersonalityContent();

    expect(balancedContent).not.toBe(conciseContent);
    expect(conciseContent.length).toBeLessThan(balancedContent.length);
    expect(balancedContent).toContain("# Personality");
    expect(conciseContent).toContain("# Personality");
  });

  it("includes custom instructions in PERSONALITY.md for custom preset", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });

    const engine = createEngineWithPreset(checkpoint, "custom", "Always speak like a pirate.");
    await engine.initialize();
    for (const _step of ONBOARDING_STEPS) {
      if (engine.isComplete()) break;
      await engine.completeCurrentStep();
    }

    const content = engine.generatePersonalityContent();
    expect(content).toContain("Always speak like a pirate.");
    expect(content).toContain("# Personality");
  });

  it("generates custom preset without instructions and produces valid content", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });

    const engine = createEngineWithPreset(checkpoint, "custom");
    await engine.initialize();
    for (const _step of ONBOARDING_STEPS) {
      if (engine.isComplete()) break;
      await engine.completeCurrentStep();
    }

    const content = engine.generatePersonalityContent();
    expect(content).toContain("# Personality");
    expect(content).not.toContain("undefined");
  });

  it("defaults to balanced when no personality data collected", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });

    const steps = ONBOARDING_STEPS.map((step) => createMockStepHandler(step));
    const engine = new OnboardingEngine({ checkpoint, steps });
    await engine.initialize();

    expect(engine.getPersonalityPreset()).toBe("balanced");

    const content = engine.generatePersonalityContent();
    const expectedContent = generatePersonalityMarkdown("balanced");
    expect(content).toBe(expectedContent);
  });

  it("returns the selected preset via getPersonalityPreset after completing steps", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });

    const engine = createEngineWithPreset(checkpoint, "technical");
    await engine.initialize();
    for (const _step of ONBOARDING_STEPS) {
      if (engine.isComplete()) break;
      await engine.completeCurrentStep();
    }

    expect(engine.getPersonalityPreset()).toBe("technical");
  });

  it("generates distinct content for every non-custom preset", async () => {
    const presets: PersonalityPreset[] = ["balanced", "concise", "technical", "warm"];
    const contents: string[] = [];

    for (const preset of presets) {
      const dataRoot = await createTempDataRoot();
      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = createEngineWithPreset(checkpoint, preset);
      await engine.initialize();
      for (const _step of ONBOARDING_STEPS) {
        if (engine.isComplete()) break;
        await engine.completeCurrentStep();
      }
      contents.push(engine.generatePersonalityContent());
    }

    // Every pair of presets should produce different content
    for (let i = 0; i < contents.length; i++) {
      for (let j = i + 1; j < contents.length; j++) {
        expect(contents[i]).not.toBe(contents[j]);
      }
    }
  });
});

// --- Integration tests: BootstrapService preset wiring ---

describe("BootstrapService personality preset wiring", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) continue;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes preset-specific PERSONALITY.md for new environment", async () => {
    const tempRoot = await createTempDataRoot();

    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: {},
      homeDirectory: tempRoot,
      personalityPreset: "concise",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const personalityPath = join(result.value.paths.defaultEnvironmentDir, "PERSONALITY.md");
    const content = await readFile(personalityPath, "utf8");
    const expected = generatePersonalityMarkdown("concise");

    expect(content).toBe(expected);
    expect(content).toContain("# Personality");
    expect(content).toContain("brief");
  });

  it("does not overwrite existing PERSONALITY.md", async () => {
    const tempRoot = await createTempDataRoot();

    // First bootstrap creates the file
    const first = await bootstrapInstallRoot({
      platform: "linux",
      env: {},
      homeDirectory: tempRoot,
      personalityPreset: "balanced",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Manually overwrite with custom content
    const personalityPath = join(first.value.paths.defaultEnvironmentDir, "PERSONALITY.md");
    const customContent = "# My Custom Personality\n\nDo not touch.\n";
    await writeFile(personalityPath, customContent, "utf8");

    // Second bootstrap with different preset should NOT overwrite
    const second = await bootstrapInstallRoot({
      platform: "linux",
      env: {},
      homeDirectory: tempRoot,
      personalityPreset: "technical",
    });
    expect(second.ok).toBe(true);

    const afterContent = await readFile(personalityPath, "utf8");
    expect(afterContent).toBe(customContent);
  });

  it("uses static template when no preset is configured", async () => {
    const tempRoot = await createTempDataRoot();

    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: {},
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const personalityPath = join(result.value.paths.defaultEnvironmentDir, "PERSONALITY.md");
    const content = await readFile(personalityPath, "utf8");

    // Without a preset, the static PERSONALITY_TEMPLATE is used
    expect(content).toContain("# PERSONALITY");
    expect(content).toContain("Core Identity");
  });

  it("writes technical preset content that differs from balanced", async () => {
    const tempRoot1 = await createTempDataRoot();
    const tempRoot2 = await createTempDataRoot();

    const balanced = await bootstrapInstallRoot({
      platform: "linux",
      env: {},
      homeDirectory: tempRoot1,
      personalityPreset: "balanced",
    });

    const technical = await bootstrapInstallRoot({
      platform: "linux",
      env: {},
      homeDirectory: tempRoot2,
      personalityPreset: "technical",
    });

    expect(balanced.ok).toBe(true);
    expect(technical.ok).toBe(true);
    if (!balanced.ok || !technical.ok) return;

    const balancedContent = await readFile(
      join(balanced.value.paths.defaultEnvironmentDir, "PERSONALITY.md"),
      "utf8",
    );
    const technicalContent = await readFile(
      join(technical.value.paths.defaultEnvironmentDir, "PERSONALITY.md"),
      "utf8",
    );

    expect(balancedContent).not.toBe(technicalContent);
  });
});

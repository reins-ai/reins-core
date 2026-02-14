import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SystemPromptBuilder } from "../../src/persona/builder";
import { EnvironmentContextProvider } from "../../src/persona/environment-context";
import { ConfigStore } from "../../src/config/store";
import { FileEnvironmentResolver } from "../../src/environment/file-resolver";
import { EnvironmentSwitchService } from "../../src/environment/switch-service";
import { ENVIRONMENT_DOCUMENTS, type EnvironmentDocument, type EnvironmentDocumentMap } from "../../src/environment/types";
import type { Persona } from "../../src/persona/persona";

const createdDirectories: string[] = [];

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

async function setupEnvironment(
  environmentsRoot: string,
  environmentName: string,
  documents: Partial<Record<EnvironmentDocument, string>>,
): Promise<void> {
  const environmentDirectory = join(environmentsRoot, environmentName);
  await mkdir(environmentDirectory, { recursive: true });

  for (const documentType of ENVIRONMENT_DOCUMENTS) {
    const content = documents[documentType];
    if (typeof content === "undefined") {
      continue;
    }

    await writeFile(
      join(environmentDirectory, `${documentType}.md`),
      content,
      "utf8",
    );
  }
}

function buildFullDocumentSet(prefix: string): Record<EnvironmentDocument, string> {
  const set = {} as Record<EnvironmentDocument, string>;

  for (const documentType of ENVIRONMENT_DOCUMENTS) {
    set[documentType] = `${prefix} ${documentType} content`;
  }

  return set;
}

function createTestPersona(): Persona {
  return {
    id: "test-persona",
    name: "Test Persona",
    description: "Test description",
    systemPrompt: "You are a helpful test assistant.",
    toolPermissions: { mode: "all" },
  };
}

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (!directory) {
      continue;
    }

    await rm(directory, { recursive: true, force: true });
  }
});

describe("Environment switch prompt integration", () => {
  describe("prompt changes after environment switch", () => {
    it("default environment produces prompt with default documents", async () => {
      const root = await createTempDirectory("reins-switch-prompt-default-");
      const environmentsRoot = join(root, "environments");
      const configPath = join(root, "config", "reins.config.json5");

      await setupEnvironment(environmentsRoot, "default", {
        ...buildFullDocumentSet("Default"),
        PERSONALITY: "You are a friendly default assistant.",
        USER: "Name: Alex\nPreferences: casual tone",
        BOUNDARIES: "No financial advice.",
      });
      await setupEnvironment(environmentsRoot, "work", {
        ...buildFullDocumentSet("Work"),
        PERSONALITY: "You are a focused work assistant. Be concise.",
        USER: "Name: Alex\nRole: Software Engineer\nPreferences: technical, no small talk",
        BOUNDARIES: "No personal advice. Stay professional.",
      });

      const configStore = new ConfigStore(configPath);
      const resolver = new FileEnvironmentResolver(environmentsRoot);
      const switchService = new EnvironmentSwitchService(configStore, resolver);
      const builder = new SystemPromptBuilder();
      const provider = new EnvironmentContextProvider(switchService, builder, switchService);
      const persona = createTestPersona();

      const defaultResult = await provider.buildEnvironmentPrompt(persona);

      expect(defaultResult.ok).toBe(true);
      if (!defaultResult.ok) return;

      expect(defaultResult.value).toContain("You are a friendly default assistant.");
      expect(defaultResult.value).toContain("Preferences: casual tone");
      expect(defaultResult.value).toContain("No financial advice.");
    });

    it("switched environment produces prompt with new environment documents", async () => {
      const root = await createTempDirectory("reins-switch-prompt-work-");
      const environmentsRoot = join(root, "environments");
      const configPath = join(root, "config", "reins.config.json5");

      await setupEnvironment(environmentsRoot, "default", {
        ...buildFullDocumentSet("Default"),
        PERSONALITY: "You are a friendly default assistant.",
        USER: "Name: Alex\nPreferences: casual tone",
      });
      await setupEnvironment(environmentsRoot, "work", {
        ...buildFullDocumentSet("Work"),
        PERSONALITY: "You are a focused work assistant. Be concise.",
        USER: "Name: Alex\nRole: Software Engineer",
      });

      const configStore = new ConfigStore(configPath);
      const resolver = new FileEnvironmentResolver(environmentsRoot);
      const switchService = new EnvironmentSwitchService(configStore, resolver);
      const builder = new SystemPromptBuilder();
      const provider = new EnvironmentContextProvider(switchService, builder, switchService);
      const persona = createTestPersona();

      const switchResult = await switchService.switchEnvironment("work");
      expect(switchResult.ok).toBe(true);

      const workResult = await provider.buildEnvironmentPrompt(persona);

      expect(workResult.ok).toBe(true);
      if (!workResult.ok) return;

      expect(workResult.value).toContain("You are a focused work assistant. Be concise.");
      expect(workResult.value).toContain("Role: Software Engineer");
      expect(workResult.value).not.toContain("You are a friendly default assistant.");
      expect(workResult.value).not.toContain("Preferences: casual tone");
    });

    it("subsequent prompt assembly uses new environment docs after switch", async () => {
      const root = await createTempDirectory("reins-switch-prompt-subsequent-");
      const environmentsRoot = join(root, "environments");
      const configPath = join(root, "config", "reins.config.json5");

      await setupEnvironment(environmentsRoot, "default", {
        ...buildFullDocumentSet("Default"),
        PERSONALITY: "Default personality.",
        BOUNDARIES: "Default boundaries.",
      });
      await setupEnvironment(environmentsRoot, "work", {
        ...buildFullDocumentSet("Work"),
        PERSONALITY: "Work personality.",
        BOUNDARIES: "Work boundaries.",
      });

      const configStore = new ConfigStore(configPath);
      const resolver = new FileEnvironmentResolver(environmentsRoot);
      const switchService = new EnvironmentSwitchService(configStore, resolver);
      const builder = new SystemPromptBuilder();
      const provider = new EnvironmentContextProvider(switchService, builder, switchService);
      const persona = createTestPersona();

      const beforeSwitch = await provider.buildEnvironmentPrompt(persona);
      expect(beforeSwitch.ok).toBe(true);
      if (!beforeSwitch.ok) return;
      expect(beforeSwitch.value).toContain("Default personality.");

      const switchResult = await switchService.switchEnvironment("work");
      expect(switchResult.ok).toBe(true);

      const afterSwitch = await provider.buildEnvironmentPrompt(persona);
      expect(afterSwitch.ok).toBe(true);
      if (!afterSwitch.ok) return;

      expect(afterSwitch.value).toContain("Work personality.");
      expect(afterSwitch.value).toContain("Work boundaries.");
      expect(afterSwitch.value).not.toContain("Default personality.");
      expect(afterSwitch.value).not.toContain("Default boundaries.");
    });
  });

  describe("switch notification", () => {
    it("fires notification callback when environment switches", async () => {
      const root = await createTempDirectory("reins-switch-prompt-notify-");
      const environmentsRoot = join(root, "environments");
      const configPath = join(root, "config", "reins.config.json5");

      await setupEnvironment(environmentsRoot, "default", buildFullDocumentSet("Default"));
      await setupEnvironment(environmentsRoot, "work", buildFullDocumentSet("Work"));

      const configStore = new ConfigStore(configPath);
      const resolver = new FileEnvironmentResolver(environmentsRoot);
      const switchService = new EnvironmentSwitchService(configStore, resolver);
      const builder = new SystemPromptBuilder();
      const provider = new EnvironmentContextProvider(switchService, builder, switchService);

      let notificationCount = 0;
      provider.onEnvironmentSwitch(() => {
        notificationCount += 1;
      });

      expect(notificationCount).toBe(0);

      const switchResult = await switchService.switchEnvironment("work");
      expect(switchResult.ok).toBe(true);

      expect(notificationCount).toBe(1);
    });

    it("does not fire notification after listener is unsubscribed", async () => {
      const root = await createTempDirectory("reins-switch-prompt-unsub-");
      const environmentsRoot = join(root, "environments");
      const configPath = join(root, "config", "reins.config.json5");

      await setupEnvironment(environmentsRoot, "default", buildFullDocumentSet("Default"));
      await setupEnvironment(environmentsRoot, "work", buildFullDocumentSet("Work"));
      await setupEnvironment(environmentsRoot, "travel", buildFullDocumentSet("Travel"));

      const configStore = new ConfigStore(configPath);
      const resolver = new FileEnvironmentResolver(environmentsRoot);
      const switchService = new EnvironmentSwitchService(configStore, resolver);
      const builder = new SystemPromptBuilder();
      const provider = new EnvironmentContextProvider(switchService, builder, switchService);

      let notificationCount = 0;
      const unsubscribe = provider.onEnvironmentSwitch(() => {
        notificationCount += 1;
      });

      const firstSwitch = await switchService.switchEnvironment("work");
      expect(firstSwitch.ok).toBe(true);
      expect(notificationCount).toBe(1);

      unsubscribe();

      const secondSwitch = await switchService.switchEnvironment("travel");
      expect(secondSwitch.ok).toBe(true);
      expect(notificationCount).toBe(1);
    });
  });

  describe("same builder with different environments", () => {
    it("produces different prompts for different environments", async () => {
      const root = await createTempDirectory("reins-switch-prompt-builder-");
      const environmentsRoot = join(root, "environments");

      await setupEnvironment(environmentsRoot, "default", {
        ...buildFullDocumentSet("Default"),
        PERSONALITY: "Casual and friendly assistant.",
        USER: "Hobbies: reading, hiking",
        BOUNDARIES: "No coding help.",
      });
      await setupEnvironment(environmentsRoot, "work", {
        ...buildFullDocumentSet("Work"),
        PERSONALITY: "Professional and efficient assistant.",
        USER: "Role: Product Manager\nCompany: Acme Corp",
        BOUNDARIES: "No personal topics during work hours.",
      });

      const resolver = new FileEnvironmentResolver(environmentsRoot);
      const builder = new SystemPromptBuilder();
      const persona = createTestPersona();

      const defaultResolution = await resolver.resolveAll("default");
      expect(defaultResolution.ok).toBe(true);
      if (!defaultResolution.ok) return;

      const workResolution = await resolver.resolveAll("work");
      expect(workResolution.ok).toBe(true);
      if (!workResolution.ok) return;

      const toDocMap = (resolution: typeof defaultResolution.value): EnvironmentDocumentMap => {
        const map: EnvironmentDocumentMap = {};
        for (const [docType, doc] of Object.entries(resolution.documents)) {
          map[docType as EnvironmentDocument] = doc.document.content;
        }
        return map;
      };

      const defaultPrompt = builder.build({
        persona,
        environmentDocuments: toDocMap(defaultResolution.value),
      });
      const workPrompt = builder.build({
        persona,
        environmentDocuments: toDocMap(workResolution.value),
      });

      expect(defaultPrompt).not.toBe(workPrompt);

      expect(defaultPrompt).toContain("Casual and friendly assistant.");
      expect(defaultPrompt).toContain("Hobbies: reading, hiking");
      expect(defaultPrompt).toContain("No coding help.");

      expect(workPrompt).toContain("Professional and efficient assistant.");
      expect(workPrompt).toContain("Role: Product Manager");
      expect(workPrompt).toContain("No personal topics during work hours.");

      expect(defaultPrompt).not.toContain("Professional and efficient assistant.");
      expect(workPrompt).not.toContain("Casual and friendly assistant.");
    });

    it("preserves section ordering across different environments", async () => {
      const root = await createTempDirectory("reins-switch-prompt-order-");
      const environmentsRoot = join(root, "environments");

      await setupEnvironment(environmentsRoot, "default", {
        ...buildFullDocumentSet("Default"),
        PERSONALITY: "Default identity.",
        BOUNDARIES: "Default boundaries.",
        USER: "Default user.",
      });
      await setupEnvironment(environmentsRoot, "work", {
        ...buildFullDocumentSet("Work"),
        PERSONALITY: "Work identity.",
        BOUNDARIES: "Work boundaries.",
        USER: "Work user.",
      });

      const resolver = new FileEnvironmentResolver(environmentsRoot);
      const builder = new SystemPromptBuilder();
      const persona = createTestPersona();

      const assertSectionOrder = (prompt: string) => {
        const identityIndex = prompt.indexOf("## Identity");
        const boundariesIndex = prompt.indexOf("## Boundaries");
        const userIndex = prompt.indexOf("## User Context");

        expect(identityIndex).toBeGreaterThanOrEqual(0);
        expect(boundariesIndex).toBeGreaterThan(identityIndex);
        expect(userIndex).toBeGreaterThan(boundariesIndex);
      };

      const defaultResolution = await resolver.resolveAll("default");
      expect(defaultResolution.ok).toBe(true);
      if (!defaultResolution.ok) return;

      const workResolution = await resolver.resolveAll("work");
      expect(workResolution.ok).toBe(true);
      if (!workResolution.ok) return;

      const toDocMap = (resolution: typeof defaultResolution.value): EnvironmentDocumentMap => {
        const map: EnvironmentDocumentMap = {};
        for (const [docType, doc] of Object.entries(resolution.documents)) {
          map[docType as EnvironmentDocument] = doc.document.content;
        }
        return map;
      };

      const defaultPrompt = builder.build({
        persona,
        environmentDocuments: toDocMap(defaultResolution.value),
      });
      const workPrompt = builder.build({
        persona,
        environmentDocuments: toDocMap(workResolution.value),
      });

      assertSectionOrder(defaultPrompt);
      assertSectionOrder(workPrompt);
    });
  });

  describe("overlay fallback in prompt assembly", () => {
    it("uses default BOUNDARIES when work environment only overrides PERSONALITY", async () => {
      const root = await createTempDirectory("reins-switch-prompt-fallback-");
      const environmentsRoot = join(root, "environments");
      const configPath = join(root, "config", "reins.config.json5");

      await setupEnvironment(environmentsRoot, "default", {
        ...buildFullDocumentSet("Default"),
        PERSONALITY: "Default personality.",
        BOUNDARIES: "Default boundaries: no medical advice.",
        USER: "Default user info.",
      });
      await setupEnvironment(environmentsRoot, "work", {
        PERSONALITY: "Work personality: focused and direct.",
      });

      const configStore = new ConfigStore(configPath);
      const resolver = new FileEnvironmentResolver(environmentsRoot);
      const switchService = new EnvironmentSwitchService(configStore, resolver);
      const builder = new SystemPromptBuilder();
      const provider = new EnvironmentContextProvider(switchService, builder, switchService);
      const persona = createTestPersona();

      const switchResult = await switchService.switchEnvironment("work");
      expect(switchResult.ok).toBe(true);

      const result = await provider.buildEnvironmentPrompt(persona);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toContain("Work personality: focused and direct.");
      expect(result.value).toContain("Default boundaries: no medical advice.");
      expect(result.value).toContain("Default user info.");
      expect(result.value).not.toContain("Default personality.");
    });
  });
});

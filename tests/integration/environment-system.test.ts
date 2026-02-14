import { afterEach, describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigStore } from "../../src/config/store";
import { bootstrapInstallRoot } from "../../src/environment/bootstrap";
import { FileEnvironmentResolver } from "../../src/environment/file-resolver";
import { EnvironmentSwitchService } from "../../src/environment/switch-service";
import { ENVIRONMENT_DOCUMENTS, type EnvironmentDocument } from "../../src/environment/types";
import { SystemPromptBuilder } from "../../src/persona/builder";
import { EnvironmentContextProvider } from "../../src/persona/environment-context";
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

function buildDocumentSet(prefix: string): Record<EnvironmentDocument, string> {
  const documents = {} as Record<EnvironmentDocument, string>;
  for (const documentType of ENVIRONMENT_DOCUMENTS) {
    documents[documentType] = `${prefix} ${documentType}`;
  }
  return documents;
}

function createTestPersona(): Persona {
  return {
    id: "integration-persona",
    name: "Integration Persona",
    description: "Persona used for environment integration tests",
    systemPrompt: "Fallback prompt",
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

describe("integration/environment-system", () => {
  it("bootstraps first-run install root with default environment and config", async () => {
    const homeRoot = await createTempDirectory("reins-env-bootstrap-");

    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: homeRoot },
      homeDirectory: homeRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    await access(result.value.paths.installRoot);
    await access(result.value.paths.environmentsDir);
    await access(result.value.paths.defaultEnvironmentDir);
    await access(result.value.paths.globalConfigPath);

    const store = new ConfigStore(result.value.paths.globalConfigPath);
    const configResult = await store.read();
    expect(configResult.ok).toBe(true);
    if (!configResult.ok) {
      return;
    }

    expect(configResult.value.activeEnvironment).toBe("default");
    expect(configResult.value.heartbeatIntervalMinutes).toBe(30);
  });

  it("resolves overlays with active-file-else-default behavior", async () => {
    const root = await createTempDirectory("reins-env-overlay-");
    const environmentsRoot = join(root, "environments");

    await setupEnvironment(environmentsRoot, "default", buildDocumentSet("Default"));
    await setupEnvironment(environmentsRoot, "work", {
      PERSONALITY: "Work PERSONALITY",
      USER: "Work USER",
    });

    const resolver = new FileEnvironmentResolver(environmentsRoot);
    const result = await resolver.resolveAll("work");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.documents.PERSONALITY.source).toBe("active");
    expect(result.value.documents.PERSONALITY.document.content).toBe("Work PERSONALITY");
    expect(result.value.documents.USER.source).toBe("active");
    expect(result.value.documents.USER.document.content).toBe("Work USER");

    expect(result.value.documents.GOALS.source).toBe("default");
    expect(result.value.documents.GOALS.document.content).toBe("Default GOALS");
    expect(result.value.documents.HEARTBEAT.source).toBe("default");
  });

  it("switches environment and applies prompt delta on subsequent prompt builds", async () => {
    const root = await createTempDirectory("reins-env-prompt-switch-");
    const environmentsRoot = join(root, "environments");
    const configPath = join(root, "config", "reins.config.json5");

    await setupEnvironment(environmentsRoot, "default", {
      ...buildDocumentSet("Default"),
      PERSONALITY: "Default personality for general assistant behavior.",
    });
    await setupEnvironment(environmentsRoot, "work", {
      PERSONALITY: "Work personality focused on concise execution.",
    });

    const store = new ConfigStore(configPath);
    const resolver = new FileEnvironmentResolver(environmentsRoot);
    const switchService = new EnvironmentSwitchService(store, resolver);
    const provider = new EnvironmentContextProvider(switchService, new SystemPromptBuilder());
    const persona = createTestPersona();

    const defaultPromptResult = await provider.buildEnvironmentPrompt(persona);
    expect(defaultPromptResult.ok).toBe(true);
    if (!defaultPromptResult.ok) {
      return;
    }

    const switchResult = await switchService.switchEnvironment("work");
    expect(switchResult.ok).toBe(true);
    if (!switchResult.ok) {
      return;
    }

    const workPromptResult = await provider.buildEnvironmentPrompt(persona);
    expect(workPromptResult.ok).toBe(true);
    if (!workPromptResult.ok) {
      return;
    }

    expect(defaultPromptResult.value).toContain("Default personality for general assistant behavior.");
    expect(workPromptResult.value).toContain("Work personality focused on concise execution.");
    expect(workPromptResult.value).not.toBe(defaultPromptResult.value);
  });

  it("preserves global config across environment switches while docs remain per-environment", async () => {
    const root = await createTempDirectory("reins-env-scope-");
    const environmentsRoot = join(root, "environments");
    const configPath = join(root, "config", "reins.config.json5");

    await setupEnvironment(environmentsRoot, "default", {
      ...buildDocumentSet("Default"),
      USER: "Default user profile",
    });
    await setupEnvironment(environmentsRoot, "work", {
      USER: "Work user profile",
    });

    const store = new ConfigStore(configPath);
    const resolver = new FileEnvironmentResolver(environmentsRoot);
    const switchService = new EnvironmentSwitchService(store, resolver);

    const initialConfigResult = await store.read();
    expect(initialConfigResult.ok).toBe(true);
    if (!initialConfigResult.ok) {
      return;
    }

    const globalConfig = {
      ...initialConfigResult.value,
      globalCredentials: {
        ...initialConfigResult.value.globalCredentials,
        providerKeys: {
          ...initialConfigResult.value.globalCredentials.providerKeys,
          openai: "sk-test-global",
        },
      },
      heartbeatIntervalMinutes: 45,
    };

    const writeResult = await store.write(globalConfig);
    expect(writeResult.ok).toBe(true);
    if (!writeResult.ok) {
      return;
    }

    const beforeSwitchDocsResult = await switchService.getResolvedDocuments("default");
    expect(beforeSwitchDocsResult.ok).toBe(true);
    if (!beforeSwitchDocsResult.ok) {
      return;
    }

    const switchResult = await switchService.switchEnvironment("work");
    expect(switchResult.ok).toBe(true);
    if (!switchResult.ok) {
      return;
    }

    const afterSwitchConfigResult = await store.read();
    expect(afterSwitchConfigResult.ok).toBe(true);
    if (!afterSwitchConfigResult.ok) {
      return;
    }

    expect(afterSwitchConfigResult.value.globalCredentials.providerKeys.openai).toBe("sk-test-global");
    expect(afterSwitchConfigResult.value.heartbeatIntervalMinutes).toBe(45);

    const afterSwitchDocsResult = await switchService.getResolvedDocuments();
    expect(afterSwitchDocsResult.ok).toBe(true);
    if (!afterSwitchDocsResult.ok) {
      return;
    }

    expect(beforeSwitchDocsResult.value.documents.USER.document.content).toBe("Default user profile");
    expect(afterSwitchDocsResult.value.documents.USER.document.content).toBe("Work user profile");
  });

  it("persists active environment across service restart", async () => {
    const root = await createTempDirectory("reins-env-persist-");
    const environmentsRoot = join(root, "environments");
    const configPath = join(root, "config", "reins.config.json5");

    await setupEnvironment(environmentsRoot, "default", buildDocumentSet("Default"));
    await setupEnvironment(environmentsRoot, "work", buildDocumentSet("Work"));

    const firstStore = new ConfigStore(configPath);
    const firstResolver = new FileEnvironmentResolver(environmentsRoot);
    const firstService = new EnvironmentSwitchService(firstStore, firstResolver);

    const firstSwitch = await firstService.switchEnvironment("work");
    expect(firstSwitch.ok).toBe(true);

    const restartedStore = new ConfigStore(configPath);
    const restartedService = new EnvironmentSwitchService(
      restartedStore,
      new FileEnvironmentResolver(environmentsRoot),
    );

    const activeEnvironment = await restartedService.getCurrentEnvironment();
    expect(activeEnvironment.ok).toBe(true);
    if (!activeEnvironment.ok) {
      return;
    }

    expect(activeEnvironment.value).toBe("work");
  });

  it("returns ENVIRONMENT_NOT_FOUND when switching to a missing environment", async () => {
    const root = await createTempDirectory("reins-env-missing-");
    const environmentsRoot = join(root, "environments");
    const configPath = join(root, "config", "reins.config.json5");

    await setupEnvironment(environmentsRoot, "default", buildDocumentSet("Default"));

    const service = new EnvironmentSwitchService(
      new ConfigStore(configPath),
      new FileEnvironmentResolver(environmentsRoot),
    );

    const result = await service.switchEnvironment("does-not-exist");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe("ENVIRONMENT_NOT_FOUND");
  });
});

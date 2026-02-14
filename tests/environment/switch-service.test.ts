import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigStore } from "../../src/config/store";
import { FileEnvironmentResolver } from "../../src/environment/file-resolver";
import { EnvironmentSwitchService } from "../../src/environment/switch-service";
import { ENVIRONMENT_DOCUMENTS, type EnvironmentDocument } from "../../src/environment/types";

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
  const set = {} as Record<EnvironmentDocument, string>;

  for (const documentType of ENVIRONMENT_DOCUMENTS) {
    set[documentType] = `${prefix} ${documentType}`;
  }

  return set;
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

describe("EnvironmentSwitchService", () => {
  it("switches to a valid environment and persists active state", async () => {
    const root = await createTempDirectory("reins-switch-valid-");
    const environmentsRoot = join(root, "environments");
    const configPath = join(root, "config", "reins.config.json5");

    await setupEnvironment(environmentsRoot, "default", buildDocumentSet("Default"));
    await setupEnvironment(environmentsRoot, "work", buildDocumentSet("Work"));

    const service = new EnvironmentSwitchService(
      new ConfigStore(configPath),
      new FileEnvironmentResolver(environmentsRoot),
    );

    const result = await service.switchEnvironment("work");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.previousEnvironment).toBe("default");
    expect(result.value.activeEnvironment).toBe("work");
    expect(result.value.resolvedDocuments.activeEnvironment).toBe("work");
    expect(result.value.resolvedDocuments.documents.PERSONALITY.source).toBe("active");

    const currentEnvironment = await service.getCurrentEnvironment();
    expect(currentEnvironment.ok).toBe(true);
    if (!currentEnvironment.ok) {
      return;
    }

    expect(currentEnvironment.value).toBe("work");
  });

  it("returns environment not found for unknown environment names", async () => {
    const root = await createTempDirectory("reins-switch-missing-");
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

  it("returns invalid environment name for malformed names", async () => {
    const root = await createTempDirectory("reins-switch-invalid-");
    const environmentsRoot = join(root, "environments");
    const configPath = join(root, "config", "reins.config.json5");

    await setupEnvironment(environmentsRoot, "default", buildDocumentSet("Default"));

    const service = new EnvironmentSwitchService(
      new ConfigStore(configPath),
      new FileEnvironmentResolver(environmentsRoot),
    );

    const result = await service.switchEnvironment("Bad Name");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe("INVALID_ENVIRONMENT_NAME");
  });

  it("getCurrentEnvironment reads the active environment from config", async () => {
    const root = await createTempDirectory("reins-switch-current-");
    const configPath = join(root, "config", "reins.config.json5");
    const store = new ConfigStore(configPath);

    const setResult = await store.setActiveEnvironment("travel");
    expect(setResult.ok).toBe(true);
    if (!setResult.ok) {
      return;
    }

    const service = new EnvironmentSwitchService(
      store,
      new FileEnvironmentResolver(join(root, "environments")),
    );

    const currentResult = await service.getCurrentEnvironment();

    expect(currentResult.ok).toBe(true);
    if (!currentResult.ok) {
      return;
    }

    expect(currentResult.value).toBe("travel");
  });

  it("fires switch callback when environment changes", async () => {
    const root = await createTempDirectory("reins-switch-callback-");
    const environmentsRoot = join(root, "environments");
    const configPath = join(root, "config", "reins.config.json5");

    await setupEnvironment(environmentsRoot, "default", buildDocumentSet("Default"));
    await setupEnvironment(environmentsRoot, "work", buildDocumentSet("Work"));

    const events: Array<{ previous: string; active: string }> = [];

    const service = new EnvironmentSwitchService(
      new ConfigStore(configPath),
      new FileEnvironmentResolver(environmentsRoot),
      (event) => {
        events.push({ previous: event.previousEnvironment, active: event.activeEnvironment });
      },
    );

    const result = await service.switchEnvironment("work");

    expect(result.ok).toBe(true);
    expect(events).toEqual([{ previous: "default", active: "work" }]);
  });

  it("resolves documents for the switched environment on subsequent reads", async () => {
    const root = await createTempDirectory("reins-switch-resolve-");
    const environmentsRoot = join(root, "environments");
    const configPath = join(root, "config", "reins.config.json5");

    await setupEnvironment(environmentsRoot, "default", {
      ...buildDocumentSet("Default"),
      USER: "Default USER",
      PERSONALITY: "Default PERSONALITY",
    });
    await setupEnvironment(environmentsRoot, "work", {
      USER: "Work USER",
    });

    const service = new EnvironmentSwitchService(
      new ConfigStore(configPath),
      new FileEnvironmentResolver(environmentsRoot),
    );

    const switchResult = await service.switchEnvironment("work");
    expect(switchResult.ok).toBe(true);
    if (!switchResult.ok) {
      return;
    }

    const resolvedResult = await service.getResolvedDocuments();

    expect(resolvedResult.ok).toBe(true);
    if (!resolvedResult.ok) {
      return;
    }

    expect(resolvedResult.value.activeEnvironment).toBe("work");
    expect(resolvedResult.value.documents.USER.source).toBe("active");
    expect(resolvedResult.value.documents.USER.document.content).toBe("Work USER");
    expect(resolvedResult.value.documents.PERSONALITY.source).toBe("default");
    expect(resolvedResult.value.documents.PERSONALITY.document.content).toBe("Default PERSONALITY");
  });
});

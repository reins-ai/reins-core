import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MemoryCapabilitiesResolver,
  readMemoryConfig,
  resolveMemoryCapabilities,
  resolveMemoryConfigPath,
  writeMemoryConfig,
} from "../../src/daemon/memory-capabilities";

describe("memory capability resolution", () => {
  it("keeps CRUD enabled and gates embedding-dependent features when config is missing", () => {
    const configPath = "/tmp/reins/embedding-config.json";
    const capabilities = resolveMemoryCapabilities(null, configPath);

    expect(capabilities.embeddingConfigured).toBe(false);
    expect(capabilities.setupRequired).toBe(true);
    expect(capabilities.features.crud.enabled).toBe(true);
    expect(capabilities.features.semanticSearch.enabled).toBe(false);
    expect(capabilities.features.consolidation.enabled).toBe(false);
    expect(capabilities.configPath).toBe(configPath);
  });

  it("enables semantic search and consolidation when embedding config exists", () => {
    const capabilities = resolveMemoryCapabilities(
      {
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
      "/tmp/reins/embedding-config.json",
    );

    expect(capabilities.embeddingConfigured).toBe(true);
    expect(capabilities.setupRequired).toBe(false);
    expect(capabilities.features.crud.enabled).toBe(true);
    expect(capabilities.features.semanticSearch.enabled).toBe(true);
    expect(capabilities.features.consolidation.enabled).toBe(true);
    expect(capabilities.embedding).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
    });
  });
});

describe("memory config persistence", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) {
        continue;
      }
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function createTempRoot(prefix = "reins-memory-capabilities-"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("returns null when config file does not exist", async () => {
    const root = await createTempRoot();
    const result = await readMemoryConfig({ dataRoot: root });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it("writes and reads embedding config from disk", async () => {
    const root = await createTempRoot();

    const writeResult = await writeMemoryConfig(
      {
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
      { dataRoot: root },
    );

    expect(writeResult.ok).toBe(true);
    if (!writeResult.ok) {
      return;
    }

    expect(typeof writeResult.value.updatedAt).toBe("string");

    const readResult = await readMemoryConfig({ dataRoot: root });
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) {
      return;
    }

    expect(readResult.value).toEqual(writeResult.value);
  });

  it("resolves capabilities via resolver using persisted config", async () => {
    const root = await createTempRoot();
    const resolver = new MemoryCapabilitiesResolver({ dataRoot: root });

    const beforeResult = await resolver.getCapabilities();
    expect(beforeResult.ok).toBe(true);
    if (!beforeResult.ok) {
      return;
    }
    expect(beforeResult.value.setupRequired).toBe(true);

    const saveResult = await resolver.saveConfig({
      embedding: {
        provider: "ollama",
        model: "nomic-embed-text",
      },
    });
    expect(saveResult.ok).toBe(true);

    const afterResult = await resolver.getCapabilities();
    expect(afterResult.ok).toBe(true);
    if (!afterResult.ok) {
      return;
    }

    expect(afterResult.value.setupRequired).toBe(false);
    expect(afterResult.value.embeddingConfigured).toBe(true);
    expect(afterResult.value.configPath).toBe(resolveMemoryConfigPath({ dataRoot: root }));
    expect(afterResult.value.features.semanticSearch.enabled).toBe(true);
  });
});

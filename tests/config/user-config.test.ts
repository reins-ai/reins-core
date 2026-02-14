import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readUserConfig,
  writeUserConfig,
  type UserConfig,
} from "../../src/config/user-config";

const createdDirectories: string[] = [];

async function createTempConfigPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-user-config-"));
  createdDirectories.push(directory);
  return join(directory, "config.json");
}

describe("UserConfig", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) {
        continue;
      }

      await rm(directory, { recursive: true, force: true });
    }
  });

  describe("search provider preference", () => {
    it("defaults search provider to brave when config is empty", async () => {
      const filePath = await createTempConfigPath();

      const writeResult = await writeUserConfig({ name: "test" }, { filePath });
      expect(writeResult.ok).toBe(true);
      if (!writeResult.ok) return;

      const readResult = await readUserConfig({ filePath });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;

      expect(readResult.value).not.toBeNull();
      expect(readResult.value!.provider.search?.provider).toBe("brave");
    });

    it("persists exa as search provider", async () => {
      const filePath = await createTempConfigPath();

      const writeResult = await writeUserConfig(
        { provider: { mode: "byok", search: { provider: "exa" } } },
        { filePath },
      );
      expect(writeResult.ok).toBe(true);
      if (!writeResult.ok) return;

      const readResult = await readUserConfig({ filePath });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;

      expect(readResult.value).not.toBeNull();
      expect(readResult.value!.provider.search?.provider).toBe("exa");
    });

    it("persists brave as search provider", async () => {
      const filePath = await createTempConfigPath();

      const writeResult = await writeUserConfig(
        { provider: { mode: "byok", search: { provider: "brave" } } },
        { filePath },
      );
      expect(writeResult.ok).toBe(true);
      if (!writeResult.ok) return;

      const readResult = await readUserConfig({ filePath });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;

      expect(readResult.value).not.toBeNull();
      expect(readResult.value!.provider.search?.provider).toBe("brave");
    });

    it("normalizes invalid search provider to brave", async () => {
      const filePath = await createTempConfigPath();

      // Write raw JSON with an invalid search provider value
      const rawConfig = {
        name: "test",
        provider: {
          mode: "byok",
          search: { provider: "google" },
        },
        daemon: { host: "localhost", port: 7433 },
        setupComplete: false,
      };
      await writeFile(filePath, JSON.stringify(rawConfig, null, 2), "utf8");

      const readResult = await readUserConfig({ filePath });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;

      expect(readResult.value).not.toBeNull();
      expect(readResult.value!.provider.search?.provider).toBe("brave");
    });

    it("preserves search provider across config updates", async () => {
      const filePath = await createTempConfigPath();

      // Write initial config with exa
      const writeResult = await writeUserConfig(
        { name: "original", provider: { mode: "byok", search: { provider: "exa" } } },
        { filePath },
      );
      expect(writeResult.ok).toBe(true);

      // Update only the name, not the search provider
      const updateResult = await writeUserConfig(
        { name: "updated" },
        { filePath },
      );
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;

      expect(updateResult.value.name).toBe("updated");
      expect(updateResult.value.provider.search?.provider).toBe("exa");

      // Verify persistence by reading back
      const readResult = await readUserConfig({ filePath });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;

      expect(readResult.value).not.toBeNull();
      expect(readResult.value!.provider.search?.provider).toBe("exa");
    });

    it("switches from brave to exa via writeUserConfig", async () => {
      const filePath = await createTempConfigPath();

      // Start with brave (default)
      const initialWrite = await writeUserConfig(
        { name: "test", provider: { mode: "byok", search: { provider: "brave" } } },
        { filePath },
      );
      expect(initialWrite.ok).toBe(true);

      // Switch to exa
      const switchResult = await writeUserConfig(
        { provider: { mode: "byok", search: { provider: "exa" } } },
        { filePath },
      );
      expect(switchResult.ok).toBe(true);
      if (!switchResult.ok) return;

      expect(switchResult.value.provider.search?.provider).toBe("exa");

      // Verify persistence
      const readResult = await readUserConfig({ filePath });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;

      expect(readResult.value).not.toBeNull();
      expect(readResult.value!.provider.search?.provider).toBe("exa");
    });

    it("switches from exa to brave via writeUserConfig", async () => {
      const filePath = await createTempConfigPath();

      // Start with exa
      const initialWrite = await writeUserConfig(
        { name: "test", provider: { mode: "byok", search: { provider: "exa" } } },
        { filePath },
      );
      expect(initialWrite.ok).toBe(true);

      // Switch to brave
      const switchResult = await writeUserConfig(
        { provider: { mode: "byok", search: { provider: "brave" } } },
        { filePath },
      );
      expect(switchResult.ok).toBe(true);
      if (!switchResult.ok) return;

      expect(switchResult.value.provider.search?.provider).toBe("brave");

      // Verify persistence
      const readResult = await readUserConfig({ filePath });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;

      expect(readResult.value).not.toBeNull();
      expect(readResult.value!.provider.search?.provider).toBe("brave");
    });

    it("multiple rapid switches end with the last value", async () => {
      const filePath = await createTempConfigPath();

      // Initial config
      await writeUserConfig({ name: "test" }, { filePath });

      // Rapid switches: brave -> exa -> brave -> exa
      await writeUserConfig(
        { provider: { mode: "byok", search: { provider: "brave" } } },
        { filePath },
      );
      await writeUserConfig(
        { provider: { mode: "byok", search: { provider: "exa" } } },
        { filePath },
      );
      await writeUserConfig(
        { provider: { mode: "byok", search: { provider: "brave" } } },
        { filePath },
      );
      const lastSwitch = await writeUserConfig(
        { provider: { mode: "byok", search: { provider: "exa" } } },
        { filePath },
      );
      expect(lastSwitch.ok).toBe(true);
      if (!lastSwitch.ok) return;

      expect(lastSwitch.value.provider.search?.provider).toBe("exa");

      // Verify final state persisted
      const readResult = await readUserConfig({ filePath });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;

      expect(readResult.value).not.toBeNull();
      expect(readResult.value!.provider.search?.provider).toBe("exa");
    });

    it("handles config file without search field (backward compat)", async () => {
      const filePath = await createTempConfigPath();

      // Write a legacy config file without the search field
      const legacyConfig = {
        name: "legacy-user",
        provider: {
          mode: "gateway",
          activeProvider: "openai",
        },
        daemon: { host: "localhost", port: 7433 },
        setupComplete: true,
      };
      await writeFile(filePath, JSON.stringify(legacyConfig, null, 2), "utf8");

      const readResult = await readUserConfig({ filePath });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;

      expect(readResult.value).not.toBeNull();
      const config = readResult.value!;

      // Search provider should default to brave
      expect(config.provider.search?.provider).toBe("brave");

      // Existing fields should be preserved
      expect(config.name).toBe("legacy-user");
      expect(config.provider.mode).toBe("gateway");
      expect(config.provider.activeProvider).toBe("openai");
      expect(config.setupComplete).toBe(true);
    });
  });
});

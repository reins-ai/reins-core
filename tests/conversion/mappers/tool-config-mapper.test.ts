import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { ToolConfigMapper } from "../../../src/conversion/mappers/tool-config-mapper";
import type { OpenClawToolConfig } from "../../../src/conversion/types";
import { ok, type Result } from "../../../src/result";
import type { KeychainProvider } from "../../../src/security/keychain-provider";
import type { SecurityError } from "../../../src/security/security-error";

interface SetCall {
  service: string;
  account: string;
}

class MockKeychainProvider implements KeychainProvider {
  public readonly entries = new Map<string, string>();
  public readonly setCalls: SetCall[] = [];

  public async get(service: string, account: string): Promise<Result<string | null, SecurityError>> {
    return ok(this.entries.get(`${service}:${account}`) ?? null);
  }

  public async set(service: string, account: string, secret: string): Promise<Result<void, SecurityError>> {
    this.entries.set(`${service}:${account}`, secret);
    this.setCalls.push({ service, account });
    return ok(undefined);
  }

  public async delete(service: string, account: string): Promise<Result<void, SecurityError>> {
    this.entries.delete(`${service}:${account}`);
    return ok(undefined);
  }
}

function opaqueSecret(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("ToolConfigMapper", () => {
  let tmpDir: string;
  let configPath: string;
  let keychain: MockKeychainProvider;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tool-config-mapper-"));
    configPath = join(tmpDir, "config.json");
    keychain = new MockKeychainProvider();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("stores search API key in keychain with correct service and account", async () => {
    const mapper = new ToolConfigMapper(keychain, { userConfigPath: configPath });
    const toolConfig: OpenClawToolConfig = {
      search: {
        provider: "brave",
        apiKey: opaqueSecret(),
      },
    };

    const result = await mapper.map(toolConfig);

    expect(result.converted).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);
    expect(keychain.setCalls).toContainEqual({
      service: "reins-tool-key",
      account: "brave-search",
    });
    expect(keychain.entries.has("reins-tool-key:brave-search")).toBe(true);
  });

  it("updates search provider preference in user config", async () => {
    const mapper = new ToolConfigMapper(keychain, { userConfigPath: configPath });
    const toolConfig: OpenClawToolConfig = {
      search: {
        provider: "brave",
        apiKey: opaqueSecret(),
      },
    };

    await mapper.map(toolConfig);

    const configFile = Bun.file(configPath);
    expect(await configFile.exists()).toBe(true);
    const config = await configFile.json();
    expect(config.provider.search.provider).toBe("brave");
  });

  it("merges with existing config without overwriting other fields", async () => {
    await Bun.write(
      configPath,
      JSON.stringify({
        name: "test-user",
        provider: { mode: "byok", activeProvider: "anthropic" },
        daemon: { host: "127.0.0.1", port: 9090 },
        setupComplete: true,
      }, null, 2),
    );

    const mapper = new ToolConfigMapper(keychain, { userConfigPath: configPath });
    const toolConfig: OpenClawToolConfig = {
      search: {
        provider: "brave",
        apiKey: opaqueSecret(),
      },
    };

    await mapper.map(toolConfig);

    const config = await Bun.file(configPath).json();
    expect(config.name).toBe("test-user");
    expect(config.setupComplete).toBe(true);
    expect(config.provider.mode).toBe("byok");
    expect(config.provider.activeProvider).toBe("anthropic");
    expect(config.provider.search.provider).toBe("brave");
  });

  it("skips when no search config is present", async () => {
    const mapper = new ToolConfigMapper(keychain, { userConfigPath: configPath });
    const toolConfig: OpenClawToolConfig = {};

    const result = await mapper.map(toolConfig);

    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(keychain.setCalls).toHaveLength(0);
  });

  it("skips keychain storage when apiKey is missing", async () => {
    const mapper = new ToolConfigMapper(keychain, { userConfigPath: configPath });
    const toolConfig: OpenClawToolConfig = {
      search: {
        provider: "brave",
      },
    };

    const result = await mapper.map(toolConfig);

    expect(keychain.setCalls).toHaveLength(0);
    // Provider preference should still be converted
    expect(result.converted).toBe(1);
  });

  it("skips keychain storage when apiKey is empty string", async () => {
    const mapper = new ToolConfigMapper(keychain, { userConfigPath: configPath });
    const toolConfig: OpenClawToolConfig = {
      search: {
        provider: "brave",
        apiKey: "   ",
      },
    };

    const result = await mapper.map(toolConfig);

    expect(keychain.setCalls).toHaveLength(0);
  });

  it("skips unsupported search providers for config preference", async () => {
    const mapper = new ToolConfigMapper(keychain, { userConfigPath: configPath });
    const toolConfig: OpenClawToolConfig = {
      search: {
        provider: "serper",
        apiKey: opaqueSecret(),
      },
    };

    const result = await mapper.map(toolConfig);

    // API key should still be stored (serper key is still a secret)
    expect(keychain.setCalls).toContainEqual({
      service: "reins-tool-key",
      account: "serper-search",
    });
    // Provider preference skipped because "serper" is not a valid SearchProviderPreference
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it("defaults provider to brave when apiKey present but provider missing", async () => {
    const mapper = new ToolConfigMapper(keychain, { userConfigPath: configPath });
    const toolConfig: OpenClawToolConfig = {
      search: {
        apiKey: opaqueSecret(),
      },
    };

    const result = await mapper.map(toolConfig);

    expect(keychain.setCalls).toContainEqual({
      service: "reins-tool-key",
      account: "brave-search",
    });
    expect(result.converted).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);
  });

  it("supports dry-run mode without writing to keychain or config", async () => {
    const mapper = new ToolConfigMapper(keychain, { userConfigPath: configPath });
    const toolConfig: OpenClawToolConfig = {
      search: {
        provider: "brave",
        apiKey: opaqueSecret(),
      },
    };

    const result = await mapper.map(toolConfig, { dryRun: true });

    expect(result.converted).toBeGreaterThanOrEqual(1);
    expect(keychain.setCalls).toHaveLength(0);
    expect(await Bun.file(configPath).exists()).toBe(false);
  });

  it("invokes onProgress callback during mapping", async () => {
    const mapper = new ToolConfigMapper(keychain, { userConfigPath: configPath });
    const toolConfig: OpenClawToolConfig = {
      search: {
        provider: "brave",
        apiKey: opaqueSecret(),
      },
    };

    const progressCalls: Array<{ processed: number; total: number }> = [];
    await mapper.map(toolConfig, {
      onProgress: (processed, total) => {
        progressCalls.push({ processed, total });
      },
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    const last = progressCalls[progressCalls.length - 1];
    expect(last.processed).toBe(last.total);
  });

  it("never writes API key values to config file", async () => {
    const mapper = new ToolConfigMapper(keychain, { userConfigPath: configPath });
    const secret = opaqueSecret();
    const toolConfig: OpenClawToolConfig = {
      search: {
        provider: "brave",
        apiKey: secret,
      },
    };

    await mapper.map(toolConfig);

    const configFile = Bun.file(configPath);
    if (await configFile.exists()) {
      const configText = await configFile.text();
      expect(configText).not.toContain(secret);
    }
  });

  it("handles exa as a valid search provider preference", async () => {
    const mapper = new ToolConfigMapper(keychain, { userConfigPath: configPath });
    const toolConfig: OpenClawToolConfig = {
      search: {
        provider: "exa",
        apiKey: opaqueSecret(),
      },
    };

    const result = await mapper.map(toolConfig);

    expect(result.converted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(keychain.setCalls).toContainEqual({
      service: "reins-tool-key",
      account: "exa-search",
    });

    const config = await Bun.file(configPath).json();
    expect(config.provider.search.provider).toBe("exa");
  });
});

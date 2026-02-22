import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { ImportLogWriter } from "../../../src/conversion/import-log";
import { ChannelMapper } from "../../../src/conversion/mappers/channel-mapper";
import { CredentialMapper } from "../../../src/conversion/mappers/credential-mapper";
import {
  GatewayConfigMapper,
  type OpenClawGatewayConfig,
} from "../../../src/conversion/mappers/gateway-config-mapper";
import { ToolConfigMapper } from "../../../src/conversion/mappers/tool-config-mapper";
import type { OpenClawAuthProfile, OpenClawChannelConfig } from "../../../src/conversion/types";
import { ok, type Result } from "../../../src/result";
import type { KeychainProvider } from "../../../src/security/keychain-provider";
import type { SecurityError } from "../../../src/security/security-error";

const KNOWN_SECRETS = {
  anthropicApiKey: "sk-ant-test-SECRET-VALUE-12345",
  openaiApiKey: "sk-test-OPENAI-SECRET-67890",
  telegramBotToken: "9999999:AAA-TELEGRAM-SECRET-ABCDEF",
  discordBotToken: "DISCORD.BOT.TOKEN.SECRET.XYZ123",
  braveSearchKey: "BSK-BRAVE-SECRET-KEY-ABC123",
  gatewayAuthToken: "rmtest-GATEWAY-SECRET-TOKEN-789",
} as const;

class MockKeychainProvider implements KeychainProvider {
  public readonly entries = new Map<string, string>();
  public readonly setCalls: Array<{ service: string; account: string; secret: string }> = [];

  public async get(service: string, account: string): Promise<Result<string | null, SecurityError>> {
    return ok(this.entries.get(`${service}:${account}`) ?? null);
  }

  public async set(service: string, account: string, secret: string): Promise<Result<void, SecurityError>> {
    this.entries.set(`${service}:${account}`, secret);
    this.setCalls.push({ service, account, secret });
    return ok(undefined);
  }

  public async delete(service: string, account: string): Promise<Result<void, SecurityError>> {
    this.entries.delete(`${service}:${account}`);
    return ok(undefined);
  }
}

function expectNoKnownSecretsInSerializedResult(result: unknown): void {
  const serialized = JSON.stringify(result);
  for (const [name, value] of Object.entries(KNOWN_SECRETS)) {
    expect(serialized, `${name} should not appear in MapResult`).not.toContain(value);
  }
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Secrets Safety", () => {
  describe("CredentialMapper", () => {
    it("does not expose api_key values in map result", async () => {
      const keychain = new MockKeychainProvider();
      const mapper = new CredentialMapper(keychain);

      const profiles: OpenClawAuthProfile[] = [
        { provider: "anthropic", mode: "api_key", key: KNOWN_SECRETS.anthropicApiKey },
        { provider: "openai", mode: "api_key", key: KNOWN_SECRETS.openaiApiKey },
      ];

      const result = await mapper.map(profiles);

      expect(result.converted).toBe(2);
      expect(result.errors).toHaveLength(0);
      expectNoKnownSecretsInSerializedResult(result);
    });

    it("stores api_key values in keychain only", async () => {
      const keychain = new MockKeychainProvider();
      const mapper = new CredentialMapper(keychain);

      await mapper.map([
        { provider: "anthropic", mode: "api_key", key: KNOWN_SECRETS.anthropicApiKey },
        { provider: "openai", mode: "api_key", key: KNOWN_SECRETS.openaiApiKey },
      ]);

      expect(keychain.setCalls).toContainEqual({
        service: "reins-byok",
        account: "anthropic",
        secret: KNOWN_SECRETS.anthropicApiKey,
      });
      expect(keychain.setCalls).toContainEqual({
        service: "reins-byok",
        account: "openai",
        secret: KNOWN_SECRETS.openaiApiKey,
      });
    });
  });

  describe("ChannelMapper", () => {
    it("does not expose bot tokens in map result or channels config", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "reins-secrets-channel-"));
      tempDirs.push(tempDir);
      const outputPath = join(tempDir, "channels.json");

      const keychain = new MockKeychainProvider();
      const mapper = new ChannelMapper(keychain, outputPath);

      const channelConfigs: OpenClawChannelConfig[] = [
        {
          type: "telegram",
          name: "alerts-telegram",
          botToken: KNOWN_SECRETS.telegramBotToken,
          chatId: "-100111",
        },
        {
          type: "discord",
          name: "alerts-discord",
          botToken: KNOWN_SECRETS.discordBotToken,
          guildId: "guild-123",
          channelIds: ["ops"],
        },
      ];

      const result = await mapper.map(channelConfigs);
      expect(result.converted).toBe(2);
      expectNoKnownSecretsInSerializedResult(result);

      const channelsConfigText = await readFile(outputPath, "utf8");
      expect(channelsConfigText).not.toContain(KNOWN_SECRETS.telegramBotToken);
      expect(channelsConfigText).not.toContain(KNOWN_SECRETS.discordBotToken);

      expect(keychain.setCalls).toContainEqual({
        service: "reins-channel-token",
        account: "telegram-alerts-telegram",
        secret: KNOWN_SECRETS.telegramBotToken,
      });
      expect(keychain.setCalls).toContainEqual({
        service: "reins-channel-token",
        account: "discord-alerts-discord",
        secret: KNOWN_SECRETS.discordBotToken,
      });
    });
  });

  describe("ToolConfigMapper", () => {
    it("does not expose search API keys in map result", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "reins-secrets-tools-"));
      tempDirs.push(tempDir);

      const keychain = new MockKeychainProvider();
      const mapper = new ToolConfigMapper(keychain, {
        userConfigPath: join(tempDir, "config.json"),
      });

      const result = await mapper.map({
        search: {
          provider: "brave",
          apiKey: KNOWN_SECRETS.braveSearchKey,
        },
      });

      expect(result.converted).toBe(2);
      expectNoKnownSecretsInSerializedResult(result);

      expect(keychain.setCalls).toContainEqual({
        service: "reins-tool-key",
        account: "brave-search",
        secret: KNOWN_SECRETS.braveSearchKey,
      });
    });
  });

  describe("ImportLogWriter", () => {
    it("redacts secret values in import log output", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "reins-secrets-gateway-"));
      tempDirs.push(tempDir);

      const importLogPath = join(tempDir, "IMPORT_LOG.md");
      const keychain = new MockKeychainProvider();
      const logWriter = new ImportLogWriter({ outputPath: importLogPath });
      const mapper = new GatewayConfigMapper(logWriter, keychain);

      const gatewayConfig: OpenClawGatewayConfig = {
        authToken: KNOWN_SECRETS.gatewayAuthToken,
        port: 7443,
        authMode: "token",
      };

      const result = await mapper.map(gatewayConfig);
      expect(result.converted).toBe(1);
      expectNoKnownSecretsInSerializedResult(result);

      const writeResult = await logWriter.write();
      expect(writeResult.ok).toBe(true);

      const importLog = await readFile(importLogPath, "utf8");
      expect(importLog).not.toContain(KNOWN_SECRETS.gatewayAuthToken);
      expect(importLog).toContain("[REDACTED]");

      expect(keychain.setCalls).toContainEqual({
        service: "reins-gateway-token",
        account: "openclaw-import",
        secret: KNOWN_SECRETS.gatewayAuthToken,
      });
    });
  });
});

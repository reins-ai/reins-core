import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpenClawChannelConfig } from "../../../src/conversion/types";
import { ChannelMapper } from "../../../src/conversion/mappers/channel-mapper";
import type { KeychainProvider } from "../../../src/security/keychain-provider";
import { ok } from "../../../src/result";

class MockKeychainProvider implements KeychainProvider {
  public readonly keys = new Set<string>();

  public async get(): ReturnType<KeychainProvider["get"]> {
    return ok(null);
  }

  public async set(service: string, account: string, _secret: string): ReturnType<KeychainProvider["set"]> {
    this.keys.add(`${service}:${account}`);
    return ok(undefined);
  }

  public async delete(): ReturnType<KeychainProvider["delete"]> {
    return ok(undefined);
  }
}

function makeTelegramConfig(overrides: Record<string, unknown> = {}): OpenClawChannelConfig {
  return {
    type: "telegram",
    name: "testbot",
    botToken: "telegram-secret-token",
    chatId: "-100123",
    settings: {
      messageLimit: 30,
      parseMode: "MarkdownV2",
    },
    ...overrides,
  } as OpenClawChannelConfig;
}

function makeDiscordConfig(overrides: Record<string, unknown> = {}): OpenClawChannelConfig {
  return {
    type: "discord",
    name: "ops-bot",
    botToken: "discord-secret-token",
    guildId: "guild-1",
    channelIds: ["general", "alerts"],
    settings: {
      prefix: "!",
    },
    ...overrides,
  } as OpenClawChannelConfig;
}

let tempDir: string;
let outputPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "reins-channel-mapper-"));
  outputPath = join(tempDir, "channels.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("ChannelMapper", () => {
  it("maps telegram and discord channels with keychain references only", async () => {
    const keychain = new MockKeychainProvider();
    const mapper = new ChannelMapper(keychain, outputPath);

    const result = await mapper.map([
      makeTelegramConfig(),
      makeDiscordConfig(),
    ]);

    expect(result.converted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    expect(keychain.keys.has("reins-channel-token:telegram-testbot")).toBe(true);
    expect(keychain.keys.has("reins-channel-token:discord-ops-bot")).toBe(true);

    const channels = await Bun.file(outputPath).json() as Array<Record<string, unknown>>;
    expect(channels).toHaveLength(2);

    const telegram = channels.find((entry) => entry.name === "testbot");
    expect(telegram).toBeDefined();
    expect(telegram?.type).toBe("telegram");
    expect(telegram?.keychainService).toBe("reins-channel-token");
    expect(telegram?.keychainAccount).toBe("telegram-testbot");
    expect(telegram?.enabled).toBe(false);
    expect(telegram?.source).toBe("openclaw-import");
    expect("botToken" in (telegram ?? {})).toBe(false);

    const discord = channels.find((entry) => entry.name === "ops-bot");
    expect(discord).toBeDefined();
    expect(discord?.type).toBe("discord");
    expect(discord?.keychainAccount).toBe("discord-ops-bot");
    expect(discord?.enabled).toBe(false);
    expect(discord?.source).toBe("openclaw-import");
    expect("botToken" in (discord ?? {})).toBe(false);
  });

  it("merges with existing channels and skips duplicate names", async () => {
    const existing = [
      {
        id: "telegram-existing",
        type: "telegram",
        name: "testbot",
        keychainService: "reins-channel-token",
        keychainAccount: "telegram-testbot",
        settings: {},
        enabled: false,
        source: "openclaw-import",
      },
    ];
    await Bun.write(outputPath, JSON.stringify(existing, null, 2));

    const keychain = new MockKeychainProvider();
    const mapper = new ChannelMapper(keychain, outputPath);

    const result = await mapper.map([
      makeTelegramConfig(),
      makeDiscordConfig(),
    ]);

    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);

    const channels = await Bun.file(outputPath).json() as Array<Record<string, unknown>>;
    expect(channels).toHaveLength(2);
    expect(channels.some((entry) => entry.name === "testbot")).toBe(true);
    expect(channels.some((entry) => entry.name === "ops-bot")).toBe(true);
    expect(keychain.keys.has("reins-channel-token:telegram-testbot")).toBe(false);
    expect(keychain.keys.has("reins-channel-token:discord-ops-bot")).toBe(true);
  });

  it("skips duplicate names inside the same mapping batch", async () => {
    const keychain = new MockKeychainProvider();
    const mapper = new ChannelMapper(keychain, outputPath);

    const result = await mapper.map([
      makeTelegramConfig({ name: "duplicate-name" }),
      makeDiscordConfig({ name: "duplicate-name" }),
    ]);

    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(1);

    const channels = await Bun.file(outputPath).json() as Array<Record<string, unknown>>;
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe("duplicate-name");
  });

  it("does not write files or keychain entries in dry-run mode", async () => {
    const keychain = new MockKeychainProvider();
    const mapper = new ChannelMapper(keychain, outputPath);

    const result = await mapper.map([makeTelegramConfig()], { dryRun: true });

    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(keychain.keys.size).toBe(0);
    expect(await Bun.file(outputPath).exists()).toBe(false);
  });
});

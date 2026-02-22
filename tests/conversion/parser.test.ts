import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { OpenClawParser } from "../../src/conversion/parser";
import { OpenClawParseError } from "../../src/conversion/types";

const STATE_DIR = "/mock/.openclaw";
const CONFIG_PATH = join(STATE_DIR, "openclaw.json");

describe("OpenClawParser", () => {
  it("parses valid JSON config and returns parsed install", async () => {
    const fixtureContent = await loadFixture();
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: fixtureContent,
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.stateDir).toBe(STATE_DIR);
    expect(result.configPath).toBe(CONFIG_PATH);
    expect(result.config.meta?.lastTouchedVersion).toBe("2026.2.3-1");
  });

  it("extracts meta.lastTouchedVersion", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: '{"meta":{"lastTouchedVersion":"2026.2.3-1"}}',
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.config.meta?.lastTouchedVersion).toBe("2026.2.3-1");
  });

  it("extracts auth profiles with correct count", async () => {
    const fixtureContent = await loadFixture();
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: fixtureContent,
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(Object.keys(result.config.auth?.profiles ?? {})).toHaveLength(2);
  });

  it("extracts agents.defaults.model.primary", async () => {
    const fixtureContent = await loadFixture();
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: fixtureContent,
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.config.agents?.defaults?.model?.primary).toBe("anthropic/claude-sonnet-4-5");
  });

  it("collects unknown top-level fields in unknownFields", async () => {
    const fixtureContent = await loadFixture();
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: fixtureContent,
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.config.unknownFields.unknownPlugin).toEqual({
      someField: "someValue",
    });
    expect("meta" in result.config.unknownFields).toBe(false);
    expect("auth" in result.config.unknownFields).toBe(false);
    expect("agents" in result.config.unknownFields).toBe(false);
    expect("channels" in result.config.unknownFields).toBe(false);
    expect("gateway" in result.config.unknownFields).toBe(false);
  });

  it("throws OpenClawParseError when openclaw.json is missing", async () => {
    const parser = createParser({
      readFileMap: {},
    });

    await expect(parser.parse(STATE_DIR)).rejects.toThrow(OpenClawParseError);
    await expect(parser.parse(STATE_DIR)).rejects.toThrow("openclaw.json not found");
  });

  it("throws OpenClawParseError on completely invalid JSON", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: "not-json-at-all",
      },
    });

    await expect(parser.parse(STATE_DIR)).rejects.toThrow(OpenClawParseError);
    await expect(parser.parse(STATE_DIR)).rejects.toThrow("Failed to parse openclaw.json");
  });

  it("handles config with missing optional sections", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: '{"meta":{"lastTouchedVersion":"x"}}',
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.config.auth).toBeUndefined();
    expect(result.config.channels).toBeUndefined();
    expect(result.config.meta?.lastTouchedVersion).toBe("x");
    expect(result.config.unknownFields).toEqual({});
  });

  it("populates agentDirs from listDirFn for agents directory", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: "{}",
      },
      listDirMap: {
        [join(STATE_DIR, "agents")]: ["main", "chief-of-staff"],
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.agentDirs).toEqual([
      join(STATE_DIR, "agents", "main"),
      join(STATE_DIR, "agents", "chief-of-staff"),
    ]);
  });

  it("populates credentialFiles from listDirFn for credentials", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: "{}",
      },
      listDirMap: {
        [join(STATE_DIR, "credentials")]: [
          "telegram-allowFrom.json",
          "telegram-pairing.json",
          "README.md",
        ],
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.credentialFiles).toEqual([
      join(STATE_DIR, "credentials", "telegram-allowFrom.json"),
      join(STATE_DIR, "credentials", "telegram-pairing.json"),
    ]);
  });

  it("parses JSON5 with trailing commas", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: `
          {
            "meta": {
              "lastTouchedVersion": "2026.2.3-1",
            },
          }
        `,
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.config.meta?.lastTouchedVersion).toBe("2026.2.3-1");
  });

  it("parses JSON5 with line comments", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: `
          {
            // this is allowed in JSON5-like configs
            "meta": {
              "lastTouchedVersion": "2026.2.3-1"
            }
          }
        `,
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.config.meta?.lastTouchedVersion).toBe("2026.2.3-1");
  });

  it("handles empty config object without crashing", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: "{}",
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.config.meta).toBeUndefined();
    expect(result.config.auth).toBeUndefined();
    expect(result.config.agents).toBeUndefined();
    expect(result.config.channels).toBeUndefined();
    expect(result.config.gateway).toBeUndefined();
    expect(result.config.browser).toBeUndefined();
    expect(result.config.unknownFields).toEqual({});
    expect(result.stateDir).toBe(STATE_DIR);
    expect(result.configPath).toBe(CONFIG_PATH);
  });

  it("returns error result when config contains a JSON array instead of object", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: "[1, 2, 3]",
      },
    });

    await expect(parser.parse(STATE_DIR)).rejects.toThrow(OpenClawParseError);
    await expect(parser.parse(STATE_DIR)).rejects.toThrow("Failed to parse openclaw.json");
  });

  it("extracts agents.named entries from fixture", async () => {
    const fixtureContent = await loadFixture();
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: fixtureContent,
      },
    });

    const result = await parser.parse(STATE_DIR);

    const named = result.config.agents?.named;
    expect(named).toBeDefined();
    expect(Object.keys(named!)).toHaveLength(2);
    expect(named!.eleanor?.id).toBe("eleanor");
    expect(named!.eleanor?.skills).toEqual(["web-search", "calendar"]);
    expect(named!.max?.id).toBe("max");
    expect(named!.max?.modelOverride).toBe("openai/gpt-4o");
  });

  it("extracts gateway config fields", async () => {
    const fixtureContent = await loadFixture();
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: fixtureContent,
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.config.gateway?.port).toBe(8080);
    expect(result.config.gateway?.authMode).toBe("token");
    expect(result.config.gateway?.authToken).toBe("fake-gateway-token");
  });

  it("extracts channel config entries", async () => {
    const fixtureContent = await loadFixture();
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: fixtureContent,
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.config.channels).toBeDefined();
    expect(result.config.channels!.telegram?.type).toBe("telegram");
    expect(result.config.channels!.telegram?.token).toBe("1234567890:FAKE_TOKEN_FOR_TESTING");
    expect(result.config.channels!.telegram?.chatId).toBe("-100123456789");
  });

  it("parses full fixture with all data categories populated", async () => {
    const fullFixtureContent = await loadFullFixture();
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: fullFixtureContent,
      },
    });

    const result = await parser.parse(STATE_DIR);

    // Meta
    expect(result.config.meta?.lastTouchedVersion).toBe("2026.2.3-1");
    expect(result.config.meta?.lastTouchedAt).toBe("2026-02-21T10:00:00.000Z");

    // Auth — 3 profiles
    const profiles = result.config.auth?.profiles;
    expect(profiles).toBeDefined();
    expect(Object.keys(profiles!)).toHaveLength(3);
    expect(profiles!["anthropic:api_key"]?.mode).toBe("api_key");
    expect(profiles!["google:oauth"]?.mode).toBe("oauth");

    // Agents — defaults + 3 named
    expect(result.config.agents?.defaults?.model?.primary).toBe("anthropic/claude-sonnet-4-5");
    const named = result.config.agents?.named;
    expect(named).toBeDefined();
    expect(Object.keys(named!)).toHaveLength(3);
    expect(named!.cfo?.id).toBe("cfo");

    // Channels — telegram + discord
    expect(result.config.channels).toBeDefined();
    expect(Object.keys(result.config.channels!)).toHaveLength(2);
    expect(result.config.channels!.discord?.type).toBe("discord");
    expect(result.config.channels!.discord?.guildId).toBe("123456789012345678");

    // Browser
    expect(result.config.browser?.enabled).toBe(true);
    expect(result.config.browser?.headless).toBe(false);
    expect(result.config.browser?.defaultProfile).toBe("default");

    // Gateway with nested unknown field
    expect(result.config.gateway?.port).toBe(8080);
    expect(result.config.gateway?.tailscale).toEqual({ enabled: false });

    // Unknown fields — skills, customPlugin, legacyField are not in KNOWN_TOP_LEVEL_KEYS
    expect(result.config.unknownFields.customPlugin).toEqual({
      enabled: true,
      config: { key: "value" },
    });
    expect(result.config.unknownFields.legacyField).toBe("should-end-up-in-unknownFields");
    expect(result.config.unknownFields.skills).toBeDefined();
  });

  it("handles config with missing meta section gracefully", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: JSON.stringify({
          auth: {
            profiles: {
              "test:token": { provider: "test", mode: "token" },
            },
          },
          gateway: { port: 9090 },
        }),
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.config.meta).toBeUndefined();
    expect(result.config.auth?.profiles).toBeDefined();
    expect(Object.keys(result.config.auth!.profiles!)).toHaveLength(1);
    expect(result.config.gateway?.port).toBe(9090);
  });

  it("collects multiple unknown top-level fields for import log", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: JSON.stringify({
          meta: { lastTouchedVersion: "1.0" },
          pluginA: { setting: true },
          pluginB: { count: 42 },
          experimentalFeature: "enabled",
        }),
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(Object.keys(result.config.unknownFields)).toHaveLength(3);
    expect(result.config.unknownFields.pluginA).toEqual({ setting: true });
    expect(result.config.unknownFields.pluginB).toEqual({ count: 42 });
    expect(result.config.unknownFields.experimentalFeature).toBe("enabled");
  });

  it("returns empty arrays for subdirectories when none exist", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: "{}",
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.agentDirs).toEqual([]);
    expect(result.workspaceDirs).toEqual([]);
    expect(result.skillDirs).toEqual([]);
    expect(result.sharedReferenceDirs).toEqual([]);
    expect(result.credentialFiles).toEqual([]);
  });

  it("throws OpenClawParseError on truncated JSON", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: '{"meta": {"lastTouchedVersion": "2026.2',
      },
    });

    await expect(parser.parse(STATE_DIR)).rejects.toThrow(OpenClawParseError);
    await expect(parser.parse(STATE_DIR)).rejects.toThrow("Failed to parse openclaw.json");
  });

  it("parses JSON5 with block comments", async () => {
    const parser = createParser({
      readFileMap: {
        [CONFIG_PATH]: `
          {
            /* block comment */
            "meta": {
              "lastTouchedVersion": "2026.2.3-1"
            }
          }
        `,
      },
    });

    const result = await parser.parse(STATE_DIR);

    expect(result.config.meta?.lastTouchedVersion).toBe("2026.2.3-1");
  });
});

async function loadFixture(): Promise<string> {
  const fixturePath = join(import.meta.dir, "fixtures", "openclaw-sample.json");
  return Bun.file(fixturePath).text();
}

async function loadFullFixture(): Promise<string> {
  const fixturePath = join(import.meta.dir, "fixtures", "openclaw-full.json");
  return Bun.file(fixturePath).text();
}

function createParser(options: {
  readFileMap: Record<string, string>;
  listDirMap?: Record<string, string[]>;
}): OpenClawParser {
  const readFileFn = async (path: string): Promise<string | null> => options.readFileMap[path] ?? null;
  const listDirFn = async (path: string): Promise<string[]> => options.listDirMap?.[path] ?? [];

  return new OpenClawParser({
    readFileFn,
    listDirFn,
  });
}

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

    expect(result.config.unknownFields).toEqual({
      unknownPlugin: {
        someField: "someValue",
      },
    });
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
});

async function loadFixture(): Promise<string> {
  const fixturePath = join(import.meta.dir, "fixtures", "openclaw-sample.json");
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

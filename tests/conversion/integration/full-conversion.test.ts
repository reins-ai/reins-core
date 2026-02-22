import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { AgentStore } from "../../../src/agents/store";
import {
  ALL_CONVERSION_CATEGORIES,
  type ConversionCategory,
} from "../../../src/agents/types";
import { IdentityFileManager } from "../../../src/agents/identity";
import { AgentWorkspaceManager } from "../../../src/agents/workspace";
import { ConflictDetector } from "../../../src/conversion/conflict";
import { OpenClawDetector } from "../../../src/conversion/detector";
import { ImportLogWriter } from "../../../src/conversion/import-log";
import { OpenClawParser } from "../../../src/conversion/parser";
import { ReportGenerator } from "../../../src/conversion/report";
import { ConversionService } from "../../../src/conversion/service";
import type { ConversionProgressEvent } from "../../../src/conversion/types";
import { ok, type Result } from "../../../src/result";
import type { KeychainProvider } from "../../../src/security/keychain-provider";
import type { SecurityError } from "../../../src/security/security-error";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockKeychainProvider implements KeychainProvider {
  public readonly entries = new Map<string, string>();

  public async get(
    service: string,
    account: string,
  ): Promise<Result<string | null, SecurityError>> {
    return ok(this.entries.get(`${service}:${account}`) ?? null);
  }

  public async set(
    service: string,
    account: string,
    secret: string,
  ): Promise<Result<void, SecurityError>> {
    this.entries.set(`${service}:${account}`, secret);
    return ok(undefined);
  }

  public async delete(
    service: string,
    account: string,
  ): Promise<Result<void, SecurityError>> {
    this.entries.delete(`${service}:${account}`);
    return ok(undefined);
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURE_SOURCE = join(__dirname, "fixtures", "openclaw.json");

/**
 * Filesystem-aware existence check that works for both files and directories.
 * The default Bun.file().exists() only works for files.
 */
async function fsExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a file as UTF-8 text, returning null if it does not exist.
 */
async function fsReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Build a temporary OpenClaw state directory with the fixture config and
 * the subdirectory structure the parser scans for.
 */
async function buildStateDir(tempDir: string): Promise<string> {
  const stateDir = join(tempDir, "openclaw-state");
  await mkdir(stateDir, { recursive: true });

  // Copy fixture config into the state dir
  const fixtureContent = await readFile(FIXTURE_SOURCE, "utf-8");
  await writeFile(join(stateDir, "openclaw.json"), fixtureContent);

  // Create subdirectories the parser inventories
  await mkdir(join(stateDir, "agents"), { recursive: true });
  await mkdir(join(stateDir, "skills"), { recursive: true });
  await mkdir(join(stateDir, "shared-references"), { recursive: true });
  await mkdir(join(stateDir, "credentials"), { recursive: true });

  return stateDir;
}

/**
 * Create an OpenClawDetector that uses real filesystem checks (supporting
 * directories) and the OPENCLAW_STATE_DIR env override.
 */
function createDetector(tempDir: string, stateDir: string): OpenClawDetector {
  return new OpenClawDetector({
    platform: process.platform,
    homeDirectory: tempDir,
    env: { OPENCLAW_STATE_DIR: stateDir },
    fileExistsFn: fsExists,
    readFileFn: fsReadFile,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Full Conversion Pipeline Integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `reins-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs full pipeline: detect → parse → map all categories → report", async () => {
    // --- Arrange ---
    const stateDir = await buildStateDir(tempDir);
    const agentsFilePath = join(tempDir, "agents.json");
    const importLogPath = join(tempDir, "IMPORT_LOG.md");
    const reportDir = tempDir;

    const keychain = new MockKeychainProvider();
    const agentStore = new AgentStore({ filePath: agentsFilePath });
    const workspaceManager = new AgentWorkspaceManager({ baseDir: join(tempDir, "agents") });
    const identityManager = new IdentityFileManager();
    const importLogWriter = new ImportLogWriter({ outputPath: importLogPath });

    const detector = createDetector(tempDir, stateDir);
    const parser = new OpenClawParser();

    // Progress tracking
    const progressEvents: ConversionProgressEvent[] = [];

    // Inject a ConflictDetector that reads from a temp channels file, not
    // ~/.reins/channels.json, so real system state doesn't cause false conflicts.
    const conflictDetector = new ConflictDetector({
      agentStore,
      keychainProvider: keychain,
      channelsFilePath: join(tempDir, "channels.json"),
    });

    const service = new ConversionService({
      keychainProvider: keychain,
      agentStore,
      workspaceManager,
      identityManager,
      importLogWriter,
      openClawDetector: detector,
      parser,
      conflictDetector,
    });

    await service.start();

    // --- Act ---
    const result = await service.convert({
      selectedCategories: [...ALL_CONVERSION_CATEGORIES],
      conflictStrategy: "skip",
      onProgress: (event) => {
        progressEvents.push({ ...event });
      },
    });

    // --- Assert: pipeline completed successfully ---
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const convResult = result.value;

    // All 9 categories should have results
    expect(convResult.categories).toHaveLength(ALL_CONVERSION_CATEGORIES.length);

    // No category should have skippedReason (all were selected)
    for (const cat of convResult.categories) {
      expect(cat.skippedReason).toBeUndefined();
    }

    // --- Assert: credentials stored in keychain ---
    // The fixture has 2 auth profiles (anthropic api_key, openai api_key),
    // 1 telegram channel token, 1 gateway auth token, and 1 tool search API key.
    // Some may be skipped by mappers (e.g. channel without name field).
    // At minimum, auth-profiles should store 2 keys.
    expect(keychain.entries.has("reins-byok:anthropic")).toBe(true);
    expect(keychain.entries.has("reins-byok:openai")).toBe(true);

    // Gateway auth token should be stored
    expect(keychain.entries.has("reins-gateway-token:openclaw-import")).toBe(true);

    // Tool search API key should be stored
    expect(keychain.entries.has("reins-tool-key:brave-search")).toBe(true);

    // --- Assert: agents category converted the named agent ---
    const agentsCat = convResult.categories.find((c) => c.category === "agents");
    expect(agentsCat).toBeDefined();
    expect(agentsCat!.converted).toBeGreaterThanOrEqual(1);

    // Verify agent was persisted to the store
    const agentListResult = await agentStore.list();
    expect(agentListResult.ok).toBe(true);
    if (agentListResult.ok) {
      expect(agentListResult.value.length).toBeGreaterThanOrEqual(1);
      const assistant = agentListResult.value.find((a) => a.id === "assistant");
      expect(assistant).toBeDefined();
      expect(assistant!.name).toBe("assistant");
      expect(assistant!.metadata.source).toBe("openclaw-import");
    }

    // --- Assert: auth-profiles category converted ---
    const authCat = convResult.categories.find((c) => c.category === "auth-profiles");
    expect(authCat).toBeDefined();
    expect(authCat!.converted).toBe(2);
    expect(authCat!.errors).toHaveLength(0);

    // --- Assert: gateway-config logged entries to import log ---
    const gatewayCat = convResult.categories.find((c) => c.category === "gateway-config");
    expect(gatewayCat).toBeDefined();
    // Gateway mapper converts authToken (1) and logs unmapped fields
    expect(gatewayCat!.converted).toBeGreaterThanOrEqual(1);

    // Import log should have entries from gateway mapper
    expect(importLogWriter.entryCount).toBeGreaterThan(0);

    // --- Assert: progress events were emitted ---
    // Each selected category should have at least a "started" and "complete" or "error" event
    const startedCategories = progressEvents
      .filter((e) => e.status === "started")
      .map((e) => e.category);
    expect(startedCategories.length).toBe(ALL_CONVERSION_CATEGORIES.length);

    // --- Assert: elapsed time is tracked ---
    expect(convResult.elapsedMs).toBeGreaterThanOrEqual(0);

    // --- Assert: report can be generated from the result ---
    const reportGenerator = new ReportGenerator({
      outputDir: reportDir,
      importLogPath,
    });
    const reportResult = await reportGenerator.generate(convResult);
    expect(reportResult.ok).toBe(true);
    if (reportResult.ok) {
      const reportContent = await readFile(reportResult.value, "utf-8");
      expect(reportContent).toContain("Reins Conversion Report");
      expect(reportContent).toContain("Agents");
      expect(reportContent).toContain("Auth Profiles");
      expect(reportContent).toContain("Gateway Config");
    }

    await service.stop();
  });

  it("skips categories not in selectedCategories", async () => {
    const stateDir = await buildStateDir(tempDir);
    const agentsFilePath = join(tempDir, "agents.json");
    const importLogPath = join(tempDir, "IMPORT_LOG.md");

    const keychain = new MockKeychainProvider();
    const agentStore = new AgentStore({ filePath: agentsFilePath });
    const workspaceManager = new AgentWorkspaceManager({ baseDir: join(tempDir, "agents") });
    const identityManager = new IdentityFileManager();
    const importLogWriter = new ImportLogWriter({ outputPath: importLogPath });

    const detector = createDetector(tempDir, stateDir);

    const service = new ConversionService({
      keychainProvider: keychain,
      agentStore,
      workspaceManager,
      identityManager,
      importLogWriter,
      openClawDetector: detector,
      parser: new OpenClawParser(),
    });

    await service.start();

    const selected: ConversionCategory[] = ["agents", "auth-profiles"];
    const result = await service.convert({
      selectedCategories: selected,
      conflictStrategy: "skip",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const convResult = result.value;
    expect(convResult.categories).toHaveLength(ALL_CONVERSION_CATEGORIES.length);

    for (const cat of convResult.categories) {
      if (selected.includes(cat.category)) {
        expect(cat.skippedReason).toBeUndefined();
      } else {
        expect(cat.skippedReason).toBe("not selected");
        expect(cat.converted).toBe(0);
      }
    }

    // Only agents and auth-profiles should have converted items
    const agentsCat = convResult.categories.find((c) => c.category === "agents");
    expect(agentsCat!.converted).toBeGreaterThanOrEqual(1);

    const authCat = convResult.categories.find((c) => c.category === "auth-profiles");
    expect(authCat!.converted).toBe(2);

    // Keychain should have auth keys but NOT gateway/tool keys
    expect(keychain.entries.has("reins-byok:anthropic")).toBe(true);
    expect(keychain.entries.has("reins-gateway-token:openclaw-import")).toBe(false);
    expect(keychain.entries.has("reins-tool-key:brave-search")).toBe(false);

    await service.stop();
  });

  it("handles dryRun — no keychain entries, no agent store writes", async () => {
    const stateDir = await buildStateDir(tempDir);
    const agentsFilePath = join(tempDir, "agents.json");
    const importLogPath = join(tempDir, "IMPORT_LOG.md");

    const keychain = new MockKeychainProvider();
    const agentStore = new AgentStore({ filePath: agentsFilePath });
    const workspaceManager = new AgentWorkspaceManager({ baseDir: join(tempDir, "agents") });
    const identityManager = new IdentityFileManager();
    const importLogWriter = new ImportLogWriter({ outputPath: importLogPath });

    const detector = createDetector(tempDir, stateDir);

    const service = new ConversionService({
      keychainProvider: keychain,
      agentStore,
      workspaceManager,
      identityManager,
      importLogWriter,
      openClawDetector: detector,
      parser: new OpenClawParser(),
    });

    await service.start();

    const result = await service.convert({
      selectedCategories: [...ALL_CONVERSION_CATEGORIES],
      conflictStrategy: "skip",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const convResult = result.value;

    // Categories should still report converted counts (dry run counts items)
    const totalConverted = convResult.categories.reduce((s, c) => s + c.converted, 0);
    expect(totalConverted).toBeGreaterThan(0);

    // But keychain should be empty — no secrets written in dry run
    // Note: gateway-config mapper always adds import log entries (even in dry run)
    // but the auth token should NOT be stored in keychain
    expect(keychain.entries.has("reins-byok:anthropic")).toBe(false);
    expect(keychain.entries.has("reins-byok:openai")).toBe(false);

    // Agent store should be empty — no agents persisted in dry run
    const agentListResult = await agentStore.list();
    expect(agentListResult.ok).toBe(true);
    if (agentListResult.ok) {
      expect(agentListResult.value).toHaveLength(0);
    }

    await service.stop();
  });

  it("detection finds the fixture via OPENCLAW_STATE_DIR", async () => {
    const stateDir = await buildStateDir(tempDir);
    const detector = createDetector(tempDir, stateDir);

    const detection = await detector.detect();

    expect(detection.found).toBe(true);
    expect(detection.path).toBe(stateDir);
    expect(detection.version).toBe("2026.2.3-1");
  });

  it("parser extracts config sections from fixture", async () => {
    const stateDir = await buildStateDir(tempDir);
    const parser = new OpenClawParser();

    const parsed = await parser.parse(stateDir);

    expect(parsed.stateDir).toBe(stateDir);
    expect(parsed.config.meta?.lastTouchedVersion).toBe("2026.2.3-1");
    expect(parsed.config.auth?.profiles).toBeDefined();
    expect(Object.keys(parsed.config.auth!.profiles!)).toHaveLength(2);
    expect(parsed.config.agents?.named).toBeDefined();
    expect(Object.keys(parsed.config.agents!.named!)).toHaveLength(1);
    expect(parsed.config.channels).toBeDefined();
    expect(parsed.config.gateway).toBeDefined();
    expect(parsed.config.gateway!.authToken).toBe("rm-integration-gateway-FAKE");

    // "tools" is not a known top-level key, so it ends up in unknownFields
    expect(parsed.config.unknownFields["tools"]).toBeDefined();
  });
});

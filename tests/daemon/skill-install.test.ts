import { afterEach, describe, expect, it, mock } from "bun:test";

import { DaemonHttpServer } from "../../src/daemon/server";
import type { DaemonResult } from "../../src/daemon/types";
import { ProviderAuthService } from "../../src/providers/auth-service";
import { ProviderRegistry } from "../../src/providers/registry";
import { ModelRouter } from "../../src/providers/router";
import { err, ok } from "../../src/result";
import type { ClawHubSource } from "../../src/marketplace/clawhub/source";
import type { InstallResult } from "../../src/marketplace/install/types";
import type { MigrationPipeline } from "../../src/marketplace/migration/pipeline";
import { MarketplaceError, MARKETPLACE_ERROR_CODES } from "../../src/marketplace/errors";
import { SkillRegistry } from "../../src/skills/registry";
import type { DiscoveryReport, SkillScanner } from "../../src/skills/scanner";
import type { SkillDaemonService, SkillDaemonServiceState } from "../../src/skills/skill-service";
import type { Skill, SkillTrustLevel } from "../../src/skills/types";

function createStubAuthService(): ProviderAuthService {
  const registry = new ProviderRegistry();
  return new ProviderAuthService({
    store: {
      get: async () => ok(null),
      set: async () => ok(undefined),
      delete: async () => ok(undefined),
      list: async () => ok([]),
      has: async () => ok(false),
    } as any,
    registry,
    oauthProviderRegistry: { get: () => undefined, list: () => [], register: () => {} } as any,
    apiKeyStrategies: {},
  });
}

function createMockSkill(overrides: Partial<{
  name: string;
  description: string;
  enabled: boolean;
  trustLevel: SkillTrustLevel;
}>): Skill {
  const name = overrides.name ?? "test-skill";
  return {
    config: {
      name,
      enabled: overrides.enabled ?? true,
      trustLevel: overrides.trustLevel ?? "untrusted",
      path: `/skills/${name}`,
    },
    summary: {
      name,
      description: overrides.description ?? `Description for ${name}`,
    },
    hasScripts: false,
    hasIntegration: false,
    scriptFiles: [],
    categories: [],
    triggers: [],
  };
}

function createMockSkillService(options: {
  state?: SkillDaemonServiceState;
  skills?: Skill[];
  scanReport?: DiscoveryReport;
  scanFn?: () => Promise<DiscoveryReport>;
}): SkillDaemonService {
  const state = options.state ?? "running";
  const skills = options.skills ?? [];
  const scanReport = options.scanReport ?? { discovered: 0, loaded: 0, errors: [], skipped: 0 };

  const registry = new SkillRegistry();
  for (const skill of skills) {
    registry.register(skill);
  }

  const scanner: SkillScanner = {
    scan: options.scanFn ?? (async () => scanReport),
    loadSkill: () => undefined,
  } as unknown as SkillScanner;

  return {
    id: "skills",
    getState: () => state,
    getRegistry: () => (state === "running" ? registry : null),
    getScanner: () => (state === "running" ? scanner : null),
    getWatcher: () => null,
    getLastDiscoveryReport: () => null,
    start: async (): Promise<DaemonResult<void>> => ok(undefined),
    stop: async (): Promise<DaemonResult<void>> => ok(undefined),
  } as unknown as SkillDaemonService;
}

describe("Skill install route", () => {
  const servers: DaemonHttpServer[] = [];
  let testPort = 18200;

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;
  });

  async function startServer(options: {
    skillService?: SkillDaemonService;
    installFn?: (slug: string, version: string) => Promise<ReturnType<typeof ok<InstallResult>> | ReturnType<typeof err<never>>>;
    createClawHubSourceFn?: () => ClawHubSource;
    createMigrationPipelineFn?: () => MigrationPipeline;
  }): Promise<number> {
    const installFn = options.installFn ?? (async (slug, version) =>
      ok({
        slug,
        version,
        installedPath: `/tmp/${slug}`,
        migrated: false,
      }));

    const createClawHubSourceFn =
      options.createClawHubSourceFn
      ?? (() => ({ id: "mock", name: "mock", description: "mock" } as unknown as ClawHubSource));

    const createMigrationPipelineFn =
      options.createMigrationPipelineFn
      ?? (() => ({ migrate: async () => err(new Error("not-used")) } as unknown as MigrationPipeline));

    const port = testPort++;
    const server = new DaemonHttpServer({
      port,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      skillService: options.skillService,
      createClawHubSource: createClawHubSourceFn,
      createMigrationPipeline: createMigrationPipelineFn,
      createSkillInstaller: () => ({ install: installFn }),
    });

    servers.push(server);
    const result = await server.start();
    expect(result.ok).toBe(true);
    return port;
  }

  it("POST /api/skills/install installs a skill and returns success", async () => {
    const port = await startServer({
      skillService: createMockSkillService({ skills: [] }),
    });

    const response = await fetch(`http://localhost:${port}/api/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "my-skill", version: "1.0.0" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      name: "my-skill",
      version: "1.0.0",
    });
  });

  it("returns 400 when slug is missing", async () => {
    const port = await startServer({
      skillService: createMockSkillService({ skills: [] }),
    });

    const response = await fetch(`http://localhost:${port}/api/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "1.0.0" }),
    });

    expect(response.status).toBe(400);
  });

  it("returns 400 when slug is empty", async () => {
    const port = await startServer({
      skillService: createMockSkillService({ skills: [] }),
    });

    const response = await fetch(`http://localhost:${port}/api/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "   ", version: "1.0.0" }),
    });

    expect(response.status).toBe(400);
  });

  it("returns 409 when skill is already installed", async () => {
    const port = await startServer({
      skillService: createMockSkillService({
        skills: [createMockSkill({ name: "my-skill" })],
      }),
    });

    const response = await fetch(`http://localhost:${port}/api/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "my-skill", version: "1.0.0" }),
    });

    expect(response.status).toBe(409);
  });

  it("returns 500 when installer fails", async () => {
    const installFn = mock(async () =>
      err(
        new MarketplaceError(
          "download failed",
          MARKETPLACE_ERROR_CODES.DOWNLOAD_ERROR,
        ),
      ));

    const port = await startServer({
      skillService: createMockSkillService({ skills: [] }),
      installFn,
    });

    const response = await fetch(`http://localhost:${port}/api/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "my-skill", version: "1.0.0" }),
    });

    expect(response.status).toBe(500);
  });

  it("returns 503 when skillService is null", async () => {
    const port = await startServer({});

    const response = await fetch(`http://localhost:${port}/api/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "my-skill", version: "1.0.0" }),
    });

    expect(response.status).toBe(503);
  });

  it("returns 405 for GET /api/skills/install", async () => {
    const port = await startServer({
      skillService: createMockSkillService({ skills: [] }),
    });

    const response = await fetch(`http://localhost:${port}/api/skills/install`, {
      method: "GET",
    });

    expect(response.status).toBe(405);
  });

  it("calls scanner.scan() after successful install", async () => {
    const scanFn = mock(async () => ({ discovered: 1, loaded: 1, errors: [], skipped: 0 }));
    const sourceFactory = mock(
      () => ({ id: "clawhub", name: "ClawHub", description: "mock" } as unknown as ClawHubSource),
    );
    const pipelineFactory = mock(
      () => ({ migrate: async () => err(new Error("not-used")) } as unknown as MigrationPipeline),
    );
    const installFn = mock(async (slug: string, version: string) =>
      ok({
        slug,
        version,
        installedPath: `/tmp/${slug}`,
        migrated: false,
      }));

    const port = await startServer({
      skillService: createMockSkillService({ skills: [], scanFn }),
      installFn,
      createClawHubSourceFn: sourceFactory,
      createMigrationPipelineFn: pipelineFactory,
    });

    const response = await fetch(`http://localhost:${port}/api/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "my-skill", version: "1.0.0" }),
    });

    expect(response.status).toBe(200);
    expect(scanFn).toHaveBeenCalledTimes(1);
    expect(installFn).toHaveBeenCalledWith("my-skill", "1.0.0");
    expect(sourceFactory).toHaveBeenCalledTimes(1);
    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });
});

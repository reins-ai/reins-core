import { afterEach, describe, expect, it } from "bun:test";

import { ok } from "../../src/result";
import { DaemonHttpServer } from "../../src/daemon/server";
import { ProviderAuthService } from "../../src/providers/auth-service";
import { ProviderRegistry } from "../../src/providers/registry";
import { ModelRouter } from "../../src/providers/router";
import { SkillRegistry } from "../../src/skills/registry";
import type { SkillDaemonService, SkillDaemonServiceState } from "../../src/skills/skill-service";
import type { SkillScanner, DiscoveryReport } from "../../src/skills/scanner";
import type { Skill, SkillTrustLevel } from "../../src/skills/types";
import type { DaemonResult } from "../../src/daemon/types";

/**
 * Minimal auth service stub — satisfies DaemonHttpServer constructor
 * without requiring real credential stores or OAuth providers.
 */
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

/**
 * Build a mock Skill object with sensible defaults.
 */
function createMockSkill(overrides: Partial<{
  name: string;
  description: string;
  enabled: boolean;
  trustLevel: SkillTrustLevel;
  categories: string[];
  hasScripts: boolean;
  hasIntegration: boolean;
  scriptFiles: string[];
  triggers: string[];
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
    hasScripts: overrides.hasScripts ?? false,
    hasIntegration: overrides.hasIntegration ?? false,
    scriptFiles: overrides.scriptFiles ?? [],
    categories: overrides.categories ?? [],
    triggers: overrides.triggers ?? [],
  };
}

/**
 * Create a mock SkillDaemonService that satisfies the interface used by
 * DaemonHttpServer.handleSkillRequest without any filesystem dependency.
 */
function createMockSkillService(options: {
  state?: SkillDaemonServiceState;
  skills?: Skill[];
  scanReport?: DiscoveryReport;
  skillContent?: Map<string, { body: string; metadata: Record<string, unknown>; raw: string }>;
}): SkillDaemonService {
  const state = options.state ?? "running";
  const skills = options.skills ?? [];
  const scanReport = options.scanReport ?? { discovered: 0, loaded: 0, errors: [], skipped: 0 };
  const skillContent = options.skillContent ?? new Map();

  const registry = new SkillRegistry();
  for (const skill of skills) {
    registry.register(skill);
  }

  const scanner: SkillScanner = {
    scan: async () => scanReport,
    loadSkill: (name: string) => skillContent.get(name),
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

describe("Skill routes", () => {
  const servers: DaemonHttpServer[] = [];
  let testPort = 18100;

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;
  });

  async function startServer(skillService: SkillDaemonService | undefined): Promise<number> {
    const port = testPort++;
    const server = new DaemonHttpServer({
      port,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      skillService: skillService ?? undefined,
    });
    servers.push(server);
    const result = await server.start();
    expect(result.ok).toBe(true);
    return port;
  }

  // ── GET /api/skills ──────────────────────────────────────────────

  it("GET /api/skills returns array of SkillSummaryResponse objects", async () => {
    const skills = [
      createMockSkill({
        name: "git-helper",
        description: "Assist with git workflows.",
        enabled: true,
        trustLevel: "trusted",
        categories: ["development"],
        hasScripts: true,
        hasIntegration: false,
      }),
      createMockSkill({
        name: "calendar",
        description: "Manage calendar events.",
        enabled: false,
        trustLevel: "verified",
        categories: ["productivity", "scheduling"],
        hasScripts: false,
        hasIntegration: true,
      }),
    ];

    const port = await startServer(createMockSkillService({ skills }));
    const response = await fetch(`http://localhost:${port}/api/skills`);

    expect(response.status).toBe(200);

    const data = (await response.json()) as Array<{
      name: string;
      description: string;
      enabled: boolean;
      trustLevel: string;
      categories: string[];
      hasScripts: boolean;
      hasIntegration: boolean;
    }>;

    expect(data).toHaveLength(2);

    const gitHelper = data.find((s) => s.name === "git-helper");
    expect(gitHelper).toBeDefined();
    expect(gitHelper!.description).toBe("Assist with git workflows.");
    expect(gitHelper!.enabled).toBe(true);
    expect(gitHelper!.trustLevel).toBe("trusted");
    expect(gitHelper!.categories).toEqual(["development"]);
    expect(gitHelper!.hasScripts).toBe(true);
    expect(gitHelper!.hasIntegration).toBe(false);

    const calendar = data.find((s) => s.name === "calendar");
    expect(calendar).toBeDefined();
    expect(calendar!.description).toBe("Manage calendar events.");
    expect(calendar!.enabled).toBe(false);
    expect(calendar!.trustLevel).toBe("verified");
    expect(calendar!.categories).toEqual(["productivity", "scheduling"]);
    expect(calendar!.hasScripts).toBe(false);
    expect(calendar!.hasIntegration).toBe(true);
  });

  // ── GET /api/skills/:name (existing skill) ──────────────────────

  it("GET /api/skills/:name returns SkillDetailResponse for existing skill", async () => {
    const skill = createMockSkill({
      name: "git-helper",
      description: "Assist with git workflows.",
      enabled: true,
      trustLevel: "trusted",
      categories: ["development"],
      hasScripts: true,
      hasIntegration: true,
      scriptFiles: ["commit.sh", "branch.sh"],
      triggers: ["git", "commit", "branch"],
    });

    const skillContent = new Map([
      ["git-helper", {
        body: "# Git Helper\n\nHelps with git operations.",
        metadata: { name: "git-helper" },
        raw: "---\nname: git-helper\n---\n\n# Git Helper\n\nHelps with git operations.",
      }],
    ]);

    const port = await startServer(createMockSkillService({
      skills: [skill],
      skillContent,
    }));

    const response = await fetch(`http://localhost:${port}/api/skills/git-helper`);
    expect(response.status).toBe(200);

    const data = (await response.json()) as {
      name: string;
      description: string;
      enabled: boolean;
      trustLevel: string;
      categories: string[];
      hasScripts: boolean;
      hasIntegration: boolean;
      triggers: string[];
      scriptFiles: string[];
      integrationStatus: string;
      body: string;
    };

    expect(data.name).toBe("git-helper");
    expect(data.description).toBe("Assist with git workflows.");
    expect(data.enabled).toBe(true);
    expect(data.trustLevel).toBe("trusted");
    expect(data.categories).toEqual(["development"]);
    expect(data.hasScripts).toBe(true);
    expect(data.hasIntegration).toBe(true);
    expect(data.triggers).toEqual(["git", "commit", "branch"]);
    expect(data.scriptFiles).toEqual(["commit.sh", "branch.sh"]);
    expect(data.integrationStatus).toBe("needs_setup");
    expect(data.body).toBe("# Git Helper\n\nHelps with git operations.");
  });

  // ── GET /api/skills/:name (not found) ───────────────────────────

  it("GET /api/skills/:name returns 404 for unknown skill", async () => {
    const port = await startServer(createMockSkillService({ skills: [] }));
    const response = await fetch(`http://localhost:${port}/api/skills/nonexistent`);

    expect(response.status).toBe(404);

    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("nonexistent");
  });

  // ── POST /api/skills/:name/enable ───────────────────────────────

  it("POST /api/skills/:name/enable returns ok true", async () => {
    const skill = createMockSkill({ name: "git-helper", enabled: false });
    const port = await startServer(createMockSkillService({ skills: [skill] }));

    const response = await fetch(`http://localhost:${port}/api/skills/git-helper/enable`, {
      method: "POST",
    });

    expect(response.status).toBe(200);

    const data = (await response.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it("POST /api/skills/:name/enable returns 404 for unknown skill", async () => {
    const port = await startServer(createMockSkillService({ skills: [] }));

    const response = await fetch(`http://localhost:${port}/api/skills/nonexistent/enable`, {
      method: "POST",
    });

    expect(response.status).toBe(404);

    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("nonexistent");
  });

  // ── POST /api/skills/:name/disable ──────────────────────────────

  it("POST /api/skills/:name/disable returns ok true", async () => {
    const skill = createMockSkill({ name: "git-helper", enabled: true });
    const port = await startServer(createMockSkillService({ skills: [skill] }));

    const response = await fetch(`http://localhost:${port}/api/skills/git-helper/disable`, {
      method: "POST",
    });

    expect(response.status).toBe(200);

    const data = (await response.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it("POST /api/skills/:name/disable returns 404 for unknown skill", async () => {
    const port = await startServer(createMockSkillService({ skills: [] }));

    const response = await fetch(`http://localhost:${port}/api/skills/nonexistent/disable`, {
      method: "POST",
    });

    expect(response.status).toBe(404);

    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("nonexistent");
  });

  // ── POST /api/skills/scan ───────────────────────────────────────

  it("POST /api/skills/scan triggers re-scan and returns DiscoveryReport", async () => {
    const scanReport: DiscoveryReport = {
      discovered: 3,
      loaded: 2,
      errors: [{ skillDir: "/skills/broken", error: "Missing SKILL.md" }],
      skipped: 1,
    };

    const port = await startServer(createMockSkillService({ scanReport }));

    const response = await fetch(`http://localhost:${port}/api/skills/scan`, {
      method: "POST",
    });

    expect(response.status).toBe(200);

    const data = (await response.json()) as DiscoveryReport;
    expect(data.discovered).toBe(3);
    expect(data.loaded).toBe(2);
    expect(data.skipped).toBe(1);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0]!.skillDir).toBe("/skills/broken");
    expect(data.errors[0]!.error).toBe("Missing SKILL.md");
  });

  // ── 503 when skill service is not available ─────────────────────

  it("returns 503 when skillService is null", async () => {
    const port = await startServer(undefined);
    const response = await fetch(`http://localhost:${port}/api/skills`);

    expect(response.status).toBe(503);

    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("not available");
  });

  it("returns 503 when skill service state is not running", async () => {
    const port = await startServer(createMockSkillService({ state: "idle" }));
    const response = await fetch(`http://localhost:${port}/api/skills`);

    expect(response.status).toBe(503);

    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("not available");
  });

  // ── 405 for unsupported HTTP methods ────────────────────────────

  it("returns 405 for DELETE on /api/skills", async () => {
    const port = await startServer(createMockSkillService({ skills: [] }));
    const response = await fetch(`http://localhost:${port}/api/skills`, {
      method: "DELETE",
    });

    expect(response.status).toBe(405);

    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("not allowed");
  });

  it("returns 405 for PUT on /api/skills/:name", async () => {
    const skill = createMockSkill({ name: "git-helper" });
    const skillContent = new Map([
      ["git-helper", { body: "body", metadata: {}, raw: "raw" }],
    ]);
    const port = await startServer(createMockSkillService({
      skills: [skill],
      skillContent,
    }));

    const response = await fetch(`http://localhost:${port}/api/skills/git-helper`, {
      method: "PUT",
    });

    expect(response.status).toBe(405);

    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("not allowed");
  });

  it("returns 405 for GET on /api/skills/:name/enable", async () => {
    const skill = createMockSkill({ name: "git-helper" });
    const port = await startServer(createMockSkillService({ skills: [skill] }));

    const response = await fetch(`http://localhost:${port}/api/skills/git-helper/enable`, {
      method: "GET",
    });

    expect(response.status).toBe(405);

    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("not allowed");
  });

  it("returns 405 for GET on /api/skills/scan", async () => {
    const port = await startServer(createMockSkillService({ skills: [] }));

    const response = await fetch(`http://localhost:${port}/api/skills/scan`, {
      method: "GET",
    });

    expect(response.status).toBe(405);

    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("not allowed");
  });
});

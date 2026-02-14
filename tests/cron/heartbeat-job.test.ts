import { describe, expect, test } from "bun:test";

import { ReinsError } from "../../src/errors";
import { err, ok } from "../../src/result";
import type { OverlayResolution } from "../../src/environment/types";
import {
  createHeartbeatJob,
  HEARTBEAT_JOB_ACTION,
  HEARTBEAT_JOB_ID,
  NoopHeartbeatHandler,
  resolveHeartbeatContext,
  toHeartbeatCronExpression,
  type HeartbeatContext,
  type HeartbeatEnvironmentResolver,
  type HeartbeatHandler,
} from "../../src/cron/jobs/heartbeat-job";

function createResolvedDocuments(environmentName = "default"): OverlayResolution {
  const now = new Date("2026-02-13T10:00:00.000Z");

  const createDocument = (type: keyof OverlayResolution["documents"]) => ({
    type,
    source: "active" as const,
    sourceEnvironment: environmentName,
    document: {
      type,
      path: `/tmp/${environmentName}/${type}.md`,
      content: `# ${type}`,
      environmentName,
      loadedAt: now,
    },
  });

  return {
    activeEnvironment: environmentName,
    fallbackEnvironment: "default",
    documents: {
      PERSONALITY: createDocument("PERSONALITY"),
      USER: createDocument("USER"),
      HEARTBEAT: createDocument("HEARTBEAT"),
      ROUTINES: createDocument("ROUTINES"),
      GOALS: createDocument("GOALS"),
      KNOWLEDGE: createDocument("KNOWLEDGE"),
      TOOLS: createDocument("TOOLS"),
      BOUNDARIES: createDocument("BOUNDARIES"),
    },
  };
}

describe("createHeartbeatJob", () => {
  test("creates heartbeat job with default 30-minute interval", () => {
    const job = createHeartbeatJob();

    expect(job.id).toBe(HEARTBEAT_JOB_ID);
    expect(job.schedule).toBe("*/30 * * * *");
    expect(job.payload.action).toBe(HEARTBEAT_JOB_ACTION);
    expect(job.payload.parameters.intervalMinutes).toBe(30);
    expect(job.payload.parameters.environmentName).toBeNull();
    expect(job.tags).toContain("heartbeat");
  });

  test("creates heartbeat job with custom interval and environment", () => {
    const job = createHeartbeatJob({ intervalMinutes: 15, environmentName: "work" });

    expect(job.schedule).toBe("*/15 * * * *");
    expect(job.payload.parameters.intervalMinutes).toBe(15);
    expect(job.payload.parameters.environmentName).toBe("work");
  });
});

describe("toHeartbeatCronExpression", () => {
  test("converts interval minutes into 5-field cron expression", () => {
    expect(toHeartbeatCronExpression(5)).toBe("*/5 * * * *");
    expect(toHeartbeatCronExpression(30)).toBe("*/30 * * * *");
    expect(toHeartbeatCronExpression(59)).toBe("*/59 * * * *");
  });
});

describe("HeartbeatHandler", () => {
  test("NoopHeartbeatHandler implements contract and returns result shape", async () => {
    const handler = new NoopHeartbeatHandler();

    const result = await handler.execute({
      currentEnvironment: "default",
      resolvedDocuments: createResolvedDocuments(),
      timestamp: new Date("2026-02-13T10:30:00.000Z"),
    });

    expect(result.action).toBe("suppressed");
    expect(result.reason).toBeDefined();
  });

  test("custom handler receives environment context", async () => {
    let receivedContext: HeartbeatContext | undefined;

    const handler: HeartbeatHandler = {
      async execute(context) {
        receivedContext = context;
        return {
          action: "executed",
          output: "ok",
        };
      },
    };

    const context: HeartbeatContext = {
      currentEnvironment: "work",
      resolvedDocuments: createResolvedDocuments("work"),
      timestamp: new Date("2026-02-13T11:00:00.000Z"),
    };

    const result = await handler.execute(context);

    expect(result.action).toBe("executed");
    expect(receivedContext?.currentEnvironment).toBe("work");
    expect(receivedContext?.resolvedDocuments.activeEnvironment).toBe("work");
  });
});

describe("resolveHeartbeatContext", () => {
  test("resolves active environment context from resolver", async () => {
    const resolver: HeartbeatEnvironmentResolver = {
      async getCurrentEnvironment() {
        return ok("travel");
      },
      async getResolvedDocuments(environmentName?: string) {
        return ok(createResolvedDocuments(environmentName ?? "default"));
      },
    };

    const now = new Date("2026-02-13T12:00:00.000Z");
    const context = await resolveHeartbeatContext(resolver, {}, () => now);

    expect(context.ok).toBe(true);
    if (!context.ok) {
      return;
    }

    expect(context.value.currentEnvironment).toBe("travel");
    expect(context.value.resolvedDocuments.activeEnvironment).toBe("travel");
    expect(context.value.timestamp.toISOString()).toBe(now.toISOString());
  });

  test("uses explicit environment name when provided", async () => {
    const resolver: HeartbeatEnvironmentResolver = {
      async getCurrentEnvironment() {
        return ok("default");
      },
      async getResolvedDocuments(environmentName?: string) {
        return ok(createResolvedDocuments(environmentName ?? "default"));
      },
    };

    const context = await resolveHeartbeatContext(resolver, { environmentName: "work" });
    expect(context.ok).toBe(true);
    if (!context.ok) {
      return;
    }

    expect(context.value.currentEnvironment).toBe("work");
    expect(context.value.resolvedDocuments.activeEnvironment).toBe("work");
  });

  test("returns resolver errors", async () => {
    const resolver: HeartbeatEnvironmentResolver = {
      async getCurrentEnvironment() {
        return err(new ReinsError("failed to load active environment", "TEST_ERROR"));
      },
      async getResolvedDocuments(_environmentName?: string) {
        return ok(createResolvedDocuments("default"));
      },
    };

    const context = await resolveHeartbeatContext(resolver);
    expect(context.ok).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigStore } from "../../src/config/store";
import { FileEnvironmentResolver } from "../../src/environment/file-resolver";
import { EnvironmentSwitchService } from "../../src/environment/switch-service";
import { ROUTINES_TEMPLATE } from "../../src/environment/templates/routines.md";
import { GOALS_TEMPLATE } from "../../src/environment/templates/goals.md";
import { HEARTBEAT_TEMPLATE } from "../../src/environment/templates/heartbeat.md";
import { ENVIRONMENT_DOCUMENTS, type EnvironmentDocument } from "../../src/environment/types";
import { HeartbeatOutputHandler } from "../../src/heartbeat/handler";
import { AlertDedupeStore } from "../../src/heartbeat/dedupe";
import { parseGoals, generateWeeklyReviewSummary } from "../../src/heartbeat/goals";
import { RoutineDueEvaluator } from "../../src/heartbeat/routines";
import { HeartbeatSkipEvaluator } from "../../src/heartbeat/skip-evaluator";

const createdDirectories: string[] = [];

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

async function setupEnvironment(
  environmentsRoot: string,
  environmentName: string,
  documents: Partial<Record<EnvironmentDocument, string>>,
): Promise<void> {
  const environmentDirectory = join(environmentsRoot, environmentName);
  await mkdir(environmentDirectory, { recursive: true });

  for (const documentType of ENVIRONMENT_DOCUMENTS) {
    const content = documents[documentType];
    if (typeof content === "undefined") {
      continue;
    }

    await writeFile(
      join(environmentDirectory, `${documentType}.md`),
      content,
      "utf8",
    );
  }
}

function buildDocumentSet(prefix: string): Record<EnvironmentDocument, string> {
  const documents = {} as Record<EnvironmentDocument, string>;
  for (const documentType of ENVIRONMENT_DOCUMENTS) {
    documents[documentType] = `${prefix} ${documentType}`;
  }
  return documents;
}

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (!directory) {
      continue;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

describe("integration/heartbeat-routines-goals", () => {
  it("skips heartbeat when nothing is due", () => {
    const evaluator = new HeartbeatSkipEvaluator(new RoutineDueEvaluator());

    const decision = evaluator.shouldSkip({
      now: new Date(2026, 1, 16, 5, 0, 0),
      routinesContent: ROUTINES_TEMPLATE,
      heartbeatContent: "# HEARTBEAT\n\n## Check Items\n",
    });

    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe("skip.no_due_routines_and_no_heartbeat_checks");
    expect(decision.dueRoutines).toHaveLength(0);
  });

  it("runs heartbeat when morning routine is due", () => {
    const evaluator = new HeartbeatSkipEvaluator(new RoutineDueEvaluator());

    const decision = evaluator.shouldSkip({
      now: new Date(2026, 1, 16, 8, 5, 0),
      routinesContent: ROUTINES_TEMPLATE,
      heartbeatContent: "# HEARTBEAT\n\n## Check Items\n",
      lastHeartbeat: new Date(2026, 1, 16, 6, 55, 0),
    });

    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe("execute.routines_due");
    expect(decision.dueRoutines.some((due) => due.routine.name === "Morning Kickoff")).toBe(true);
  });

  it("suppresses HEARTBEAT_OK responses", () => {
    const handler = new HeartbeatOutputHandler(new AlertDedupeStore());

    const result = handler.processOutput("HEARTBEAT_OK");

    expect(result.shouldDeliver).toBe(false);
    expect(result.reason).toBe("ack_suppressed");
    expect(result.content).toBe("");
  });

  it("deduplicates repeated alerts inside dedupe window", () => {
    let now = 1_000;
    const dedupeStore = new AlertDedupeStore(10_000, () => now);
    const handler = new HeartbeatOutputHandler(dedupeStore);

    const first = handler.processOutput("Alert: Weekly review is due.");
    const second = handler.processOutput("Alert: Weekly review is due.");

    expect(first.shouldDeliver).toBe(true);
    expect(first.reason).toBe("delivered");
    expect(second.shouldDeliver).toBe(false);
    expect(second.reason).toBe("duplicate_suppressed");

    now = 20_500;
    const third = handler.processOutput("Alert: Weekly review is due.");
    expect(third.shouldDeliver).toBe(true);
    expect(third.reason).toBe("delivered");
  });

  it("includes active, completed, and paused goals in weekly review summary", () => {
    const goals = parseGoals(GOALS_TEMPLATE);
    const summary = generateWeeklyReviewSummary(goals);

    expect(goals.some((goal) => goal.state === "active")).toBe(true);
    expect(goals.some((goal) => goal.state === "completed")).toBe(true);
    expect(goals.some((goal) => goal.state === "paused")).toBe(true);

    expect(summary).toContain("## Goal Progress Summary");
    expect(summary).toContain("### Active Goals");
    expect(summary).toContain("### Completed Goals");
    expect(summary).toContain("### Paused Goals");
    expect(summary).toContain("Launch New Feature (Q1 2026)");
  });

  it("resolves heartbeat config per environment after environment switch", async () => {
    const root = await createTempDirectory("reins-heartbeat-env-");
    const environmentsRoot = join(root, "environments");
    const configPath = join(root, "config", "reins.config.json5");

    await setupEnvironment(environmentsRoot, "default", {
      ...buildDocumentSet("Default"),
      HEARTBEAT: HEARTBEAT_TEMPLATE.replace("Check Every:** 30 minutes", "Check Every:** 30 minutes"),
    });
    await setupEnvironment(environmentsRoot, "work", {
      HEARTBEAT: HEARTBEAT_TEMPLATE.replace("Check Every:** 30 minutes", "Check Every:** 60 minutes"),
    });

    const service = new EnvironmentSwitchService(
      new ConfigStore(configPath),
      new FileEnvironmentResolver(environmentsRoot),
    );

    const defaultDocs = await service.getResolvedDocuments("default");
    expect(defaultDocs.ok).toBe(true);
    if (!defaultDocs.ok) {
      return;
    }

    expect(defaultDocs.value.documents.HEARTBEAT.document.content).toContain("Check Every:** 30 minutes");

    const switched = await service.switchEnvironment("work");
    expect(switched.ok).toBe(true);
    if (!switched.ok) {
      return;
    }

    const workDocs = await service.getResolvedDocuments();
    expect(workDocs.ok).toBe(true);
    if (!workDocs.ok) {
      return;
    }

    expect(workDocs.value.documents.HEARTBEAT.document.content).toContain("Check Every:** 60 minutes");
    expect(workDocs.value.documents.HEARTBEAT.document.content).not.toBe(
      defaultDocs.value.documents.HEARTBEAT.document.content,
    );
  });
});

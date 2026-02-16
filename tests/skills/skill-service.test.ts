import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillDaemonService } from "../../src/skills/skill-service";

const tempDirs: string[] = [];
const activeServices: SkillDaemonService[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reins-skill-service-"));
  tempDirs.push(dir);
  return dir;
}

async function createSkillDirectory(skillsDir: string, name: string, description?: string): Promise<void> {
  const skillDir = join(skillsDir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: ${description ?? `Description for ${name}`}
---

# ${name}

Body content for ${name}.
`,
  );
}

function trackService(service: SkillDaemonService): SkillDaemonService {
  activeServices.push(service);
  return service;
}

afterEach(async () => {
  for (const service of activeServices) {
    await service.stop();
  }
  activeServices.length = 0;
});

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("SkillDaemonService", () => {
  it("scans skills on start and starts watcher", async () => {
    const skillsDir = await createTempDir();
    await createSkillDirectory(skillsDir, "startup-skill");

    const service = trackService(new SkillDaemonService({
      skillsDir,
      watcherOptions: { debounceMs: 50 },
    }));

    const startResult = await service.start();

    expect(startResult.ok).toBe(true);
    expect(service.getState()).toBe("running");
    expect(service.getWatcher()?.watching).toBe(true);
    expect(service.getRegistry()?.has("startup-skill")).toBe(true);

    const report = service.getLastDiscoveryReport();
    expect(report?.discovered).toBe(1);
    expect(report?.loaded).toBe(1);
  });

  it("stop() stops watcher and clears registry", async () => {
    const skillsDir = await createTempDir();
    await createSkillDirectory(skillsDir, "cleanup-skill");

    const service = trackService(new SkillDaemonService({
      skillsDir,
      watcherOptions: { debounceMs: 50 },
    }));

    const startResult = await service.start();
    expect(startResult.ok).toBe(true);

    const watcher = service.getWatcher();
    const registry = service.getRegistry();

    expect(watcher?.watching).toBe(true);
    expect(registry?.list()).toHaveLength(1);

    const stopResult = await service.stop();

    expect(stopResult.ok).toBe(true);
    expect(service.getState()).toBe("stopped");
    expect(watcher?.watching).toBe(false);
    expect(registry?.list()).toHaveLength(0);
  });

  it("ensures missing skills directory is created and start succeeds", async () => {
    const rootDir = await createTempDir();
    const skillsDir = join(rootDir, "skills");

    const service = trackService(new SkillDaemonService({
      skillsDir,
      watcherOptions: { debounceMs: 50 },
    }));

    const startResult = await service.start();

    expect(startResult.ok).toBe(true);
    expect(service.getState()).toBe("running");
    expect(service.getRegistry()?.list()).toHaveLength(0);
    expect(service.getWatcher()?.watching).toBe(true);
  });
});

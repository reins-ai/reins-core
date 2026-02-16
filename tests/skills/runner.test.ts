import { afterAll, describe, expect, it } from "bun:test";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SKILL_ERROR_CODES } from "../../src/skills/errors";
import {
  AutoDenyPermissionChecker,
  AutoGrantPermissionChecker,
} from "../../src/skills/permissions";
import { SkillRegistry } from "../../src/skills/registry";
import { ScriptRunner } from "../../src/skills/runner";
import type { Skill, SkillTrustLevel } from "../../src/skills/types";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reins-skill-runner-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createSkillWithScripts(
  scripts: Record<string, string>,
  trustLevel: SkillTrustLevel = "trusted",
): Promise<Skill> {
  const skillDir = await createTempDir();
  const scriptsDir = join(skillDir, "scripts");
  await mkdir(scriptsDir);

  const scriptFiles = Object.keys(scripts);
  for (const [name, content] of Object.entries(scripts)) {
    const scriptPath = join(scriptsDir, name);
    await writeFile(scriptPath, content, "utf8");
    await chmod(scriptPath, 0o755);
  }

  return {
    config: {
      name: "script-skill",
      enabled: true,
      trustLevel,
      path: skillDir,
    },
    summary: {
      name: "script-skill",
      description: "Skill used for script runner tests",
    },
    hasScripts: true,
    hasIntegration: false,
    scriptFiles,
    categories: [],
    triggers: [],
  };
}

function createRunner(
  skill: Skill,
  options?: ConstructorParameters<typeof ScriptRunner>[1],
): ScriptRunner {
  const registry = new SkillRegistry();
  registry.register(skill);
  return new ScriptRunner(registry, options);
}

describe("ScriptRunner", () => {
  it("executes a script and captures stdout", async () => {
    const skill = await createSkillWithScripts({
      "echo-test.sh": "#!/bin/bash\necho \"hello from script\"\n",
    });
    const runner = createRunner(skill);

    const result = await runner.execute("script-skill", "echo-test.sh");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stdout.trim()).toBe("hello from script");
    expect(result.value.stderr).toBe("");
    expect(result.value.exitCode).toBe(0);
    expect(result.value.timedOut).toBe(false);
  });

  it("captures stderr output", async () => {
    const skill = await createSkillWithScripts({
      "stderr-test.sh": "#!/bin/bash\necho \"error output\" >&2\n",
    });
    const runner = createRunner(skill);

    const result = await runner.execute("script-skill", "stderr-test.sh");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stdout).toBe("");
    expect(result.value.stderr.trim()).toBe("error output");
    expect(result.value.exitCode).toBe(0);
  });

  it("captures non-zero exit code", async () => {
    const skill = await createSkillWithScripts({
      "exit-code.sh": "#!/bin/bash\nexit 42\n",
    });
    const runner = createRunner(skill);

    const result = await runner.execute("script-skill", "exit-code.sh");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(42);
    expect(result.value.timedOut).toBe(false);
  });

  it("kills long-running scripts when timeout is reached", async () => {
    const skill = await createSkillWithScripts({
      "slow-script.sh": "#!/bin/bash\nsleep 2\n",
    });
    const registry = new SkillRegistry();
    registry.register(skill);
    const scopedRunner = new ScriptRunner(registry, { defaultTimeout: 100 });

    const result = await scopedRunner.execute("script-skill", "slow-script.sh");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timedOut).toBe(true);
    expect(result.value.durationMs).toBeGreaterThanOrEqual(100);
    expect(result.value.durationMs).toBeLessThan(2_000);
  });

  it("passes environment variables to script execution", async () => {
    const skill = await createSkillWithScripts({
      "env-test.sh": "#!/bin/bash\necho \"REINS_TEST=$REINS_TEST\"\n",
    });
    const runner = createRunner(skill);

    const result = await runner.execute("script-skill", "env-test.sh", {
      env: { REINS_TEST: "hello-env" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stdout.trim()).toBe("REINS_TEST=hello-env");
  });

  it("returns an error when skill is not found", async () => {
    const skill = await createSkillWithScripts({
      "echo-test.sh": "#!/bin/bash\necho \"hello\"\n",
    });
    const runner = createRunner(skill);

    const result = await runner.execute("missing-skill", "echo-test.sh");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Skill not found");
  });

  it("returns an error when script is not listed in skill", async () => {
    const skill = await createSkillWithScripts({
      "echo-test.sh": "#!/bin/bash\necho \"hello\"\n",
    });
    const runner = createRunner(skill);

    const result = await runner.execute("script-skill", "missing-script.sh");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Script \"missing-script.sh\" not found");
  });

  it("reports a reasonable duration for fast scripts", async () => {
    const skill = await createSkillWithScripts({
      "fast-script.sh": "#!/bin/bash\necho \"quick\"\n",
    });
    const runner = createRunner(skill);

    const result = await runner.execute("script-skill", "fast-script.sh");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.value.durationMs).toBeLessThan(5_000);
  });

  it("denies execution when permission checker denies", async () => {
    const markerPath = join(await createTempDir(), "denied-marker.txt");
    const skill = await createSkillWithScripts(
      {
        "guarded.sh": `#!/bin/bash\necho "blocked" > "${markerPath}"\n`,
      },
      "untrusted",
    );
    const runner = createRunner(skill, {
      permissionChecker: new AutoDenyPermissionChecker(),
    });

    const result = await runner.execute("script-skill", "guarded.sh");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(SKILL_ERROR_CODES.PERMISSION);
    expect(result.error.message).toContain("Permission denied");
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("executes when permission checker grants", async () => {
    const markerPath = join(await createTempDir(), "granted-marker.txt");
    const skill = await createSkillWithScripts(
      {
        "allowed.sh": `#!/bin/bash\necho "ran" > "${markerPath}"\n`,
      },
      "untrusted",
    );
    const runner = createRunner(skill, {
      permissionChecker: new AutoGrantPermissionChecker(),
    });

    const result = await runner.execute("script-skill", "allowed.sh");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(access(markerPath)).resolves.toBeNull();
  });

  it("auto-grants trusted skills through permission policy", async () => {
    const markerPath = join(await createTempDir(), "trusted-marker.txt");
    const skill = await createSkillWithScripts({
      "trusted.sh": `#!/bin/bash\necho "trusted" > "${markerPath}"\n`,
    });
    const runner = createRunner(skill, {
      permissionChecker: new AutoDenyPermissionChecker(),
    });

    const result = await runner.execute("script-skill", "trusted.sh");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(access(markerPath)).resolves.toBeNull();
  });

  it("denies by default when no permission checker is provided", async () => {
    const markerPath = join(await createTempDir(), "default-denied-marker.txt");
    const skill = await createSkillWithScripts(
      {
        "default-guarded.sh": `#!/bin/bash\necho "blocked" > "${markerPath}"\n`,
      },
      "untrusted",
    );
    const runner = createRunner(skill);

    const result = await runner.execute("script-skill", "default-guarded.sh");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(SKILL_ERROR_CODES.PERMISSION);
    await expect(access(markerPath)).rejects.toThrow();
  });
});

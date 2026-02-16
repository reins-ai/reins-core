import { describe, expect, it } from "bun:test";

import {
  AutoDenyPermissionChecker,
  AutoGrantPermissionChecker,
  SkillPermissionPolicy,
  type PermissionResult,
  type SkillPermissionChecker,
} from "../../src/skills/permissions";
import type { Skill, SkillTrustLevel } from "../../src/skills/types";

function createSkillFixture(name: string, trustLevel: SkillTrustLevel): Skill {
  return {
    config: {
      name,
      enabled: true,
      trustLevel,
      path: `/skills/${name}`,
    },
    summary: {
      name,
      description: `Fixture skill ${name}`,
    },
    hasScripts: true,
    hasIntegration: false,
    scriptFiles: ["run.sh", "build.sh"],
    categories: [],
    triggers: [],
  };
}

class TrackingPermissionChecker implements SkillPermissionChecker {
  public calls: Array<{ skillName: string; scriptName: string }> = [];
  private readonly response: PermissionResult;

  constructor(response: PermissionResult) {
    this.response = response;
  }

  async requestPermission(skill: Skill, scriptName: string): Promise<PermissionResult> {
    this.calls.push({ skillName: skill.config.name, scriptName });
    return this.response;
  }
}

class SequencePermissionChecker implements SkillPermissionChecker {
  public calls = 0;
  private readonly responses: PermissionResult[];

  constructor(responses: PermissionResult[]) {
    this.responses = responses;
  }

  async requestPermission(_skill: Skill, _scriptName: string): Promise<PermissionResult> {
    const response = this.responses[this.calls] ?? "denied";
    this.calls += 1;
    return response;
  }
}

describe("SkillPermissionPolicy", () => {
  it("returns granted for trusted skills", async () => {
    const skill = createSkillFixture("trusted-skill", "trusted");
    const checker = new TrackingPermissionChecker("denied");
    const policy = new SkillPermissionPolicy(checker);

    const result = await policy.checkPermission(skill, "run.sh");

    expect(result).toBe("granted");
    expect(checker.calls.length).toBe(0);
  });

  it("returns granted for verified skills", async () => {
    const skill = createSkillFixture("verified-skill", "verified");
    const checker = new TrackingPermissionChecker("denied");
    const policy = new SkillPermissionPolicy(checker);

    const result = await policy.checkPermission(skill, "run.sh");

    expect(result).toBe("granted");
    expect(checker.calls.length).toBe(0);
  });

  it("returns denied for untrusted skills with auto deny checker", async () => {
    const skill = createSkillFixture("untrusted-skill", "untrusted");
    const policy = new SkillPermissionPolicy(new AutoDenyPermissionChecker());

    const result = await policy.checkPermission(skill, "run.sh");

    expect(result).toBe("denied");
    expect(policy.hasSessionGrant("untrusted-skill", "run.sh")).toBe(false);
  });

  it("returns session_granted for untrusted skills with auto grant checker", async () => {
    const skill = createSkillFixture("untrusted-skill", "untrusted");
    const policy = new SkillPermissionPolicy(new AutoGrantPermissionChecker());

    const result = await policy.checkPermission(skill, "run.sh");

    expect(result).toBe("session_granted");
    expect(policy.hasSessionGrant("untrusted-skill", "run.sh")).toBe(true);
  });

  it("uses session cache to avoid re-prompting", async () => {
    const skill = createSkillFixture("cache-skill", "untrusted");
    const checker = new SequencePermissionChecker(["granted", "denied"]);
    const policy = new SkillPermissionPolicy(checker);

    const first = await policy.checkPermission(skill, "run.sh");
    const second = await policy.checkPermission(skill, "run.sh");

    expect(first).toBe("session_granted");
    expect(second).toBe("session_granted");
    expect(checker.calls).toBe(1);
  });

  it("clearSessionGrants resets the cache", async () => {
    const skill = createSkillFixture("clear-cache-skill", "untrusted");
    const checker = new SequencePermissionChecker(["granted", "granted"]);
    const policy = new SkillPermissionPolicy(checker);

    await policy.checkPermission(skill, "run.sh");
    expect(policy.hasSessionGrant("clear-cache-skill", "run.sh")).toBe(true);

    policy.clearSessionGrants();
    expect(policy.hasSessionGrant("clear-cache-skill", "run.sh")).toBe(false);

    const result = await policy.checkPermission(skill, "run.sh");
    expect(result).toBe("session_granted");
    expect(checker.calls).toBe(2);
  });

  it("hasSessionGrant reports cached and uncached scripts correctly", async () => {
    const skill = createSkillFixture("grant-check-skill", "untrusted");
    const policy = new SkillPermissionPolicy(new AutoGrantPermissionChecker());

    expect(policy.hasSessionGrant("grant-check-skill", "run.sh")).toBe(false);

    await policy.checkPermission(skill, "run.sh");

    expect(policy.hasSessionGrant("grant-check-skill", "run.sh")).toBe(true);
    expect(policy.hasSessionGrant("grant-check-skill", "build.sh")).toBe(false);
  });

  it("calls custom checker for untrusted skills", async () => {
    const skill = createSkillFixture("custom-checker-skill", "untrusted");
    const checker = new TrackingPermissionChecker("denied");
    const policy = new SkillPermissionPolicy(checker);

    const result = await policy.checkPermission(skill, "run.sh");

    expect(result).toBe("denied");
    expect(checker.calls.length).toBe(1);
    expect(checker.calls[0]).toEqual({
      skillName: "custom-checker-skill",
      scriptName: "run.sh",
    });
  });

  it("caches different scripts independently for the same skill", async () => {
    const skill = createSkillFixture("multi-script-skill", "untrusted");
    const checker = new SequencePermissionChecker(["granted", "granted", "denied"]);
    const policy = new SkillPermissionPolicy(checker);

    const firstRun = await policy.checkPermission(skill, "run.sh");
    const firstBuild = await policy.checkPermission(skill, "build.sh");
    const secondRun = await policy.checkPermission(skill, "run.sh");

    expect(firstRun).toBe("session_granted");
    expect(firstBuild).toBe("session_granted");
    expect(secondRun).toBe("session_granted");
    expect(policy.hasSessionGrant("multi-script-skill", "run.sh")).toBe(true);
    expect(policy.hasSessionGrant("multi-script-skill", "build.sh")).toBe(true);
    expect(checker.calls).toBe(2);
  });

  it("uses auto deny checker by default", async () => {
    const skill = createSkillFixture("default-checker-skill", "untrusted");
    const policy = new SkillPermissionPolicy();

    const result = await policy.checkPermission(skill, "run.sh");

    expect(result).toBe("denied");
  });
});

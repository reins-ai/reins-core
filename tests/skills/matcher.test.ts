import { describe, expect, it } from "bun:test";

import { SkillMatcher } from "../../src/skills/matcher";
import type { SkillMatch } from "../../src/skills/matcher";
import type { Skill, SkillConfig, SkillTrustLevel } from "../../src/skills/types";

function createSkillFixture(
  name: string,
  description: string,
  triggers: string[],
  categories: string[],
  overrides?: Partial<SkillConfig>,
): Skill {
  return {
    config: {
      name,
      enabled: true,
      trustLevel: (overrides?.trustLevel ?? "untrusted") as SkillTrustLevel,
      path: `/skills/${name}`,
      ...overrides,
    },
    summary: { name, description },
    hasScripts: false,
    hasIntegration: false,
    scriptFiles: [],
    categories,
    triggers,
  };
}

const gitHelper = createSkillFixture(
  "git-helper",
  "Help with git operations and commands",
  ["git", "commit", "branch", "merge"],
  ["developer"],
);

const emailManager = createSkillFixture(
  "email-manager",
  "Manage and compose emails",
  ["email", "send email", "inbox", "compose"],
  ["productivity", "communication"],
);

const noteTaker = createSkillFixture(
  "note-taker",
  "Take and organize notes",
  ["notes", "take notes", "organize notes"],
  ["productivity"],
);

const dockerSkill = createSkillFixture(
  "docker-compose",
  "Manage Docker containers and compose files",
  ["docker", "container", "compose"],
  ["developer", "devops"],
);

const allSkills = [gitHelper, emailManager, noteTaker, dockerSkill];

describe("SkillMatcher", () => {
  describe("match", () => {
    it("returns exact name match with score 1.0", () => {
      const matcher = new SkillMatcher();
      const results = matcher.match("use git-helper", allSkills);

      expect(results.length).toBeGreaterThanOrEqual(1);
      const topMatch = results[0];
      expect(topMatch.skill).toBe(gitHelper);
      expect(topMatch.score).toBe(1.0);
      expect(topMatch.matchedOn).toContain("name");
    });

    it("matches trigger keywords in user query", () => {
      const matcher = new SkillMatcher();
      const results = matcher.match("help me with my email", allSkills);

      const emailMatch = results.find((r) => r.skill === emailManager);
      expect(emailMatch).toBeDefined();
      expect(emailMatch!.matchedOn).toContain("trigger");
    });

    it("matches multi-word trigger phrases", () => {
      const matcher = new SkillMatcher();
      const results = matcher.match("I want to send email to my boss", allSkills);

      const emailMatch = results.find((r) => r.skill === emailManager);
      expect(emailMatch).toBeDefined();
      expect(emailMatch!.matchedOn).toContain("trigger");
    });

    it("matches description word overlap", () => {
      const matcher = new SkillMatcher();
      const results = matcher.match("I need to organize my notes", allSkills);

      const noteMatch = results.find((r) => r.skill === noteTaker);
      expect(noteMatch).toBeDefined();
      expect(noteMatch!.matchedOn).toContain("description");
    });

    it("matches category names in query", () => {
      const matcher = new SkillMatcher();
      const results = matcher.match("show me productivity tools", allSkills);

      const productivityMatches = results.filter((r) =>
        r.matchedOn.includes("category"),
      );
      expect(productivityMatches.length).toBeGreaterThanOrEqual(1);

      const matchedNames = productivityMatches.map((r) => r.skill.config.name);
      expect(matchedNames).toContain("email-manager");
      expect(matchedNames).toContain("note-taker");
    });

    it("returns multiple matches ranked by score descending", () => {
      const matcher = new SkillMatcher();
      // "developer" is a category for both git-helper and docker-compose
      const results = matcher.match("developer tools for docker", allSkills);

      expect(results.length).toBeGreaterThanOrEqual(2);

      // docker-compose should rank higher (trigger "docker" + category "developer")
      const dockerMatch = results.find((r) => r.skill === dockerSkill);
      const gitMatch = results.find((r) => r.skill === gitHelper);
      expect(dockerMatch).toBeDefined();
      expect(gitMatch).toBeDefined();
      expect(dockerMatch!.score).toBeGreaterThan(gitMatch!.score);

      // Verify descending order
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it("returns empty array when no skills match", () => {
      const matcher = new SkillMatcher();
      const results = matcher.match("tell me a joke about cats", allSkills);

      expect(results).toEqual([]);
    });

    it("returns empty array for empty query", () => {
      const matcher = new SkillMatcher();
      const results = matcher.match("", allSkills);

      expect(results).toEqual([]);
    });

    it("returns empty array for whitespace-only query", () => {
      const matcher = new SkillMatcher();
      const results = matcher.match("   ", allSkills);

      expect(results).toEqual([]);
    });

    it("returns empty array when skills list is empty", () => {
      const matcher = new SkillMatcher();
      const results = matcher.match("help me with git", []);

      expect(results).toEqual([]);
    });

    it("caps score at 1.0 even with many matches", () => {
      const matcher = new SkillMatcher();
      // Query that matches name + triggers + description + category
      const results = matcher.match(
        "git-helper git commit branch merge operations commands developer",
        allSkills,
      );

      const gitMatch = results.find((r) => r.skill === gitHelper);
      expect(gitMatch).toBeDefined();
      expect(gitMatch!.score).toBe(1.0);
    });

    it("filters results below threshold", () => {
      const matcher = new SkillMatcher({ threshold: 0.5 });
      // "compose" matches docker-compose trigger but also email-manager trigger
      const results = matcher.match("compose", allSkills);

      // All results should be at or above 0.5
      for (const result of results) {
        expect(result.score).toBeGreaterThanOrEqual(0.5);
      }
    });

    it("uses configurable threshold", () => {
      const strictMatcher = new SkillMatcher({ threshold: 0.8 });
      const looseMatcher = new SkillMatcher({ threshold: 0.05 });

      const strictResults = strictMatcher.match("help me with email", allSkills);
      const looseResults = looseMatcher.match("help me with email", allSkills);

      expect(looseResults.length).toBeGreaterThanOrEqual(strictResults.length);
    });

    it("does not produce false matches from stop words", () => {
      const matcher = new SkillMatcher();
      // "and" and "the" are stop words — should not match description words
      const results = matcher.match("the and is to for with", allSkills);

      expect(results).toEqual([]);
    });

    it("is case-insensitive for name matching", () => {
      const matcher = new SkillMatcher();
      const results = matcher.match("use GIT-HELPER please", allSkills);

      const gitMatch = results.find((r) => r.skill === gitHelper);
      expect(gitMatch).toBeDefined();
      expect(gitMatch!.matchedOn).toContain("name");
    });

    it("is case-insensitive for trigger matching", () => {
      const matcher = new SkillMatcher();
      const results = matcher.match("DOCKER container help", allSkills);

      const dockerMatch = results.find((r) => r.skill === dockerSkill);
      expect(dockerMatch).toBeDefined();
      expect(dockerMatch!.matchedOn).toContain("trigger");
    });

    it("uses word-boundary matching for single-word triggers", () => {
      const matcher = new SkillMatcher();
      // "gitter" contains "git" but should not match as a word boundary
      const results = matcher.match("I use gitter for chat", allSkills);

      const gitMatch = results.find((r) => r.skill === gitHelper);
      // git-helper should not match on trigger "git" inside "gitter"
      if (gitMatch) {
        expect(gitMatch.matchedOn).not.toContain("trigger");
      }
    });

    it("handles skills with no triggers gracefully", () => {
      const matcher = new SkillMatcher();
      const noTriggerSkill = createSkillFixture(
        "bare-skill",
        "A skill with no triggers",
        [],
        [],
      );

      const results = matcher.match("bare-skill", [noTriggerSkill]);

      expect(results.length).toBe(1);
      expect(results[0].matchedOn).toContain("name");
      expect(results[0].matchedOn).not.toContain("trigger");
    });

    it("handles skills with no categories gracefully", () => {
      const matcher = new SkillMatcher();
      const noCategorySkill = createSkillFixture(
        "lonely-skill",
        "A skill with no categories",
        ["lonely"],
        [],
      );

      const results = matcher.match("lonely", [noCategorySkill]);

      expect(results.length).toBe(1);
      expect(results[0].matchedOn).not.toContain("category");
    });

    it("accumulates scores from multiple match sources", () => {
      const matcher = new SkillMatcher();
      // "notes" matches trigger, "organize" matches description, "productivity" matches category
      const results = matcher.match("organize notes productivity", allSkills);

      const noteMatch = results.find((r) => r.skill === noteTaker);
      expect(noteMatch).toBeDefined();
      expect(noteMatch!.matchedOn.length).toBeGreaterThanOrEqual(2);
    });

    it("matchedOn contains each source at most once", () => {
      const matcher = new SkillMatcher();
      // Multiple triggers match but "trigger" should appear only once
      const results = matcher.match("docker container compose", allSkills);

      const dockerMatch = results.find((r) => r.skill === dockerSkill);
      expect(dockerMatch).toBeDefined();

      const triggerCount = dockerMatch!.matchedOn.filter((s) => s === "trigger").length;
      expect(triggerCount).toBe(1);
    });
  });

  describe("matchExact", () => {
    it("finds skill by exact name", () => {
      const matcher = new SkillMatcher();
      const result = matcher.matchExact("git-helper", allSkills);

      expect(result).toBe(gitHelper);
    });

    it("is case-insensitive", () => {
      const matcher = new SkillMatcher();
      const result = matcher.matchExact("GIT-HELPER", allSkills);

      expect(result).toBe(gitHelper);
    });

    it("trims whitespace", () => {
      const matcher = new SkillMatcher();
      const result = matcher.matchExact("  git-helper  ", allSkills);

      expect(result).toBe(gitHelper);
    });

    it("returns undefined for unknown name", () => {
      const matcher = new SkillMatcher();
      const result = matcher.matchExact("nonexistent", allSkills);

      expect(result).toBeUndefined();
    });

    it("returns undefined for empty name", () => {
      const matcher = new SkillMatcher();
      const result = matcher.matchExact("", allSkills);

      expect(result).toBeUndefined();
    });

    it("returns undefined for empty skills list", () => {
      const matcher = new SkillMatcher();
      const result = matcher.matchExact("git-helper", []);

      expect(result).toBeUndefined();
    });

    it("ignores threshold setting", () => {
      const matcher = new SkillMatcher({ threshold: 1.0 });
      const result = matcher.matchExact("git-helper", allSkills);

      expect(result).toBe(gitHelper);
    });
  });

  describe("scoring determinism", () => {
    it("produces identical scores for identical inputs", () => {
      const matcher = new SkillMatcher();
      const results1 = matcher.match("help me with git", allSkills);
      const results2 = matcher.match("help me with git", allSkills);

      expect(results1.length).toBe(results2.length);
      for (let i = 0; i < results1.length; i++) {
        expect(results1[i].skill).toBe(results2[i].skill);
        expect(results1[i].score).toBe(results2[i].score);
      }
    });

    it("ranks name match above trigger match", () => {
      const matcher = new SkillMatcher();
      // "email-manager" is a name match; "email" is a trigger for email-manager
      // Create a skill where "email" is only a trigger, not a name
      const emailTriggerOnly = createSkillFixture(
        "mail-handler",
        "Handle mail",
        ["email"],
        [],
      );

      const results = matcher.match("email-manager", [emailManager, emailTriggerOnly]);

      expect(results[0].skill).toBe(emailManager);
      expect(results[0].matchedOn).toContain("name");
    });
  });
});

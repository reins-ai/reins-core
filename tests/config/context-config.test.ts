import { describe, expect, it } from "bun:test";

import {
  DEFAULT_AUTO_COMPACT_THRESHOLD,
  DEFAULT_KEEP_RECENT_MESSAGES,
  DEFAULT_REINS_GLOBAL_CONFIG,
  DEFAULT_SUMMARY_MAX_TOKENS,
  MAX_AUTO_COMPACT_THRESHOLD,
  MAX_SUMMARY_MAX_TOKENS,
  MIN_AUTO_COMPACT_THRESHOLD,
  MIN_KEEP_RECENT_MESSAGES,
  MIN_SUMMARY_MAX_TOKENS,
  validateConfigDraft,
} from "../../src/config/format-decision";

function makeValidConfig(contextOverrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_REINS_GLOBAL_CONFIG,
    context: {
      autoCompact: true,
      autoCompactThreshold: 0.9,
      keepRecentMessages: 20,
      summaryMaxTokens: 500,
      ...contextOverrides,
    },
  };
}

describe("ContextConfig validation", () => {
  it("accepts valid context config values without issues", () => {
    const result = validateConfigDraft(makeValidConfig());

    expect(result.isValid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.config.context.autoCompact).toBe(true);
    expect(result.config.context.autoCompactThreshold).toBe(0.9);
    expect(result.config.context.keepRecentMessages).toBe(20);
    expect(result.config.context.summaryMaxTokens).toBe(500);
  });

  it("accepts boundary values at minimum thresholds", () => {
    const result = validateConfigDraft(
      makeValidConfig({
        autoCompactThreshold: MIN_AUTO_COMPACT_THRESHOLD,
        keepRecentMessages: MIN_KEEP_RECENT_MESSAGES,
        summaryMaxTokens: MIN_SUMMARY_MAX_TOKENS,
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.config.context.autoCompactThreshold).toBe(MIN_AUTO_COMPACT_THRESHOLD);
    expect(result.config.context.keepRecentMessages).toBe(MIN_KEEP_RECENT_MESSAGES);
    expect(result.config.context.summaryMaxTokens).toBe(MIN_SUMMARY_MAX_TOKENS);
  });

  it("accepts boundary values at maximum thresholds", () => {
    const result = validateConfigDraft(
      makeValidConfig({
        autoCompactThreshold: MAX_AUTO_COMPACT_THRESHOLD,
        summaryMaxTokens: MAX_SUMMARY_MAX_TOKENS,
      }),
    );

    expect(result.isValid).toBe(true);
    expect(result.config.context.autoCompactThreshold).toBe(MAX_AUTO_COMPACT_THRESHOLD);
    expect(result.config.context.summaryMaxTokens).toBe(MAX_SUMMARY_MAX_TOKENS);
  });

  describe("autoCompactThreshold", () => {
    it("rejects threshold below minimum (< 0.5)", () => {
      const result = validateConfigDraft(
        makeValidConfig({ autoCompactThreshold: 0.3 }),
      );

      expect(result.isValid).toBe(false);
      const issue = result.issues.find((i) => i.path === "context.autoCompactThreshold");
      expect(issue).toBeDefined();
      expect(issue!.message).toContain("0.5");
      expect(issue!.message).toContain("0.99");
      expect(result.config.context.autoCompactThreshold).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD);
    });

    it("rejects threshold above maximum (> 0.99)", () => {
      const result = validateConfigDraft(
        makeValidConfig({ autoCompactThreshold: 1.0 }),
      );

      expect(result.isValid).toBe(false);
      const issue = result.issues.find((i) => i.path === "context.autoCompactThreshold");
      expect(issue).toBeDefined();
      expect(result.config.context.autoCompactThreshold).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD);
    });

    it("rejects non-number threshold", () => {
      const result = validateConfigDraft(
        makeValidConfig({ autoCompactThreshold: "high" }),
      );

      expect(result.isValid).toBe(false);
      expect(result.issues.some((i) => i.path === "context.autoCompactThreshold")).toBe(true);
      expect(result.config.context.autoCompactThreshold).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD);
    });

    it("rejects NaN threshold", () => {
      const result = validateConfigDraft(
        makeValidConfig({ autoCompactThreshold: Number.NaN }),
      );

      expect(result.isValid).toBe(false);
      expect(result.issues.some((i) => i.path === "context.autoCompactThreshold")).toBe(true);
    });
  });

  describe("keepRecentMessages", () => {
    it("rejects keepRecentMessages less than 1", () => {
      const result = validateConfigDraft(
        makeValidConfig({ keepRecentMessages: 0 }),
      );

      expect(result.isValid).toBe(false);
      const issue = result.issues.find((i) => i.path === "context.keepRecentMessages");
      expect(issue).toBeDefined();
      expect(result.config.context.keepRecentMessages).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
    });

    it("rejects negative keepRecentMessages", () => {
      const result = validateConfigDraft(
        makeValidConfig({ keepRecentMessages: -5 }),
      );

      expect(result.isValid).toBe(false);
      expect(result.issues.some((i) => i.path === "context.keepRecentMessages")).toBe(true);
      expect(result.config.context.keepRecentMessages).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
    });

    it("rejects non-integer keepRecentMessages", () => {
      const result = validateConfigDraft(
        makeValidConfig({ keepRecentMessages: 5.5 }),
      );

      expect(result.isValid).toBe(false);
      expect(result.issues.some((i) => i.path === "context.keepRecentMessages")).toBe(true);
      expect(result.config.context.keepRecentMessages).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
    });

    it("accepts large keepRecentMessages values", () => {
      const result = validateConfigDraft(
        makeValidConfig({ keepRecentMessages: 1000 }),
      );

      expect(result.isValid).toBe(true);
      expect(result.config.context.keepRecentMessages).toBe(1000);
    });
  });

  describe("summaryMaxTokens", () => {
    it("rejects summaryMaxTokens below minimum (< 100)", () => {
      const result = validateConfigDraft(
        makeValidConfig({ summaryMaxTokens: 50 }),
      );

      expect(result.isValid).toBe(false);
      const issue = result.issues.find((i) => i.path === "context.summaryMaxTokens");
      expect(issue).toBeDefined();
      expect(issue!.message).toContain("100");
      expect(issue!.message).toContain("2000");
      expect(result.config.context.summaryMaxTokens).toBe(DEFAULT_SUMMARY_MAX_TOKENS);
    });

    it("rejects summaryMaxTokens above maximum (> 2000)", () => {
      const result = validateConfigDraft(
        makeValidConfig({ summaryMaxTokens: 3000 }),
      );

      expect(result.isValid).toBe(false);
      const issue = result.issues.find((i) => i.path === "context.summaryMaxTokens");
      expect(issue).toBeDefined();
      expect(result.config.context.summaryMaxTokens).toBe(DEFAULT_SUMMARY_MAX_TOKENS);
    });

    it("rejects non-integer summaryMaxTokens", () => {
      const result = validateConfigDraft(
        makeValidConfig({ summaryMaxTokens: 500.5 }),
      );

      expect(result.isValid).toBe(false);
      expect(result.issues.some((i) => i.path === "context.summaryMaxTokens")).toBe(true);
      expect(result.config.context.summaryMaxTokens).toBe(DEFAULT_SUMMARY_MAX_TOKENS);
    });
  });

  describe("autoCompact", () => {
    it("accepts boolean true", () => {
      const result = validateConfigDraft(makeValidConfig({ autoCompact: true }));

      expect(result.isValid).toBe(true);
      expect(result.config.context.autoCompact).toBe(true);
    });

    it("accepts boolean false", () => {
      const result = validateConfigDraft(makeValidConfig({ autoCompact: false }));

      expect(result.isValid).toBe(true);
      expect(result.config.context.autoCompact).toBe(false);
    });

    it("rejects non-boolean autoCompact", () => {
      const result = validateConfigDraft(
        makeValidConfig({ autoCompact: "yes" }),
      );

      expect(result.isValid).toBe(false);
      const issue = result.issues.find((i) => i.path === "context.autoCompact");
      expect(issue).toBeDefined();
      expect(issue!.message).toContain("boolean");
    });
  });

  describe("defaults", () => {
    it("applies all defaults when context section is missing", () => {
      const input = { ...DEFAULT_REINS_GLOBAL_CONFIG };
      delete (input as Record<string, unknown>).context;

      const result = validateConfigDraft(input);

      expect(result.config.context).toEqual(DEFAULT_REINS_GLOBAL_CONFIG.context);
      expect(result.config.context.autoCompact).toBe(false);
      expect(result.config.context.autoCompactThreshold).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD);
      expect(result.config.context.keepRecentMessages).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
      expect(result.config.context.summaryMaxTokens).toBe(DEFAULT_SUMMARY_MAX_TOKENS);
    });

    it("applies defaults for missing fields in partial context config", () => {
      const result = validateConfigDraft({
        ...DEFAULT_REINS_GLOBAL_CONFIG,
        context: {
          autoCompact: true,
        },
      });

      expect(result.config.context.autoCompact).toBe(true);
      expect(result.config.context.autoCompactThreshold).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD);
      expect(result.config.context.keepRecentMessages).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
      expect(result.config.context.summaryMaxTokens).toBe(DEFAULT_SUMMARY_MAX_TOKENS);
    });

    it("applies defaults when context is an empty object", () => {
      const result = validateConfigDraft({
        ...DEFAULT_REINS_GLOBAL_CONFIG,
        context: {},
      });

      expect(result.config.context).toEqual(DEFAULT_REINS_GLOBAL_CONFIG.context);
    });

    it("applies defaults when input is completely empty", () => {
      const result = validateConfigDraft({});

      expect(result.config.context).toEqual(DEFAULT_REINS_GLOBAL_CONFIG.context);
    });
  });

  describe("multiple validation issues", () => {
    it("reports all invalid context fields at once", () => {
      const result = validateConfigDraft(
        makeValidConfig({
          autoCompact: "yes",
          autoCompactThreshold: 0.1,
          keepRecentMessages: 0,
          summaryMaxTokens: 50,
        }),
      );

      expect(result.isValid).toBe(false);
      const contextIssues = result.issues.filter((i) => i.path.startsWith("context."));
      expect(contextIssues.length).toBe(4);
    });

    it("falls back to defaults for all invalid fields", () => {
      const result = validateConfigDraft(
        makeValidConfig({
          autoCompact: 42,
          autoCompactThreshold: -1,
          keepRecentMessages: -10,
          summaryMaxTokens: 99999,
        }),
      );

      expect(result.config.context.autoCompact).toBe(DEFAULT_REINS_GLOBAL_CONFIG.context.autoCompact);
      expect(result.config.context.autoCompactThreshold).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD);
      expect(result.config.context.keepRecentMessages).toBe(DEFAULT_KEEP_RECENT_MESSAGES);
      expect(result.config.context.summaryMaxTokens).toBe(DEFAULT_SUMMARY_MAX_TOKENS);
    });
  });
});

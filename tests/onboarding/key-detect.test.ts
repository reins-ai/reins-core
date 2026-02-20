import { describe, expect, it } from "bun:test";

import { detectProviderFromKey } from "../../src/onboarding/key-detect";

describe("detectProviderFromKey", () => {
  describe("Anthropic keys (sk-ant-*)", () => {
    it("detects sk-ant- prefix as anthropic", () => {
      expect(detectProviderFromKey("sk-ant-abc123def456")).toBe("anthropic");
    });

    it("detects sk-ant- with minimal suffix", () => {
      expect(detectProviderFromKey("sk-ant-x")).toBe("anthropic");
    });

    it("detects sk-ant- with long key", () => {
      expect(detectProviderFromKey("sk-ant-api03-" + "a".repeat(80))).toBe("anthropic");
    });
  });

  describe("OpenAI keys (sk-proj-*)", () => {
    it("detects sk-proj- prefix as openai", () => {
      expect(detectProviderFromKey("sk-proj-abc123def456")).toBe("openai");
    });

    it("detects sk-proj- with minimal suffix", () => {
      expect(detectProviderFromKey("sk-proj-x")).toBe("openai");
    });

    it("prioritizes sk-proj- over generic sk-", () => {
      const result = detectProviderFromKey("sk-proj-test123");
      expect(result).toBe("openai");
    });
  });

  describe("OpenAI keys (generic sk-*)", () => {
    it("detects generic sk- prefix as openai", () => {
      expect(detectProviderFromKey("sk-abc123def456")).toBe("openai");
    });

    it("detects sk- with minimal suffix", () => {
      expect(detectProviderFromKey("sk-x")).toBe("openai");
    });

    it("detects sk- with long key", () => {
      expect(detectProviderFromKey("sk-" + "b".repeat(48))).toBe("openai");
    });
  });

  describe("Google keys (AIza*)", () => {
    it("detects AIza prefix as google", () => {
      expect(detectProviderFromKey("AIzaSyAbc123def456")).toBe("google");
    });

    it("detects AIza with minimal suffix", () => {
      expect(detectProviderFromKey("AIzaX")).toBe("google");
    });

    it("detects AIza with typical Google API key format", () => {
      expect(detectProviderFromKey("AIzaSyB-dGH_abc123_XYZ")).toBe("google");
    });
  });

  describe("Fireworks keys (fw-*)", () => {
    it("detects fw- prefix as fireworks", () => {
      expect(detectProviderFromKey("fw-abc123def456")).toBe("fireworks");
    });

    it("detects fw- with minimal suffix", () => {
      expect(detectProviderFromKey("fw-x")).toBe("fireworks");
    });
  });

  describe("prefix priority (longest-prefix-first)", () => {
    it("matches sk-ant- before sk-", () => {
      expect(detectProviderFromKey("sk-ant-test")).toBe("anthropic");
    });

    it("matches sk-proj- before sk-", () => {
      expect(detectProviderFromKey("sk-proj-test")).toBe("openai");
    });

    it("falls through to sk- when no longer prefix matches", () => {
      expect(detectProviderFromKey("sk-other-test")).toBe("openai");
    });
  });

  describe("unrecognized prefixes", () => {
    it("returns null for unknown prefix", () => {
      expect(detectProviderFromKey("unknown-key-abc123")).toBeNull();
    });

    it("returns null for random string", () => {
      expect(detectProviderFromKey("abc123def456")).toBeNull();
    });

    it("returns null for partial prefix match (AI without za)", () => {
      expect(detectProviderFromKey("AIbc123")).toBeNull();
    });

    it("returns null for case-mismatched prefix", () => {
      expect(detectProviderFromKey("SK-ant-abc123")).toBeNull();
    });

    it("returns null for reversed prefix", () => {
      expect(detectProviderFromKey("ant-sk-abc123")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for empty string", () => {
      expect(detectProviderFromKey("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(detectProviderFromKey("   ")).toBeNull();
    });

    it("returns null for tab and newline whitespace", () => {
      expect(detectProviderFromKey("\t\n")).toBeNull();
    });

    it("trims leading whitespace before matching", () => {
      expect(detectProviderFromKey("  sk-ant-abc123")).toBe("anthropic");
    });

    it("trims trailing whitespace before matching", () => {
      expect(detectProviderFromKey("sk-ant-abc123  ")).toBe("anthropic");
    });

    it("trims both leading and trailing whitespace", () => {
      expect(detectProviderFromKey("  fw-abc123  ")).toBe("fireworks");
    });

    it("handles prefix-only input (sk-ant-)", () => {
      expect(detectProviderFromKey("sk-ant-")).toBe("anthropic");
    });

    it("handles prefix-only input (sk-)", () => {
      expect(detectProviderFromKey("sk-")).toBe("openai");
    });

    it("handles prefix-only input (AIza)", () => {
      expect(detectProviderFromKey("AIza")).toBe("google");
    });

    it("handles prefix-only input (fw-)", () => {
      expect(detectProviderFromKey("fw-")).toBe("fireworks");
    });
  });
});

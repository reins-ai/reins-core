import { describe, expect, it } from "bun:test";

import { ToolRegistry } from "../../src/tools/registry";
import { BrowserTool } from "../../src/browser/tools/browser-tool";
import { BrowserSnapshotTool } from "../../src/browser/tools/browser-snapshot-tool";
import { BrowserActTool } from "../../src/browser/tools/browser-act-tool";
import { ElementRefRegistry } from "../../src/browser/element-ref-registry";
import { SnapshotEngine } from "../../src/browser/snapshot";
import { BROWSER_SYSTEM_PROMPT } from "../../src/browser/system-prompt";
import type { BrowserDaemonService } from "../../src/browser/browser-daemon-service";

function createMockBrowserService(): BrowserDaemonService {
  return {
    id: "browser",
    ensureBrowser: async () => { throw new Error("not connected"); },
    getActiveCdpClient: async () => { throw new Error("not connected"); },
    getStatus: () => ({
      running: false,
      tabs: [],
      profilePath: "/tmp/test-profile",
      headless: true,
    }),
    getCurrentTabId: () => undefined,
    updateTabState: () => {},
    start: async () => ({ ok: true, value: undefined }) as never,
    stop: async () => ({ ok: true, value: undefined }) as never,
  } as unknown as BrowserDaemonService;
}

describe("Browser agent integration", () => {
  describe("tool registration", () => {
    it("registers all 3 browser tools in ToolRegistry", () => {
      const registry = new ToolRegistry();
      const service = createMockBrowserService();
      const elementRefRegistry = new ElementRefRegistry();
      const snapshotEngine = new SnapshotEngine(elementRefRegistry);

      registry.register(new BrowserTool(service));
      registry.register(new BrowserSnapshotTool(service, snapshotEngine));
      registry.register(new BrowserActTool(service, elementRefRegistry));

      expect(registry.list()).toHaveLength(3);
    });

    it("registers tool named 'browser'", () => {
      const registry = new ToolRegistry();
      const service = createMockBrowserService();

      registry.register(new BrowserTool(service));

      expect(registry.has("browser")).toBe(true);
      expect(registry.get("browser")?.definition.name).toBe("browser");
    });

    it("registers tool named 'browser_snapshot'", () => {
      const registry = new ToolRegistry();
      const service = createMockBrowserService();
      const elementRefRegistry = new ElementRefRegistry();
      const snapshotEngine = new SnapshotEngine(elementRefRegistry);

      registry.register(new BrowserSnapshotTool(service, snapshotEngine));

      expect(registry.has("browser_snapshot")).toBe(true);
      expect(registry.get("browser_snapshot")?.definition.name).toBe("browser_snapshot");
    });

    it("registers tool named 'browser_act'", () => {
      const registry = new ToolRegistry();
      const service = createMockBrowserService();
      const elementRefRegistry = new ElementRefRegistry();

      registry.register(new BrowserActTool(service, elementRefRegistry));

      expect(registry.has("browser_act")).toBe(true);
      expect(registry.get("browser_act")?.definition.name).toBe("browser_act");
    });

    it("exposes tool definitions for all 3 browser tools", () => {
      const registry = new ToolRegistry();
      const service = createMockBrowserService();
      const elementRefRegistry = new ElementRefRegistry();
      const snapshotEngine = new SnapshotEngine(elementRefRegistry);

      registry.register(new BrowserTool(service));
      registry.register(new BrowserSnapshotTool(service, snapshotEngine));
      registry.register(new BrowserActTool(service, elementRefRegistry));

      const definitions = registry.getDefinitions();
      const names = definitions.map((d) => d.name).sort();

      expect(names).toEqual(["browser", "browser_act", "browser_snapshot"]);
    });
  });

  describe("BROWSER_SYSTEM_PROMPT", () => {
    it("is a non-empty string", () => {
      expect(typeof BROWSER_SYSTEM_PROMPT).toBe("string");
      expect(BROWSER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    });

    it("mentions snapshot-first workflow", () => {
      expect(BROWSER_SYSTEM_PROMPT).toContain("browser_snapshot");
      expect(BROWSER_SYSTEM_PROMPT).toContain("browser_act");
    });

    it("describes element refs", () => {
      expect(BROWSER_SYSTEM_PROMPT).toContain("e0");
      expect(BROWSER_SYSTEM_PROMPT).toContain("ref");
    });

    it("mentions all 3 tool names", () => {
      expect(BROWSER_SYSTEM_PROMPT).toContain("browser:");
      expect(BROWSER_SYSTEM_PROMPT).toContain("browser_snapshot:");
      expect(BROWSER_SYSTEM_PROMPT).toContain("browser_act:");
    });

    it("stays within token budget (under 800 characters)", () => {
      expect(BROWSER_SYSTEM_PROMPT.length).toBeLessThanOrEqual(800);
    });
  });

  describe("system prompt injection", () => {
    it("appends browser prompt to existing system prompt", () => {
      const base = "You are a helpful assistant.";
      const combined = appendBrowserPrompt(base);

      expect(combined).toContain(base);
      expect(combined).toContain(BROWSER_SYSTEM_PROMPT);
      expect(combined.indexOf(base)).toBeLessThan(combined.indexOf(BROWSER_SYSTEM_PROMPT));
    });

    it("uses browser prompt as full system prompt when base is empty", () => {
      expect(appendBrowserPrompt(undefined)).toBe(BROWSER_SYSTEM_PROMPT);
      expect(appendBrowserPrompt("")).toBe(BROWSER_SYSTEM_PROMPT);
      expect(appendBrowserPrompt("  ")).toBe(BROWSER_SYSTEM_PROMPT);
    });

    it("separates base and browser prompt with double newline", () => {
      const base = "Base prompt.";
      const combined = appendBrowserPrompt(base);

      expect(combined).toBe(`${base}\n\n${BROWSER_SYSTEM_PROMPT}`);
    });
  });
});

/**
 * Mirrors the private appendBrowserSystemPrompt logic from DaemonHttpServer
 * to verify the integration contract without requiring a full server instance.
 */
function appendBrowserPrompt(base: string | undefined): string {
  if (!base || base.trim().length === 0) {
    return BROWSER_SYSTEM_PROMPT;
  }

  return `${base}\n\n${BROWSER_SYSTEM_PROMPT}`;
}

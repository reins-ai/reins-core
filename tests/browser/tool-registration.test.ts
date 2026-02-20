import { describe, expect, it } from "bun:test";

import type { BrowserDaemonService } from "../../src/browser/browser-daemon-service";
import { DaemonHttpServer } from "../../src/daemon/server";
import type { ProviderAuthService } from "../../src/providers/auth-service";
import { ProviderRegistry } from "../../src/providers/registry";
import { ModelRouter } from "../../src/providers/router";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import type { ToolDefinition } from "../../src/types";

interface ServerInternals {
  initializeBrowserTools: () => void;
  toolExecutor: ToolExecutor;
  toolDefinitions: ToolDefinition[];
}

function createStubAuthService(): ProviderAuthService {
  return {
    listProviders: async () => [],
    getProviderAuthStatus: async () => ({
      providerId: "anthropic",
      available: false,
      authenticated: false,
      authMethod: "oauth",
      details: "",
      expiresAt: null,
    }),
    handleCommand: async () => ({
      type: "error",
      message: "unsupported in test",
    }),
  } as unknown as ProviderAuthService;
}

function createMockBrowserService(): BrowserDaemonService {
  return {
    id: "browser",
    ensureBrowser: async () => {
      throw new Error("not connected");
    },
    getActiveCdpClient: async () => {
      throw new Error("not connected");
    },
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

describe("initializeBrowserTools", () => {
  it("registers browser, browser_snapshot, browser_act, and browser_debug", () => {
    const toolExecutor = new ToolExecutor(new ToolRegistry());
    const server = new DaemonHttpServer({
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      browserService: createMockBrowserService(),
      toolExecutor,
    });

    const internals = server as unknown as ServerInternals;
    internals.initializeBrowserTools();

    const registry = internals.toolExecutor.getRegistry();
    expect(registry.has("browser")).toBe(true);
    expect(registry.has("browser_snapshot")).toBe(true);
    expect(registry.has("browser_act")).toBe(true);
    expect(registry.has("browser_debug")).toBe(true);

    const names = internals.toolDefinitions.map((definition) => definition.name).sort();
    expect(names).toEqual(["browser", "browser_act", "browser_debug", "browser_snapshot"]);
  });
});

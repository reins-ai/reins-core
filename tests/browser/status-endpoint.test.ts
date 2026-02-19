import { describe, expect, it } from "bun:test";

import { DaemonHttpServer } from "../../src/daemon/server";
import { BrowserDaemonService } from "../../src/browser/browser-daemon-service";
import type { BrowserStatus } from "../../src/browser/types";

/**
 * Minimal mock of BrowserDaemonService that overrides getStatus()
 * without launching Chrome or connecting to CDP.
 */
class MockBrowserDaemonService extends BrowserDaemonService {
  private mockStatus: BrowserStatus;

  constructor(status: BrowserStatus) {
    super({
      findBinaryFn: async () => "/usr/bin/google-chrome",
      cdpClientFactory: () => {
        throw new Error("MockBrowserDaemonService should not create CDP clients");
      },
    });
    this.mockStatus = status;
  }

  override getStatus(): BrowserStatus {
    return this.mockStatus;
  }

  setMockStatus(status: BrowserStatus): void {
    this.mockStatus = status;
  }
}

function createRunningStatus(overrides: Partial<BrowserStatus> = {}): BrowserStatus {
  return {
    running: true,
    chrome: {
      pid: 12345,
      port: 9222,
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser",
      startedAt: Date.now() - 60_000,
    },
    tabs: [
      { tabId: "tab-1", url: "https://example.com", title: "Example", active: true },
      { tabId: "tab-2", url: "about:blank", title: "New Tab", active: false },
    ],
    profilePath: "/home/user/.reins/browser/profiles/default",
    headless: true,
    memoryUsageMb: 128,
    ...overrides,
  };
}

function createStoppedStatus(overrides: Partial<BrowserStatus> = {}): BrowserStatus {
  return {
    running: false,
    tabs: [],
    profilePath: "/home/user/.reins/browser/profiles/default",
    headless: true,
    ...overrides,
  };
}

async function fetchBrowserStatus(port: number): Promise<Response> {
  return fetch(`http://localhost:${port}/api/browser/status`);
}

describe("/api/browser/status endpoint", () => {
  it("returns stopped status when browser service is not provided", async () => {
    const server = new DaemonHttpServer({ port: 0 });
    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    try {
      const address = (server as unknown as { server: { port: number } }).server;
      const port = address.port;
      const response = await fetchBrowserStatus(port);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");

      const body = await response.json();
      expect(body.status).toBe("stopped");
      expect(body.headless).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("returns stopped status when Chrome is not running", async () => {
    const mockService = new MockBrowserDaemonService(createStoppedStatus());
    const server = new DaemonHttpServer({
      port: 0,
      browserService: mockService,
    });
    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    try {
      const address = (server as unknown as { server: { port: number } }).server;
      const port = address.port;
      const response = await fetchBrowserStatus(port);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");

      const body = await response.json();
      expect(body.status).toBe("stopped");
      expect(body.headless).toBe(true);
      expect(body.pid).toBeUndefined();
      expect(body.tabCount).toBeUndefined();
      expect(body.memoryUsageMb).toBeUndefined();
      expect(body.profilePath).toBeUndefined();
      expect(body.uptimeMs).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it("returns running status with full details when Chrome is running", async () => {
    const startedAt = Date.now() - 120_000;
    const mockService = new MockBrowserDaemonService(
      createRunningStatus({
        chrome: {
          pid: 9876,
          port: 9222,
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser",
          startedAt,
        },
        tabs: [
          { tabId: "t1", url: "https://example.com", title: "Example", active: true },
        ],
        memoryUsageMb: 256,
        profilePath: "/custom/profile",
        headless: false,
      }),
    );

    const server = new DaemonHttpServer({
      port: 0,
      browserService: mockService,
    });
    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    try {
      const address = (server as unknown as { server: { port: number } }).server;
      const port = address.port;
      const response = await fetchBrowserStatus(port);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");

      const body = await response.json();
      expect(body.status).toBe("running");
      expect(body.pid).toBe(9876);
      expect(body.tabCount).toBe(1);
      expect(body.memoryUsageMb).toBe(256);
      expect(body.profilePath).toBe("/custom/profile");
      expect(body.headless).toBe(false);
      expect(typeof body.uptimeMs).toBe("number");
      expect(body.uptimeMs).toBeGreaterThanOrEqual(120_000);
    } finally {
      await server.stop();
    }
  });

  it("always returns HTTP 200 even when stopped", async () => {
    const mockService = new MockBrowserDaemonService(createStoppedStatus());
    const server = new DaemonHttpServer({
      port: 0,
      browserService: mockService,
    });
    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    try {
      const address = (server as unknown as { server: { port: number } }).server;
      const port = address.port;
      const response = await fetchBrowserStatus(port);

      expect(response.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("returns Content-Type application/json", async () => {
    const mockService = new MockBrowserDaemonService(createRunningStatus());
    const server = new DaemonHttpServer({
      port: 0,
      browserService: mockService,
    });
    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    try {
      const address = (server as unknown as { server: { port: number } }).server;
      const port = address.port;
      const response = await fetchBrowserStatus(port);

      const contentType = response.headers.get("content-type");
      expect(contentType).toContain("application/json");
    } finally {
      await server.stop();
    }
  });

  it("omits memoryUsageMb when not available", async () => {
    const mockService = new MockBrowserDaemonService(
      createRunningStatus({ memoryUsageMb: undefined }),
    );
    const server = new DaemonHttpServer({
      port: 0,
      browserService: mockService,
    });
    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    try {
      const address = (server as unknown as { server: { port: number } }).server;
      const port = address.port;
      const response = await fetchBrowserStatus(port);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("running");
      expect(body.memoryUsageMb).toBeUndefined();
      expect(body.pid).toBe(12345);
      expect(body.tabCount).toBe(2);
    } finally {
      await server.stop();
    }
  });

  it("returns tabCount of zero when running with no tabs", async () => {
    const mockService = new MockBrowserDaemonService(
      createRunningStatus({ tabs: [] }),
    );
    const server = new DaemonHttpServer({
      port: 0,
      browserService: mockService,
    });
    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    try {
      const address = (server as unknown as { server: { port: number } }).server;
      const port = address.port;
      const response = await fetchBrowserStatus(port);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("running");
      expect(body.tabCount).toBe(0);
    } finally {
      await server.stop();
    }
  });
});

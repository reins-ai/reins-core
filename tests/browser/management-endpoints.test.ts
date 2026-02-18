import { describe, expect, it } from "bun:test";

import { DaemonHttpServer } from "../../src/daemon/server";
import { BrowserDaemonService } from "../../src/browser/browser-daemon-service";
import type { BrowserStatus } from "../../src/browser/types";
import { ok, err } from "../../src/result";
import { DaemonError } from "../../src/daemon/types";

// ---------------------------------------------------------------------------
// Minimal mock of BrowserDaemonService — no Chrome, no CDP
// ---------------------------------------------------------------------------

class MockBrowserDaemonService extends BrowserDaemonService {
  private mockStatus: BrowserStatus;
  private stopResult: ReturnType<typeof ok<void>> | ReturnType<typeof err<DaemonError>>;
  private launchHeadedResult: ReturnType<typeof ok<void>> | ReturnType<typeof err<DaemonError>>;
  private screenshotResult:
    | ReturnType<typeof ok<{ path: string }>>
    | ReturnType<typeof err<DaemonError>>;

  constructor(
    status: BrowserStatus = stoppedStatus(),
    opts: {
      stopResult?: ReturnType<typeof ok<void>> | ReturnType<typeof err<DaemonError>>;
      launchHeadedResult?: ReturnType<typeof ok<void>> | ReturnType<typeof err<DaemonError>>;
      screenshotResult?:
        | ReturnType<typeof ok<{ path: string }>>
        | ReturnType<typeof err<DaemonError>>;
    } = {},
  ) {
    super({
      findBinaryFn: async () => "/usr/bin/google-chrome",
      cdpClientFactory: () => {
        throw new Error("MockBrowserDaemonService must not create CDP clients");
      },
    });
    this.mockStatus = status;
    this.stopResult = opts.stopResult ?? ok(undefined);
    this.launchHeadedResult = opts.launchHeadedResult ?? ok(undefined);
    this.screenshotResult = opts.screenshotResult ?? ok({ path: "/tmp/screenshot-123.jpg" });
  }

  override getStatus(): BrowserStatus {
    return this.mockStatus;
  }

  override async stop(): Promise<ReturnType<typeof ok<void>> | ReturnType<typeof err<DaemonError>>> {
    return this.stopResult;
  }

  override async launchHeaded(): Promise<ReturnType<typeof ok<void>> | ReturnType<typeof err<DaemonError>>> {
    return this.launchHeadedResult;
  }

  override async takeScreenshot(_quality?: number): Promise<
    ReturnType<typeof ok<{ path: string }>> | ReturnType<typeof err<DaemonError>>
  > {
    return this.screenshotResult;
  }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function stoppedStatus(overrides: Partial<BrowserStatus> = {}): BrowserStatus {
  return {
    running: false,
    tabs: [],
    profilePath: "/home/user/.reins/browser/profiles/default",
    headless: true,
    ...overrides,
  };
}

function runningStatus(overrides: Partial<BrowserStatus> = {}): BrowserStatus {
  return {
    running: true,
    chrome: {
      pid: 12345,
      port: 9222,
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser",
      startedAt: Date.now() - 60_000,
    },
    tabs: [{ tabId: "t1", url: "https://example.com", title: "Example", active: true }],
    profilePath: "/home/user/.reins/browser/profiles/default",
    headless: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared server setup helper
// ---------------------------------------------------------------------------

async function withServer(
  browserService: MockBrowserDaemonService | null,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const options = browserService ? { port: 0, browserService } : { port: 0 };
  const server = new DaemonHttpServer(options);
  const startResult = await server.start();
  expect(startResult.ok).toBe(true);
  try {
    const address = (server as unknown as { server: { port: number } }).server;
    await fn(address.port);
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// POST /api/browser/stop
// ---------------------------------------------------------------------------

describe("POST /api/browser/stop", () => {
  it("returns { stopped: true } when browser service is not provided", async () => {
    await withServer(null, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/stop`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stopped).toBe(true);
    });
  });

  it("returns { stopped: true } on successful stop", async () => {
    const svc = new MockBrowserDaemonService(runningStatus(), { stopResult: ok(undefined) });
    await withServer(svc, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/stop`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stopped).toBe(true);
    });
  });

  it("returns 500 and { stopped: false } when stop fails", async () => {
    const svc = new MockBrowserDaemonService(runningStatus(), {
      stopResult: err(new DaemonError("Chrome unresponsive", "BROWSER_DAEMON_STOP_FAILED")),
    });
    await withServer(svc, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/stop`, { method: "POST" });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.stopped).toBe(false);
      expect(typeof body.error).toBe("string");
    });
  });

  it("returns Content-Type application/json", async () => {
    const svc = new MockBrowserDaemonService();
    await withServer(svc, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/stop`, { method: "POST" });
      expect(res.headers.get("content-type")).toContain("application/json");
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/browser/launch-headed
// ---------------------------------------------------------------------------

describe("POST /api/browser/launch-headed", () => {
  it("returns 503 when browser service is not provided", async () => {
    await withServer(null, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/launch-headed`, {
        method: "POST",
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  it("returns { ok: true, message } on successful relaunch", async () => {
    const svc = new MockBrowserDaemonService(runningStatus(), {
      launchHeadedResult: ok(undefined),
    });
    await withServer(svc, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/launch-headed`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(typeof body.message).toBe("string");
    });
  });

  it("returns 500 and { ok: false } when launch fails", async () => {
    const svc = new MockBrowserDaemonService(runningStatus(), {
      launchHeadedResult: err(
        new DaemonError("Chrome binary not found", "BROWSER_LAUNCH_HEADED_FAILED"),
      ),
    });
    await withServer(svc, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/launch-headed`, {
        method: "POST",
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
    });
  });

  it("returns Content-Type application/json", async () => {
    const svc = new MockBrowserDaemonService();
    await withServer(svc, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/launch-headed`, {
        method: "POST",
      });
      expect(res.headers.get("content-type")).toContain("application/json");
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/browser/screenshot
// ---------------------------------------------------------------------------

describe("POST /api/browser/screenshot", () => {
  it("returns 503 when browser service is not provided", async () => {
    await withServer(null, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quality: 80 }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  it("returns { ok: true, path, message } on successful screenshot", async () => {
    const svc = new MockBrowserDaemonService(runningStatus(), {
      screenshotResult: ok({ path: "/home/user/.reins/browser/screenshots/screenshot-1.jpg" }),
    });
    await withServer(svc, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quality: 80 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(typeof body.path).toBe("string");
      expect(body.path).toContain("screenshot");
      expect(typeof body.message).toBe("string");
    });
  });

  it("returns 409 when browser is not running", async () => {
    const svc = new MockBrowserDaemonService(stoppedStatus(), {
      screenshotResult: err(new DaemonError("Browser is not running", "BROWSER_NOT_RUNNING")),
    });
    await withServer(svc, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quality: 80 }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  it("returns 500 when screenshot capture fails", async () => {
    const svc = new MockBrowserDaemonService(runningStatus(), {
      screenshotResult: err(new DaemonError("CDP timeout", "SCREENSHOT_FAILED")),
    });
    await withServer(svc, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quality: 80 }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
    });
  });

  it("uses default quality when body is empty", async () => {
    const svc = new MockBrowserDaemonService(runningStatus(), {
      screenshotResult: ok({ path: "/tmp/screenshot-default.jpg" }),
    });
    await withServer(svc, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/screenshot`, {
        method: "POST",
      });
      // Server must not error even with an empty/missing body
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  it("uses default quality when body is invalid JSON", async () => {
    const svc = new MockBrowserDaemonService(runningStatus(), {
      screenshotResult: ok({ path: "/tmp/screenshot-default.jpg" }),
    });
    await withServer(svc, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  it("returns Content-Type application/json", async () => {
    const svc = new MockBrowserDaemonService(runningStatus(), {
      screenshotResult: ok({ path: "/tmp/screenshot.jpg" }),
    });
    await withServer(svc, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/browser/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quality: 50 }),
      });
      expect(res.headers.get("content-type")).toContain("application/json");
    });
  });
});

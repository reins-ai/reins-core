import { describe, expect, it } from "bun:test";

import { BrowserNotRunningError } from "../../../src/browser/errors";
import type { BrowserDaemonService } from "../../../src/browser/browser-daemon-service";
import type { CdpMethod } from "../../../src/browser/types";
import { BrowserTool } from "../../../src/browser/tools/browser-tool";
import type { ToolContext } from "../../../src/types";

interface SendCall {
  method: CdpMethod;
  params?: Record<string, unknown>;
  sessionId?: string;
}

class MockCdpClient {
  public readonly calls: SendCall[] = [];
  private readonly responses = new Map<CdpMethod, unknown[]>();

  queueResponse(method: CdpMethod, value: unknown): void {
    const existing = this.responses.get(method) ?? [];
    existing.push(value);
    this.responses.set(method, existing);
  }

  async send<T = unknown>(
    method: CdpMethod,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    this.calls.push({ method, params, sessionId });

    const queued = this.responses.get(method);
    if (!queued || queued.length === 0) {
      throw new Error(`No queued response for ${method}`);
    }

    const next = queued.shift();
    if (next instanceof Error) {
      throw next;
    }

    return next as T;
  }
}

class MockBrowserDaemonService {
  public ensureBrowserCalls = 0;
  public updateTabStateCalls: Array<{ tabs: Array<{ tabId: string; active: boolean }>; activeTabId?: string }> = [];
  public shouldThrowOnEnsure = false;
  public currentTabId?: string;
  public status = {
    running: false,
    tabs: [],
    profilePath: "/tmp/profile",
    headless: true,
  };

  constructor(public readonly client: MockCdpClient) {}

  async ensureBrowser(): Promise<MockCdpClient> {
    this.ensureBrowserCalls += 1;
    if (this.shouldThrowOnEnsure) {
      throw new BrowserNotRunningError("Browser unavailable");
    }

    return this.client;
  }

  updateTabState(tabs: Array<{ tabId: string; active: boolean }>, activeTabId?: string): void {
    this.updateTabStateCalls.push({ tabs, activeTabId });
    this.currentTabId = activeTabId;
    this.status = {
      ...this.status,
      running: true,
      tabs,
      activeTabId,
    };
  }

  getCurrentTabId(): string | undefined {
    return this.currentTabId;
  }

  getStatus(): typeof this.status {
    return this.status;
  }
}

const context: ToolContext = {
  conversationId: "conv-1",
  userId: "user-1",
};

describe("BrowserTool", () => {
  it("exposes the browser tool definition", () => {
    const service = new MockBrowserDaemonService(new MockCdpClient());
    const tool = new BrowserTool(service as unknown as BrowserDaemonService);

    expect(tool.definition.name).toBe("browser");
  });

  it("navigate calls page commands with session id and returns metadata", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.getTargets", {
      targetInfos: [{ targetId: "tab-1", type: "page", title: "", url: "about:blank", attached: true }],
    });
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });
    client.queueResponse("Page.enable", {});
    client.queueResponse("Page.navigate", { frameId: "frame-1" });
    client.queueResponse("Runtime.evaluate", { result: { type: "string", value: "complete" } });
    client.queueResponse("Runtime.evaluate", {
      result: {
        type: "object",
        value: { url: "https://example.com", title: "Example" },
      },
    });
    client.queueResponse("Target.getTargets", {
      targetInfos: [
        { targetId: "tab-1", type: "page", title: "Example", url: "https://example.com", attached: true },
      ],
    });

    const service = new MockBrowserDaemonService(client);
    const tool = new BrowserTool(service as unknown as BrowserDaemonService);

    const result = await tool.execute(
      { callId: "call-1", action: "navigate", url: "https://example.com" },
      context,
    );

    expect(result.callId).toBe("call-1");
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      action: "navigate",
      tabId: "tab-1",
      url: "https://example.com",
      title: "Example",
    });

    const navigateCall = client.calls.find((call) => call.method === "Page.navigate");
    expect(navigateCall?.sessionId).toBe("session-1");
    expect(service.updateTabStateCalls).toHaveLength(1);
    expect(service.updateTabStateCalls[0]?.activeTabId).toBe("tab-1");
  });

  it("new_tab creates and tracks a new tab", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.createTarget", { targetId: "tab-2" });
    client.queueResponse("Target.getTargets", {
      targetInfos: [
        { targetId: "tab-1", type: "page", title: "A", url: "about:blank", attached: true },
        { targetId: "tab-2", type: "page", title: "B", url: "https://example.com", attached: true },
      ],
    });

    const service = new MockBrowserDaemonService(client);
    const tool = new BrowserTool(service as unknown as BrowserDaemonService);

    const result = await tool.execute({ action: "new_tab", url: "https://example.com" }, context);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      action: "new_tab",
      tabId: "tab-2",
      url: "https://example.com",
    });

    expect(service.updateTabStateCalls[0]?.activeTabId).toBe("tab-2");
  });

  it("close_tab closes target and refreshes tab state", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.closeTarget", { success: true });
    client.queueResponse("Target.getTargets", {
      targetInfos: [{ targetId: "tab-1", type: "page", title: "A", url: "about:blank", attached: true }],
    });

    const service = new MockBrowserDaemonService(client);
    service.currentTabId = "tab-2";
    const tool = new BrowserTool(service as unknown as BrowserDaemonService);

    const result = await tool.execute({ action: "close_tab", tabId: "tab-2" }, context);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      action: "close_tab",
      tabId: "tab-2",
      activeTabId: "tab-1",
    });
    expect(client.calls[0]).toMatchObject({
      method: "Target.closeTarget",
      params: { targetId: "tab-2" },
    });
  });

  it("list_tabs returns page targets and updates state", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.getTargets", {
      targetInfos: [
        { targetId: "tab-1", type: "page", title: "A", url: "https://a.test", attached: true },
        { targetId: "tab-2", type: "service_worker", title: "ignore", url: "", attached: false },
      ],
    });

    const service = new MockBrowserDaemonService(client);
    const tool = new BrowserTool(service as unknown as BrowserDaemonService);

    const result = await tool.execute({ action: "list_tabs", callId: "call-2" }, context);

    expect(result.callId).toBe("call-2");
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      action: "list_tabs",
      tabs: [{ tabId: "tab-1", title: "A", url: "https://a.test", active: true }],
      activeTabId: "tab-1",
    });
    expect(service.ensureBrowserCalls).toBe(1);
  });

  it("switch_tab activates the requested tab", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.activateTarget", {});
    client.queueResponse("Target.getTargets", {
      targetInfos: [
        { targetId: "tab-1", type: "page", title: "A", url: "https://a.test", attached: true },
        { targetId: "tab-2", type: "page", title: "B", url: "https://b.test", attached: true },
      ],
    });

    const service = new MockBrowserDaemonService(client);
    const tool = new BrowserTool(service as unknown as BrowserDaemonService);

    const result = await tool.execute({ action: "switch_tab", tabId: "tab-2" }, context);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      action: "switch_tab",
      tabId: "tab-2",
      activeTabId: "tab-2",
    });
  });

  it("status returns daemon status without CDP calls", async () => {
    const service = new MockBrowserDaemonService(new MockCdpClient());
    service.status = {
      running: false,
      tabs: [],
      profilePath: "/tmp/profile",
      headless: true,
    };
    const tool = new BrowserTool(service as unknown as BrowserDaemonService);

    const result = await tool.execute({ action: "status" }, context);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(service.status);
    expect(service.ensureBrowserCalls).toBe(0);
  });

  it("returns structured error results instead of throwing", async () => {
    const service = new MockBrowserDaemonService(new MockCdpClient());
    service.shouldThrowOnEnsure = true;
    const tool = new BrowserTool(service as unknown as BrowserDaemonService);

    const result = await tool.execute({ action: "new_tab" }, context);

    expect(result.error).toBe("Browser unavailable");
    expect(result.errorDetail).toEqual({
      code: "BROWSER_NOT_RUNNING",
      message: "Browser unavailable",
      retryable: false,
    });
  });
});

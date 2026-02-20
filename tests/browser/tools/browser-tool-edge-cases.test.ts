import { describe, expect, it } from "bun:test";

import { BrowserTool } from "../../../src/browser/tools/browser-tool";
import type { BrowserDaemonService } from "../../../src/browser/browser-daemon-service";
import type { CdpMethod } from "../../../src/browser/types";
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
  public updateTabStateCalls: Array<{ tabs: unknown[]; activeTabId?: string }> = [];
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
    return this.client;
  }

  updateTabState(tabs: unknown[], activeTabId?: string): void {
    this.updateTabStateCalls.push({ tabs, activeTabId });
    this.currentTabId = activeTabId;
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

describe("BrowserTool edge cases", () => {
  it("navigate creates blank tab when no page targets exist", async () => {
    const client = new MockCdpClient();

    // First getTargets returns empty (no page targets) — triggers createBlankTab
    client.queueResponse("Target.getTargets", { targetInfos: [] });
    client.queueResponse("Target.createTarget", { targetId: "tab-new" });
    client.queueResponse("Target.attachToTarget", { sessionId: "session-new" });
    client.queueResponse("Page.enable", {});
    client.queueResponse("Page.navigate", { frameId: "frame-1" });
    client.queueResponse("Runtime.evaluate", { result: { type: "string", value: "complete" } });
    client.queueResponse("Runtime.evaluate", {
      result: {
        type: "object",
        value: { url: "https://example.com", title: "Example" },
      },
    });
    // After navigate, refreshTabState calls getTargets again
    client.queueResponse("Target.getTargets", {
      targetInfos: [
        { targetId: "tab-new", type: "page", title: "Example", url: "https://example.com", attached: true },
      ],
    });

    const service = new MockBrowserDaemonService(client);
    const tool = new BrowserTool(service as unknown as BrowserDaemonService);

    const result = await tool.execute(
      { callId: "call-blank", action: "navigate", url: "https://example.com" },
      context,
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      action: "navigate",
      tabId: "tab-new",
      url: "https://example.com",
      title: "Example",
    });

    // Verify Target.createTarget was called with about:blank
    const createCall = client.calls.find((c) => c.method === "Target.createTarget");
    expect(createCall).toBeDefined();
    expect(createCall?.params?.url).toBe("about:blank");
  });

  it("close_tab uses current tab when no tabId specified", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.closeTarget", { success: true });
    client.queueResponse("Target.getTargets", {
      targetInfos: [],
    });

    const service = new MockBrowserDaemonService(client);
    service.currentTabId = "tab-current";
    const tool = new BrowserTool(service as unknown as BrowserDaemonService);

    const result = await tool.execute({ action: "close_tab" }, context);

    expect(result.error).toBeUndefined();
    const closeCall = client.calls.find((c) => c.method === "Target.closeTarget");
    expect(closeCall?.params?.targetId).toBe("tab-current");
  });
});

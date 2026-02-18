import { describe, expect, it } from "bun:test";

import { CdpError } from "../../../src/browser/errors";
import type { BrowserDaemonService } from "../../../src/browser/browser-daemon-service";
import type { CdpClient } from "../../../src/browser/cdp-client";
import type { ElementRefRegistry } from "../../../src/browser/element-ref-registry";
import { BrowserActTool } from "../../../src/browser/tools/browser-act-tool";
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

    const value = queued.shift();
    if (value instanceof Error) {
      throw value;
    }

    return value as T;
  }
}

class MockBrowserDaemonService {
  public currentTabId?: string;

  constructor(public readonly client: MockCdpClient) {}

  async ensureBrowser(): Promise<MockCdpClient> {
    return this.client;
  }

  getCurrentTabId(): string | undefined {
    return this.currentTabId;
  }
}

class MockElementRefRegistry {
  private readonly refs = new Map<string, Map<string, number>>();

  setRef(tabId: string, ref: string, backendNodeId: number): void {
    const byTab = this.refs.get(tabId) ?? new Map<string, number>();
    byTab.set(ref, backendNodeId);
    this.refs.set(tabId, byTab);
  }

  lookupRef(tabId: string, ref: string): number | undefined {
    return this.refs.get(tabId)?.get(ref);
  }
}

const context: ToolContext = {
  conversationId: "conv-1",
  userId: "user-1",
};

function setup() {
  const client = new MockCdpClient();
  const service = new MockBrowserDaemonService(client);
  const registry = new MockElementRefRegistry();
  const tool = new BrowserActTool(
    service as unknown as BrowserDaemonService,
    registry as unknown as ElementRefRegistry,
  );
  return { client, service, registry, tool };
}

function queueAttach(client: MockCdpClient, sessionId = "session-1"): void {
  client.queueResponse("Target.attachToTarget", { sessionId });
}

describe("BrowserActTool cookie actions", () => {
  it("get_cookies calls Network.getCookies and returns cookie array", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);
    const mockCookies = [
      { name: "session", value: "abc123", domain: ".example.com" },
      { name: "theme", value: "dark", domain: ".example.com" },
    ];
    client.queueResponse("Network.getCookies", { cookies: mockCookies });

    const result = await tool.execute(
      { action: "get_cookies", callId: "call-gc" },
      context,
    );

    expect(result.callId).toBe("call-gc");
    expect(result.error).toBeUndefined();
    const data = result.result as { action: string; cookies: unknown[] };
    expect(data.action).toBe("get_cookies");
    expect(data.cookies).toEqual(mockCookies);

    const cdpCall = client.calls.find((c) => c.method === "Network.getCookies");
    expect(cdpCall).toBeDefined();
  });

  it("set_cookie calls Network.setCookie with name and value", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);
    client.queueResponse("Network.setCookie", { success: true });

    const result = await tool.execute(
      { action: "set_cookie", name: "token", value: "xyz", callId: "call-sc" },
      context,
    );

    expect(result.error).toBeUndefined();
    const data = result.result as { action: string; name: string; value: string };
    expect(data.action).toBe("set_cookie");
    expect(data.name).toBe("token");
    expect(data.value).toBe("xyz");

    const cdpCall = client.calls.find((c) => c.method === "Network.setCookie");
    expect(cdpCall?.params).toEqual({ name: "token", value: "xyz" });
  });

  it("set_cookie includes domain and path when provided", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);
    client.queueResponse("Network.setCookie", { success: true });

    await tool.execute(
      {
        action: "set_cookie",
        name: "auth",
        value: "secret",
        domain: ".example.com",
        path: "/api",
        callId: "call-sc-dp",
      },
      context,
    );

    const cdpCall = client.calls.find((c) => c.method === "Network.setCookie");
    expect(cdpCall?.params).toEqual({
      name: "auth",
      value: "secret",
      domain: ".example.com",
      path: "/api",
    });
  });

  it("clear_cookies calls Network.clearBrowserCookies", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);
    client.queueResponse("Network.clearBrowserCookies", {});

    const result = await tool.execute(
      { action: "clear_cookies", callId: "call-cc" },
      context,
    );

    expect(result.error).toBeUndefined();
    const data = result.result as { action: string };
    expect(data.action).toBe("clear_cookies");

    const cdpCall = client.calls.find((c) => c.method === "Network.clearBrowserCookies");
    expect(cdpCall).toBeDefined();
  });
});

describe("BrowserActTool storage actions", () => {
  it("get_storage defaults to localStorage", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);
    client.queueResponse("Runtime.evaluate", {
      result: { type: "object", value: { theme: "dark", lang: "en" } },
    });

    const result = await tool.execute(
      { action: "get_storage", callId: "call-gs" },
      context,
    );

    expect(result.error).toBeUndefined();
    const data = result.result as { action: string; storageType: string; data: unknown };
    expect(data.action).toBe("get_storage");
    expect(data.storageType).toBe("local");
    expect(data.data).toEqual({ theme: "dark", lang: "en" });

    const evalCall = client.calls.find((c) => c.method === "Runtime.evaluate");
    expect(evalCall?.params?.expression).toContain("localStorage");
  });

  it("get_storage with storageType session evaluates sessionStorage", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);
    client.queueResponse("Runtime.evaluate", {
      result: { type: "object", value: { cart: "item1" } },
    });

    const result = await tool.execute(
      { action: "get_storage", storageType: "session", callId: "call-gs-session" },
      context,
    );

    const data = result.result as { action: string; storageType: string; data: unknown };
    expect(data.storageType).toBe("session");
    expect(data.data).toEqual({ cart: "item1" });

    const evalCall = client.calls.find((c) => c.method === "Runtime.evaluate");
    expect(evalCall?.params?.expression).toContain("sessionStorage");
  });

  it("set_storage defaults to localStorage", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);
    client.queueResponse("Runtime.evaluate", {
      result: { type: "undefined" },
    });

    const result = await tool.execute(
      { action: "set_storage", key: "theme", value: "dark", callId: "call-ss" },
      context,
    );

    expect(result.error).toBeUndefined();
    const data = result.result as { action: string; storageType: string; key: string; value: string };
    expect(data.action).toBe("set_storage");
    expect(data.storageType).toBe("local");
    expect(data.key).toBe("theme");
    expect(data.value).toBe("dark");

    const evalCall = client.calls.find((c) => c.method === "Runtime.evaluate");
    expect(evalCall?.params?.expression).toContain("localStorage.setItem");
    expect(evalCall?.params?.expression).toContain('"theme"');
    expect(evalCall?.params?.expression).toContain('"dark"');
  });

  it("set_storage with storageType session evaluates sessionStorage.setItem", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);
    client.queueResponse("Runtime.evaluate", {
      result: { type: "undefined" },
    });

    await tool.execute(
      { action: "set_storage", key: "cart", value: "item1", storageType: "session", callId: "call-ss-session" },
      context,
    );

    const evalCall = client.calls.find((c) => c.method === "Runtime.evaluate");
    expect(evalCall?.params?.expression).toContain("sessionStorage.setItem");
  });

  it("clear_storage defaults to localStorage", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);
    client.queueResponse("Runtime.evaluate", {
      result: { type: "undefined" },
    });

    const result = await tool.execute(
      { action: "clear_storage", callId: "call-cs" },
      context,
    );

    expect(result.error).toBeUndefined();
    const data = result.result as { action: string; storageType: string };
    expect(data.action).toBe("clear_storage");
    expect(data.storageType).toBe("local");

    const evalCall = client.calls.find((c) => c.method === "Runtime.evaluate");
    expect(evalCall?.params?.expression).toContain("localStorage.clear()");
  });

  it("clear_storage with storageType session evaluates sessionStorage.clear()", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);
    client.queueResponse("Runtime.evaluate", {
      result: { type: "undefined" },
    });

    await tool.execute(
      { action: "clear_storage", storageType: "session", callId: "call-cs-session" },
      context,
    );

    const evalCall = client.calls.find((c) => c.method === "Runtime.evaluate");
    expect(evalCall?.params?.expression).toContain("sessionStorage.clear()");
  });
});

describe("BrowserActTool cookie/storage error handling", () => {
  it("set_cookie returns error when name is missing", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);

    const result = await tool.execute(
      { action: "set_cookie", value: "xyz", callId: "call-sc-no-name" },
      context,
    );

    expect(result.callId).toBe("call-sc-no-name");
    expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
    expect(result.error).toContain("name");
  });

  it("set_storage returns error when key is missing", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);

    const result = await tool.execute(
      { action: "set_storage", value: "dark", callId: "call-ss-no-key" },
      context,
    );

    expect(result.callId).toBe("call-ss-no-key");
    expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
    expect(result.error).toContain("key");
  });

  it("get_cookies returns CDP_ERROR on CDP failure", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueAttach(client);
    client.queueResponse("Network.getCookies", new CdpError("Network domain disabled"));

    const result = await tool.execute(
      { action: "get_cookies", callId: "call-gc-err" },
      context,
    );

    expect(result.callId).toBe("call-gc-err");
    expect(result.errorDetail?.code).toBe("CDP_ERROR");
    expect(result.errorDetail?.retryable).toBe(true);
  });
});

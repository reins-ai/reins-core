import { describe, expect, it } from "bun:test";

import { ToolExecutor } from "../../../src/tools/executor";
import { ToolRegistry } from "../../../src/tools/registry";
import { connectParallelTools, PARALLEL_URL, USER_AGENT } from "../src/parallel-tools";

interface Message {
  id?: number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown>; requestId?: number };
}

function fixture(options: {
  call?: (message: Message, init: RequestInit) => Promise<Response>;
  missingTool?: boolean;
} = {}) {
  const requests: { url: string; init: RequestInit; message?: Message }[] = [];
  const reply = (id: number | undefined, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
  const fetchFn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const message = typeof init.body === "string" ? JSON.parse(init.body) as Message : undefined;
    requests.push({ url, init, message });
    if (init.method === "GET") return new Response(null, { status: 405 });
    if (message?.method === "initialize") {
      return reply(message.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "parallel-fixture", version: "1.0" },
      });
    }
    if (message?.method === "tools/list") {
      return reply(message.id, {
        tools: (options.missingTool ? ["web_search"] : ["web_search", "web_fetch"]).map((name) => ({
          name,
          inputSchema: { type: "object", properties: {} },
        })),
      });
    }
    if (message?.method === "tools/call") {
      if (options.call) return options.call(message, init);
      return reply(message.id, {
        content: [{ type: "text", text: 'Source: https://bun.sh/docs\nBun runs TypeScript.' }],
      });
    }
    return new Response(null, { status: 202 });
  };
  return { fetchFn, requests, reply };
}

async function setup(options: Parameters<typeof fixture>[0] = {}, timeoutMs = 1000) {
  const http = fixture(options);
  const connection = await connectParallelTools({ fetchFn: http.fetchFn, timeoutMs });
  const registry = new ToolRegistry();
  // The example can coexist with an existing built-in web_search tool.
  registry.register({
    definition: { name: "web_search", description: "Existing tool", parameters: { type: "object", properties: {} } },
    async execute() { return { callId: "", name: "web_search", result: "existing" }; },
  });
  for (const tool of connection.tools) registry.register(tool);
  const executor = new ToolExecutor(registry);
  const context = { conversationId: "research-1", userId: "example" };
  return { ...http, ...connection, registry, executor, context };
}

describe("Parallel tools through ToolRegistry and ToolExecutor", () => {
  it("discovers, searches and fetches anonymously with source output and a stable session", async () => {
    const app = await setup();
    try {
      const search = await app.executor.execute({
        id: "search-1", name: "parallel_web_search",
        arguments: { objective: "Find Bun docs", search_queries: ["Bun TypeScript documentation"], session_id: "ignored" },
      }, app.context);
      const fetched = await app.executor.execute({
        id: "fetch-1", name: "parallel_web_fetch", arguments: { urls: ["https://bun.sh/docs"] },
      }, app.context);
      expect(search.callId).toBe("search-1");
      expect(search.error).toBeUndefined();
      expect(fetched.error).toBeUndefined();
      expect(JSON.stringify(search.result)).toContain("https://bun.sh/docs");
      expect(JSON.stringify(fetched.result)).toContain("Bun runs TypeScript.");
      const calls = app.requests.filter((r) => r.message?.method === "tools/call");
      expect(calls.map((r) => r.message?.params?.name)).toEqual(["web_search", "web_fetch"]);
      expect(calls[0]?.message?.params?.arguments?.search_queries).toEqual(["Bun TypeScript documentation"]);
      expect(calls[1]?.message?.params?.arguments?.urls).toEqual(["https://bun.sh/docs"]);
      const session = calls[0]?.message?.params?.arguments?.session_id;
      expect(session).toMatch(/^[a-f0-9]{64}$/);
      expect(calls[1]?.message?.params?.arguments?.session_id).toBe(session);
      for (const request of app.requests) {
        expect(request.url).toBe(PARALLEL_URL);
        const headers = new Headers(request.init.headers);
        expect(headers.get("user-agent")).toBe(USER_AGENT);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("cookie")).toBe(false);
        expect(request.init.credentials).toBe("omit");
      }
      const existing = await app.executor.execute({ id: "old", name: "web_search", arguments: {} }, app.context);
      expect(existing.result).toBe("existing");
      expect(app.registry.getDefinitions()).toHaveLength(3);
    } finally { await app.close(); }
  });

  it("maps MCP tool errors into failed Reins results", async () => {
    const http = fixture();
    const app = await setup({ call: async (message) => http.reply(message.id, {
      isError: true, content: [{ type: "text", text: "Search quota exceeded" }],
    }) });
    try {
      const result = await app.executor.execute({ id: "err", name: "parallel_web_search", arguments: {} }, app.context);
      expect(result.error).toBe("Search quota exceeded");
      expect(result.result).toBeNull();
    } finally { await app.close(); }
  });

  it.each(["http", "rpc", "malformed", "network"])("surfaces %s failures through the executor", async (failure) => {
    const app = await setup({ call: async (message) => {
      if (failure === "http") return new Response("Too many requests", { status: 429 });
      if (failure === "network") throw new Error("Network unavailable");
      if (failure === "rpc") return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Invalid arguments" } });
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: "bad content" } });
    } });
    try {
      const result = await app.executor.execute({ id: "err", name: "parallel_web_search", arguments: {} }, app.context);
      expect(result.error).toBeString();
      expect(result.result).toBeNull();
      expect(result.callId).toBe("err");
    } finally { await app.close(); }
  });

  it.each(["timeout", "abort"])("cancels an in-flight request on %s", async (mode) => {
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const app = await setup({ call: async (_message, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("Transport closed")), { once: true });
      });
    } }, mode === "timeout" ? 100 : 1000);
    try {
      const controller = new AbortController();
      const pending = app.executor.execute({ id: "cancel", name: "parallel_web_search", arguments: {} }, {
        ...app.context, abortSignal: controller.signal,
      });
      await waiting;
      if (mode === "abort") controller.abort();
      const result = await pending;
      expect(result.error?.toLowerCase()).toContain(mode === "timeout" ? "timed out" : "abort");
      expect(result.result).toBeNull();
      expect(app.requests.some((r) => r.message?.method === "notifications/cancelled")).toBe(true);
    } finally { await app.close(); }
  });

  it("rejects a server missing a required tool before registration", async () => {
    const http = fixture({ missingTool: true });
    await expect(connectParallelTools({ fetchFn: http.fetchFn })).rejects.toThrow("did not advertise web_fetch");
  });

  it("rejects invalid timeouts before connecting", async () => {
    await expect(connectParallelTools({ timeoutMs: 0 })).rejects.toThrow("positive finite");
  });
});

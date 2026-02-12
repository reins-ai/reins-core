import { afterEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ok } from "../../src/result";
import { ConversationManager } from "../../src/conversation/manager";
import { InMemoryConversationStore } from "../../src/conversation/memory-store";
import { SQLiteConversationStore } from "../../src/conversation/sqlite-store";
import { DaemonHttpServer } from "../../src/daemon/server";
import { DaemonRuntime } from "../../src/daemon/runtime";
import { ProviderAuthService } from "../../src/providers/auth-service";
import { MockProvider } from "../../src/providers/mock";
import { ProviderRegistry } from "../../src/providers/registry";
import { ModelRouter } from "../../src/providers/router";
import type { DaemonManagedService } from "../../src/daemon/types";
import type { ConversationAuthCheck } from "../../src/providers/auth-service";
import type { Model } from "../../src/types";

/**
 * Create a minimal auth service stub that satisfies the DaemonHttpServer
 * constructor without requiring real credential stores or OAuth providers.
 */
function createStubAuthService(): ProviderAuthService {
  const registry = new ProviderRegistry();
  return new ProviderAuthService({
    store: {
      get: async () => ok(null),
      set: async () => ok(undefined),
      delete: async () => ok(undefined),
      list: async () => ok([]),
      has: async () => ok(false),
    } as any,
    registry,
    oauthProviderRegistry: { get: () => undefined, list: () => [], register: () => {} } as any,
    apiKeyStrategies: {},
  });
}

function uniqueDbPath(): string {
  return join(tmpdir(), `reins-test-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // file may not exist
  }
  try {
    unlinkSync(`${path}-wal`);
  } catch {
    // WAL file may not exist
  }
  try {
    unlinkSync(`${path}-shm`);
  } catch {
    // SHM file may not exist
  }
}

function createMockModel(id: string, provider: string): Model {
  return {
    id,
    name: id,
    provider,
    contextWindow: 8192,
    capabilities: ["chat", "streaming"],
  };
}

function createConversationReadyStubAuthService(check: ConversationAuthCheck): ProviderAuthService {
  const unimplemented = async () => {
    throw new Error("Not implemented in test auth stub");
  };

  return {
    checkConversationReady: async () => ok(check),
    listProviders: unimplemented,
    getProviderAuthStatus: unimplemented,
    handleCommand: unimplemented,
    initiateOAuth: unimplemented,
    completeOAuthCallback: unimplemented,
    setApiKey: unimplemented,
    setOAuthTokens: unimplemented,
    getOAuthAccessToken: unimplemented,
    getCredential: unimplemented,
    revokeProvider: unimplemented,
    requiresAuth: () => true,
    getAuthMethods: () => ["oauth"],
  } as unknown as ProviderAuthService;
}

async function waitForAssistantCompletion(options: {
  manager: ConversationManager;
  conversationId: string;
  assistantMessageId: string;
  timeoutMs?: number;
}): Promise<{ status: string; content: string; metadata: Record<string, unknown> | undefined }> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const conversation = await options.manager.load(options.conversationId);
    const assistantMessage = conversation.messages.find((message) => message.id === options.assistantMessageId);
    const metadata = assistantMessage?.metadata as Record<string, unknown> | undefined;
    const status = typeof metadata?.status === "string" ? metadata.status : undefined;

    if (assistantMessage && (status === "complete" || status === "error")) {
      return {
        status,
        content: assistantMessage.content,
        metadata,
      };
    }

    await Bun.sleep(20);
  }

  throw new Error("Timed out waiting for assistant completion");
}

describe("DaemonHttpServer conversation wiring", () => {
  const servers: DaemonHttpServer[] = [];
  const dbPaths: string[] = [];

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;

    for (const path of dbPaths) {
      safeUnlink(path);
    }
    dbPaths.length = 0;
  });

  it("starts with conversation services using default SQLite store", async () => {
    const dbPath = uniqueDbPath();
    dbPaths.push(dbPath);

    const server = new DaemonHttpServer({
      port: 0,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { sqliteStorePath: dbPath },
    });
    servers.push(server);

    const result = await server.start();
    expect(result.ok).toBe(true);

    const manager = server.getConversationManager();
    expect(manager).toBeInstanceOf(ConversationManager);
  });

  it("starts with injected conversation manager", async () => {
    const store = new InMemoryConversationStore();
    const injectedManager = new ConversationManager(store);

    const server = new DaemonHttpServer({
      port: 0,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { conversationManager: injectedManager },
    });
    servers.push(server);

    const result = await server.start();
    expect(result.ok).toBe(true);

    const manager = server.getConversationManager();
    expect(manager).toBe(injectedManager);
  });

  it("starts without conversation services when no options provided", async () => {
    const server = new DaemonHttpServer({
      port: 0,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
    });
    servers.push(server);

    const result = await server.start();
    expect(result.ok).toBe(true);

    // Default behavior creates a SQLite store, so manager should be present
    const manager = server.getConversationManager();
    expect(manager).toBeInstanceOf(ConversationManager);
  });

  it("cleans up conversation services on stop", async () => {
    const dbPath = uniqueDbPath();
    dbPaths.push(dbPath);

    const server = new DaemonHttpServer({
      port: 0,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { sqliteStorePath: dbPath },
    });
    servers.push(server);

    await server.start();
    expect(server.getConversationManager()).not.toBeNull();

    await server.stop();
    expect(server.getConversationManager()).toBeNull();
  });

  it("conversation manager can create and load conversations after wiring", async () => {
    const dbPath = uniqueDbPath();
    dbPaths.push(dbPath);

    const server = new DaemonHttpServer({
      port: 0,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { sqliteStorePath: dbPath },
    });
    servers.push(server);

    await server.start();

    const manager = server.getConversationManager();
    expect(manager).not.toBeNull();

    const conversation = await manager!.create({
      title: "Test Conversation",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });

    expect(conversation.id).toBeTruthy();
    expect(conversation.title).toBe("Test Conversation");

    const loaded = await manager!.load(conversation.id);
    expect(loaded.id).toBe(conversation.id);
    expect(loaded.title).toBe("Test Conversation");
  });

  it("server starts successfully with both auth and conversation services", async () => {
    const dbPath = uniqueDbPath();
    dbPaths.push(dbPath);

    const server = new DaemonHttpServer({
      port: 0,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { sqliteStorePath: dbPath },
    });
    servers.push(server);

    const result = await server.start();
    expect(result.ok).toBe(true);

    // Both auth service (via constructor) and conversation manager are active
    expect(server.getConversationManager()).toBeInstanceOf(ConversationManager);
  });
});

describe("DaemonHttpServer health endpoint with conversation services", () => {
  const servers: DaemonHttpServer[] = [];
  const dbPaths: string[] = [];
  let testPort = 17433;

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;

    for (const path of dbPaths) {
      safeUnlink(path);
    }
    dbPaths.length = 0;
  });

  it("health endpoint reports conversation capabilities when services are active", async () => {
    const dbPath = uniqueDbPath();
    dbPaths.push(dbPath);
    const port = testPort++;

    const server = new DaemonHttpServer({
      port,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { sqliteStorePath: dbPath },
    });
    servers.push(server);

    await server.start();

    const response = await fetch(`http://localhost:${port}/health`);
    expect(response.status).toBe(200);

    const health = await response.json();
    expect(health.status).toBe("ok");
    expect(health.discovery.capabilities).toContain("conversations.crud");
    expect(health.discovery.capabilities).toContain("messages.send");
    expect(health.discovery.capabilities).toContain("stream.subscribe");
  });

  it("existing auth list endpoint remains functional", async () => {
    const dbPath = uniqueDbPath();
    dbPaths.push(dbPath);
    const port = testPort++;

    const server = new DaemonHttpServer({
      port,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { sqliteStorePath: dbPath },
    });
    servers.push(server);

    await server.start();

    const response = await fetch(`http://localhost:${port}/api/providers/auth/list`);
    expect(response.status).toBe(200);
  });

  it("models endpoint remains functional", async () => {
    const dbPath = uniqueDbPath();
    dbPaths.push(dbPath);
    const port = testPort++;

    const server = new DaemonHttpServer({
      port,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { sqliteStorePath: dbPath },
    });
    servers.push(server);

    await server.start();

    const response = await fetch(`http://localhost:${port}/api/models`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("models");
  });
});

describe("DaemonRuntime with conversation-wired server", () => {
  it("full lifecycle: register, start, stop with conversation services", async () => {
    const dbPath = uniqueDbPath();

    const server = new DaemonHttpServer({
      port: 0,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { sqliteStorePath: dbPath },
    });

    const runtime = new DaemonRuntime({ restartBackoffMs: 1 });
    runtime.registerService(server);

    const started = await runtime.start();
    expect(started.ok).toBe(true);
    expect(runtime.getState()).toBe("running");
    expect(server.getConversationManager()).toBeInstanceOf(ConversationManager);

    const stopped = await runtime.stop();
    expect(stopped.ok).toBe(true);
    expect(runtime.getState()).toBe("stopped");
    expect(server.getConversationManager()).toBeNull();

    safeUnlink(dbPath);
  });
});

describe("DaemonHttpServer provider execution pipeline", () => {
  const servers: DaemonHttpServer[] = [];
  let testPort = 17600;

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;
  });

  it("runs provider generation asynchronously and persists assistant output", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());
    const authService = createConversationReadyStubAuthService({
      allowed: true,
      provider: "anthropic",
      connectionState: "ready",
    });

    const registry = new ProviderRegistry();
    registry.register(
      new MockProvider({
        config: { id: "anthropic", type: "oauth" },
        models: [createMockModel("anthropic-test-model", "anthropic")],
        responseContent: "Provider completed response",
      }),
    );

    const modelRouter = new ModelRouter(registry, authService);
    const server = new DaemonHttpServer({
      port: testPort++,
      authService,
      modelRouter,
      conversation: { conversationManager: manager },
    });
    servers.push(server);

    await server.start();

    const postResponse = await fetch(`http://localhost:${testPort - 1}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "Tell me something useful",
        provider: "anthropic",
        model: "anthropic-test-model",
      }),
    });

    expect(postResponse.status).toBe(201);
    const payload = (await postResponse.json()) as {
      conversationId: string;
      assistantMessageId: string;
    };

    const completion = await waitForAssistantCompletion({
      manager,
      conversationId: payload.conversationId,
      assistantMessageId: payload.assistantMessageId,
    });

    expect(completion.status).toBe("complete");
    expect(completion.content).toBe("Provider completed response");
    expect(completion.metadata?.provider).toBe("anthropic");
    expect(completion.metadata?.model).toBe("anthropic-test-model");
  });

  it("maps auth preflight failures to safe assistant error metadata", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());
    const authService = createConversationReadyStubAuthService({
      allowed: false,
      provider: "anthropic",
      connectionState: "requires_auth",
      guidance: {
        provider: "anthropic",
        action: "configure",
        message: "Authentication required for anthropic. Run /connect to configure credentials.",
        supportedModes: ["api_key", "oauth"],
      },
    });

    const registry = new ProviderRegistry();
    registry.register(
      new MockProvider({
        config: { id: "anthropic", type: "oauth" },
        models: [createMockModel("anthropic-test-model", "anthropic")],
      }),
    );

    const modelRouter = new ModelRouter(registry, authService);
    const server = new DaemonHttpServer({
      port: testPort++,
      authService,
      modelRouter,
      conversation: { conversationManager: manager },
    });
    servers.push(server);

    await server.start();

    const postResponse = await fetch(`http://localhost:${testPort - 1}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "Should fail auth",
        provider: "anthropic",
        model: "anthropic-test-model",
      }),
    });

    expect(postResponse.status).toBe(201);
    const payload = (await postResponse.json()) as {
      conversationId: string;
      assistantMessageId: string;
    };

    const completion = await waitForAssistantCompletion({
      manager,
      conversationId: payload.conversationId,
      assistantMessageId: payload.assistantMessageId,
    });

    expect(completion.status).toBe("error");
    expect(completion.metadata?.errorCode).toBe("UNAUTHORIZED");
    expect(completion.metadata?.errorMessage).toBe(
      "Authentication required for anthropic. Run /connect to configure credentials.",
    );
  });
});

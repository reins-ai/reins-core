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
import { ProviderRegistry } from "../../src/providers/registry";
import { ModelRouter } from "../../src/providers/router";
import type { DaemonManagedService } from "../../src/daemon/types";

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

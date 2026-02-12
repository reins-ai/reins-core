import { afterEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ok } from "../../src/result";
import { ConversationManager } from "../../src/conversation/manager";
import { InMemoryConversationStore } from "../../src/conversation/memory-store";
import { SQLiteConversationStore } from "../../src/conversation/sqlite-store";
import { DaemonHttpServer, StreamRegistry, type StreamLifecycleEvent } from "../../src/daemon/server";
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

describe("StreamRegistry", () => {
  it("delivers events to subscribers and cleans up on terminal events", () => {
    const registry = new StreamRegistry();
    const events: StreamLifecycleEvent[] = [];

    registry.subscribe("c1", "a1", (event) => events.push(event));
    expect(registry.hasSubscribers("c1", "a1")).toBe(true);
    expect(registry.activeStreamCount).toBe(1);

    registry.emit({
      type: "message_start",
      conversationId: "c1",
      messageId: "a1",
      sequence: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    registry.emit({
      type: "content_chunk",
      conversationId: "c1",
      messageId: "a1",
      delta: "hello",
      sequence: 1,
      timestamp: "2026-01-01T00:00:01.000Z",
    });

    registry.emit({
      type: "message_complete",
      conversationId: "c1",
      messageId: "a1",
      content: "hello",
      sequence: 2,
      timestamp: "2026-01-01T00:00:02.000Z",
    });

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("message_start");
    expect(events[1].type).toBe("content_chunk");
    expect(events[2].type).toBe("message_complete");

    // Terminal event should clean up subscriptions
    expect(registry.hasSubscribers("c1", "a1")).toBe(false);
    expect(registry.activeStreamCount).toBe(0);
  });

  it("cleans up subscriptions on error terminal event", () => {
    const registry = new StreamRegistry();
    const events: StreamLifecycleEvent[] = [];

    registry.subscribe("c1", "a1", (event) => events.push(event));

    registry.emit({
      type: "error",
      conversationId: "c1",
      messageId: "a1",
      sequence: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
      error: { code: "PROVIDER_UNAVAILABLE", message: "Provider failed", retryable: true },
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(registry.hasSubscribers("c1", "a1")).toBe(false);
  });

  it("supports multiple subscribers per stream", () => {
    const registry = new StreamRegistry();
    const events1: StreamLifecycleEvent[] = [];
    const events2: StreamLifecycleEvent[] = [];

    registry.subscribe("c1", "a1", (event) => events1.push(event));
    registry.subscribe("c1", "a1", (event) => events2.push(event));

    registry.emit({
      type: "message_start",
      conversationId: "c1",
      messageId: "a1",
      sequence: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });

  it("supports multiple concurrent streams", () => {
    const registry = new StreamRegistry();
    const stream1Events: StreamLifecycleEvent[] = [];
    const stream2Events: StreamLifecycleEvent[] = [];

    registry.subscribe("c1", "a1", (event) => stream1Events.push(event));
    registry.subscribe("c2", "a2", (event) => stream2Events.push(event));
    expect(registry.activeStreamCount).toBe(2);

    registry.emit({
      type: "content_chunk",
      conversationId: "c1",
      messageId: "a1",
      delta: "for stream 1",
      sequence: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    registry.emit({
      type: "content_chunk",
      conversationId: "c2",
      messageId: "a2",
      delta: "for stream 2",
      sequence: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(stream1Events).toHaveLength(1);
    expect(stream2Events).toHaveLength(1);
    expect((stream1Events[0] as Extract<StreamLifecycleEvent, { type: "content_chunk" }>).delta).toBe("for stream 1");
    expect((stream2Events[0] as Extract<StreamLifecycleEvent, { type: "content_chunk" }>).delta).toBe("for stream 2");
  });

  it("unsubscribe removes specific subscriber", () => {
    const registry = new StreamRegistry();
    const events: StreamLifecycleEvent[] = [];
    const subscriber = (event: StreamLifecycleEvent) => events.push(event);

    registry.subscribe("c1", "a1", subscriber);
    registry.unsubscribe("c1", "a1", subscriber);

    registry.emit({
      type: "message_start",
      conversationId: "c1",
      messageId: "a1",
      sequence: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(events).toHaveLength(0);
    expect(registry.hasSubscribers("c1", "a1")).toBe(false);
  });

  it("does not throw when emitting to non-existent stream", () => {
    const registry = new StreamRegistry();

    expect(() => {
      registry.emit({
        type: "message_start",
        conversationId: "no-such",
        messageId: "no-such",
        sequence: 0,
        timestamp: "2026-01-01T00:00:00.000Z",
      });
    }).not.toThrow();
  });

  it("subscriber errors do not break the stream pipeline", () => {
    const registry = new StreamRegistry();
    const events: StreamLifecycleEvent[] = [];

    registry.subscribe("c1", "a1", () => {
      throw new Error("subscriber crash");
    });
    registry.subscribe("c1", "a1", (event) => events.push(event));

    registry.emit({
      type: "message_start",
      conversationId: "c1",
      messageId: "a1",
      sequence: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    // Second subscriber still receives the event despite first crashing
    expect(events).toHaveLength(1);
  });

  it("clear removes all streams", () => {
    const registry = new StreamRegistry();
    registry.subscribe("c1", "a1", () => {});
    registry.subscribe("c2", "a2", () => {});
    expect(registry.activeStreamCount).toBe(2);

    registry.clear();
    expect(registry.activeStreamCount).toBe(0);
  });
});

/**
 * Captures all stream lifecycle events emitted through a StreamRegistry,
 * regardless of conversationId/messageId. Installed before the POST request
 * to avoid race conditions between event emission and subscription.
 */
class StreamEventCapture {
  readonly events: StreamLifecycleEvent[] = [];
  private readonly originalEmit: StreamRegistry["emit"];

  constructor(registry: StreamRegistry) {
    this.originalEmit = registry.emit.bind(registry);
    registry.emit = (event: StreamLifecycleEvent): void => {
      this.events.push(event);
      this.originalEmit(event);
    };
  }

  eventsFor(conversationId: string, messageId: string): StreamLifecycleEvent[] {
    return this.events.filter(
      (event) => event.conversationId === conversationId && event.messageId === messageId,
    );
  }

  async waitForTerminal(conversationId: string, messageId: string, timeoutMs = 2000): Promise<StreamLifecycleEvent[]> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const events = this.eventsFor(conversationId, messageId);
      const hasTerminal = events.some(
        (event) => event.type === "message_complete" || event.type === "error",
      );
      if (hasTerminal) {
        return events;
      }
      await Bun.sleep(10);
    }
    return this.eventsFor(conversationId, messageId);
  }
}

describe("DaemonHttpServer streaming lifecycle events", () => {
  const servers: DaemonHttpServer[] = [];
  let testPort = 17700;

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;
  });

  it("emits message_start → content_chunk → message_complete on successful generation", async () => {
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
        responseContent: "Hi",
      }),
    );

    const modelRouter = new ModelRouter(registry, authService);
    const port = testPort++;
    const server = new DaemonHttpServer({
      port,
      authService,
      modelRouter,
      conversation: { conversationManager: manager },
    });
    servers.push(server);

    await server.start();

    // Capture all stream events before posting to avoid race conditions
    const capture = new StreamEventCapture(server.getStreamRegistry());

    const postResponse = await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "Hello",
        provider: "anthropic",
        model: "anthropic-test-model",
      }),
    });

    expect(postResponse.status).toBe(201);
    const payload = (await postResponse.json()) as {
      conversationId: string;
      assistantMessageId: string;
    };

    // Wait for terminal event
    const streamEvents = await capture.waitForTerminal(
      payload.conversationId,
      payload.assistantMessageId,
    );

    // Verify lifecycle event order
    expect(streamEvents.length).toBeGreaterThanOrEqual(3);

    // First event must be message_start
    expect(streamEvents[0].type).toBe("message_start");
    expect(streamEvents[0].conversationId).toBe(payload.conversationId);
    expect(streamEvents[0].messageId).toBe(payload.assistantMessageId);
    expect(streamEvents[0].sequence).toBe(0);

    // Middle events are content_chunks (MockProvider yields one char at a time: "H", "i")
    const chunks = streamEvents.filter((event) => event.type === "content_chunk");
    expect(chunks.length).toBe(2);
    expect((chunks[0] as Extract<StreamLifecycleEvent, { type: "content_chunk" }>).delta).toBe("H");
    expect((chunks[1] as Extract<StreamLifecycleEvent, { type: "content_chunk" }>).delta).toBe("i");

    // Last event must be message_complete
    const lastEvent = streamEvents[streamEvents.length - 1];
    expect(lastEvent.type).toBe("message_complete");
    expect((lastEvent as Extract<StreamLifecycleEvent, { type: "message_complete" }>).content).toBe("Hi");

    // Verify monotonic sequence numbers
    for (let i = 1; i < streamEvents.length; i++) {
      expect(streamEvents[i].sequence).toBe(streamEvents[i - 1].sequence + 1);
    }
  });

  it("emits error event on provider stream failure", async () => {
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
        simulateError: true,
        errorMessage: "Provider exploded",
      }),
    );

    const modelRouter = new ModelRouter(registry, authService);
    const port = testPort++;
    const server = new DaemonHttpServer({
      port,
      authService,
      modelRouter,
      conversation: { conversationManager: manager },
    });
    servers.push(server);

    await server.start();

    // Capture all stream events before posting
    const capture = new StreamEventCapture(server.getStreamRegistry());

    const postResponse = await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "This will fail",
        provider: "anthropic",
        model: "anthropic-test-model",
      }),
    });

    expect(postResponse.status).toBe(201);
    const payload = (await postResponse.json()) as {
      conversationId: string;
      assistantMessageId: string;
    };

    // Wait for terminal event
    const streamEvents = await capture.waitForTerminal(
      payload.conversationId,
      payload.assistantMessageId,
    );

    // MockProvider with simulateError yields an error event as its first stream
    // event, which throws before message_start can be emitted. The error is
    // caught and emitted as a terminal error event — same as auth preflight.
    const startEvents = streamEvents.filter((event) => event.type === "message_start");
    expect(startEvents.length).toBe(0);

    const errorEvents = streamEvents.filter((event) => event.type === "error");
    expect(errorEvents.length).toBe(1);

    const errorEvent = errorEvents[0] as Extract<StreamLifecycleEvent, { type: "error" }>;
    expect(errorEvent.conversationId).toBe(payload.conversationId);
    expect(errorEvent.messageId).toBe(payload.assistantMessageId);
    expect(errorEvent.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(errorEvent.error.retryable).toBe(true);

    // Stream registry should be cleaned up after terminal error
    expect(server.getStreamRegistry().hasSubscribers(
      payload.conversationId,
      payload.assistantMessageId,
    )).toBe(false);

    // Single error event starts at sequence 0
    expect(streamEvents[0].sequence).toBe(0);
  });

  it("emits error event on auth preflight failure without message_start", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());
    const authService = createConversationReadyStubAuthService({
      allowed: false,
      provider: "anthropic",
      connectionState: "requires_auth",
      guidance: {
        provider: "anthropic",
        action: "configure",
        message: "Auth required",
        supportedModes: ["api_key"],
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
    const port = testPort++;
    const server = new DaemonHttpServer({
      port,
      authService,
      modelRouter,
      conversation: { conversationManager: manager },
    });
    servers.push(server);

    await server.start();

    // Capture all stream events before posting
    const capture = new StreamEventCapture(server.getStreamRegistry());

    const postResponse = await fetch(`http://localhost:${port}/api/messages`, {
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

    // Wait for terminal event
    const streamEvents = await capture.waitForTerminal(
      payload.conversationId,
      payload.assistantMessageId,
    );

    // Auth preflight failures bypass the streaming loop entirely,
    // so no message_start is emitted — only the error event.
    const startEvents = streamEvents.filter((event) => event.type === "message_start");
    expect(startEvents.length).toBe(0);

    const errorEvents = streamEvents.filter((event) => event.type === "error");
    expect(errorEvents.length).toBe(1);

    const errorEvent = errorEvents[0] as Extract<StreamLifecycleEvent, { type: "error" }>;
    expect(errorEvent.error.code).toBe("UNAUTHORIZED");
    expect(errorEvent.error.retryable).toBe(false);
  });

  it("cleans up stream registry on server stop", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());
    const server = new DaemonHttpServer({
      port: testPort++,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { conversationManager: manager },
    });
    servers.push(server);

    await server.start();

    // Add a subscriber
    server.getStreamRegistry().subscribe("c1", "a1", () => {});
    expect(server.getStreamRegistry().activeStreamCount).toBe(1);

    await server.stop();
    expect(server.getStreamRegistry().activeStreamCount).toBe(0);
  });

  it("sequence numbers are monotonically increasing per stream", async () => {
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
        responseContent: "ABC",
      }),
    );

    const modelRouter = new ModelRouter(registry, authService);
    const port = testPort++;
    const server = new DaemonHttpServer({
      port,
      authService,
      modelRouter,
      conversation: { conversationManager: manager },
    });
    servers.push(server);

    await server.start();

    // Capture all stream events before posting
    const capture = new StreamEventCapture(server.getStreamRegistry());

    const postResponse = await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "Test sequence",
        provider: "anthropic",
        model: "anthropic-test-model",
      }),
    });

    const payload = (await postResponse.json()) as {
      conversationId: string;
      assistantMessageId: string;
    };

    const streamEvents = await capture.waitForTerminal(
      payload.conversationId,
      payload.assistantMessageId,
    );

    // Expected: message_start(0), chunk A(1), chunk B(2), chunk C(3), message_complete(4)
    expect(streamEvents).toHaveLength(5);
    const sequences = streamEvents.map((event) => event.sequence);
    expect(sequences).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("DaemonHttpServer websocket stream transport", () => {
  const servers: DaemonHttpServer[] = [];
  let testPort = 17950;

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;
  });

  it("accepts stream.subscribe and responds to heartbeat ping", async () => {
    const server = new DaemonHttpServer({
      port: testPort++,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { conversationManager: new ConversationManager(new InMemoryConversationStore()) },
    });
    servers.push(server);
    await server.start();

    const ws = new WebSocket(`ws://localhost:${testPort - 1}/ws`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("websocket open timeout")), 500);
      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("websocket failed to open"));
      }, { once: true });
    });

    const messages: unknown[] = [];
    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      messages.push(JSON.parse(data));
    });

    ws.send(JSON.stringify({ type: "stream.subscribe", conversationId: "c1", assistantMessageId: "a1" }));
    ws.send(JSON.stringify({ type: "heartbeat.ping" }));

    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const hasSubscribed = messages.some((message) => {
          const payload = message as { type?: string };
          return payload.type === "stream.subscribed";
        });
        const hasPong = messages.some((message) => {
          const payload = message as { type?: string };
          return payload.type === "heartbeat.pong";
        });

        if (hasSubscribed && hasPong) {
          clearInterval(timer);
          resolve();
          return;
        }

        if (Date.now() - started > 1000) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for subscribe/heartbeat responses"));
        }
      }, 20);
    });

    ws.close();
  });

  it("acknowledges stream.unsubscribe", async () => {
    const server = new DaemonHttpServer({
      port: testPort++,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { conversationManager: new ConversationManager(new InMemoryConversationStore()) },
    });
    servers.push(server);
    await server.start();

    const ws = new WebSocket(`ws://localhost:${testPort - 1}/ws`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("websocket open timeout")), 500);
      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("websocket failed to open"));
      }, { once: true });
    });

    const messages: unknown[] = [];
    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      messages.push(JSON.parse(data));
    });

    ws.send(JSON.stringify({ type: "stream.subscribe", conversationId: "c1", assistantMessageId: "a1" }));
    ws.send(JSON.stringify({ type: "stream.unsubscribe", conversationId: "c1", assistantMessageId: "a1" }));

    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const hasUnsubscribed = messages.some((message) => {
          const payload = message as { type?: string };
          return payload.type === "stream.unsubscribed";
        });

        if (hasUnsubscribed) {
          clearInterval(timer);
          resolve();
          return;
        }

        if (Date.now() - started > 1000) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for unsubscribe response"));
        }
      }, 20);
    });

    ws.close();
  });
});

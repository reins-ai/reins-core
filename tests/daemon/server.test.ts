import { afterEach, describe, expect, it } from "bun:test";
import { rmSync, unlinkSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
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
import { bootstrapInstallRoot } from "../../src/environment/bootstrap";
import { SkillDaemonService } from "../../src/skills";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import type { DaemonManagedService } from "../../src/daemon/types";
import type { ConversationAuthCheck } from "../../src/providers/auth-service";
import type { MemoryService, ImplicitMemoryInput } from "../../src/memory/services/memory-service";
import type { MemoryRecord } from "../../src/memory/types/memory-record";
import type { ChatRequest, ContentBlock, Model, Provider, StreamEvent, Tool, ToolContext, ToolDefinition, ToolResult } from "../../src/types";

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

  const runtimeDir = join(dirname(path), `.reins-runtime-${parse(path).name}`);
  try {
    rmSync(runtimeDir, { recursive: true, force: true });
  } catch {
    // runtime directory may not exist
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

class TrackingCompactionMemoryService {
  public readonly implicitWrites: ImplicitMemoryInput[] = [];

  isReady(): boolean {
    return true;
  }

  async saveImplicit(input: ImplicitMemoryInput) {
    this.implicitWrites.push(input);
    return ok({ id: `mem-${this.implicitWrites.length}` } as MemoryRecord);
  }
}

function createToolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
  };
}

function createToolExecutorForTests(name: string): ToolExecutor {
  const registry = new ToolRegistry();
  const tool: Tool = {
    definition: createToolDefinition(name),
    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      return {
        callId: "tool-call",
        name,
        result: {
          ok: true,
          value: args["value"] ?? null,
        },
      };
    },
  };

  registry.register(tool);
  return new ToolExecutor(registry);
}

async function writeSkillFixture(options: {
  skillsDir: string;
  skillName: string;
  description: string;
  trustLevel?: "trusted" | "verified" | "untrusted";
  scriptName?: string;
  scriptContent?: string;
}): Promise<void> {
  const skillDir = join(options.skillsDir, options.skillName);
  await mkdir(skillDir, { recursive: true });

  const trustLevel = options.trustLevel ?? "untrusted";
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${options.skillName}\ndescription: ${options.description}\ntrustLevel: ${trustLevel}\n---\n\n# ${options.skillName}\n`,
    "utf8",
  );

  if (options.scriptName) {
    const scriptsDir = join(skillDir, "scripts");
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(
      join(scriptsDir, options.scriptName),
      options.scriptContent ?? "#!/usr/bin/env bash\necho \"skill script ran\"\n",
      "utf8",
    );
  }
}

function createHarnessTwoTurnProvider(modelId: string): Provider {
  let turn = 0;

  return {
    config: {
      id: "anthropic",
      name: "Anthropic",
      type: "oauth",
    },
    async chat() {
      throw new Error("chat is not used in this test provider");
    },
    async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
      turn += 1;

      if (turn === 1) {
        yield { type: "token", content: "P" };
        yield {
          type: "tool_call_start",
          toolCall: {
            id: "tool-1",
            name: "notes.create",
            arguments: { value: "draft" },
          },
        };
        yield {
          type: "done",
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          finishReason: "tool_use",
        };
        return;
      }

      yield { type: "token", content: "Q" };
      yield {
        type: "done",
        usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 },
        finishReason: "stop",
      };
    },
    async listModels(): Promise<Model[]> {
      return [
        {
          ...createMockModel(modelId, "anthropic"),
          capabilities: ["chat", "streaming", "tool_use"],
        },
      ];
    },
    async validateConnection(): Promise<boolean> {
      return true;
    },
  };
}

function createLongRunningToolProvider(modelId: string): Provider {
  let turn = 0;

  return {
    config: {
      id: "anthropic",
      name: "Anthropic",
      type: "oauth",
    },
    async chat() {
      throw new Error("chat is not used in this test provider");
    },
    async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
      turn += 1;

      if (turn === 1) {
        yield {
          type: "tool_call_start",
          toolCall: {
            id: "tool-long",
            name: "notes.create",
            arguments: { value: "draft" },
          },
        };
        yield {
          type: "done",
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          finishReason: "tool_use",
        };
        return;
      }

      yield { type: "token", content: "should-not-run" };
      yield {
        type: "done",
        usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 },
        finishReason: "stop",
      };
    },
    async listModels(): Promise<Model[]> {
      return [
        {
          ...createMockModel(modelId, "anthropic"),
          capabilities: ["chat", "streaming", "tool_use"],
        },
      ];
    },
    async validateConnection(): Promise<boolean> {
      return true;
    },
  };
}

function createSlowAbortAwareToolExecutor(name: string): ToolExecutor {
  const registry = new ToolRegistry();
  const tool: Tool = {
    definition: createToolDefinition(name),
    async execute(_args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 500) {
        if (context.abortSignal?.aborted) {
          return {
            callId: "tool-call",
            name,
            result: "aborted",
            error: "Tool execution aborted",
          };
        }

        await Bun.sleep(10);
      }

      return {
        callId: "tool-call",
        name,
        result: {
          ok: true,
          value: "completed",
        },
      };
    },
  };

  registry.register(tool);
  return new ToolExecutor(registry);
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
}): Promise<{ status: string; content: string | ContentBlock[]; metadata: Record<string, unknown> | undefined }> {
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

  it("wires daemon-created conversation manager with compaction write-through", async () => {
    const dbPath = uniqueDbPath();
    dbPaths.push(dbPath);
    const trackingMemoryService = new TrackingCompactionMemoryService();

    const server = new DaemonHttpServer({
      port: 0,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      memoryService: trackingMemoryService as unknown as MemoryService,
      conversation: {
        sqliteStorePath: dbPath,
        compactionConfig: {
          tokenThreshold: 0.1,
          keepRecentMessages: 2,
          contextWindowTokens: 100,
        },
      },
    });
    servers.push(server);

    const result = await server.start();
    expect(result.ok).toBe(true);

    const manager = server.getConversationManager();
    expect(manager).toBeInstanceOf(ConversationManager);

    const conversation = await manager!.create({
      title: "Compaction wiring",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });

    const longSuffix = " context".repeat(3000);
    await manager!.addMessage(conversation.id, {
      role: "user",
      content: `I prefer TypeScript for backend services.${longSuffix}`,
    });
    await manager!.addMessage(conversation.id, {
      role: "assistant",
      content: `Noted, I will favor TypeScript in examples.${longSuffix}`,
    });
    await manager!.addMessage(conversation.id, {
      role: "user",
      content: `I decided to use Bun runtime for this project.${longSuffix}`,
    });
    await manager!.addMessage(conversation.id, {
      role: "assistant",
      content: `Great, Bun should keep execution fast.${longSuffix}`,
    });
    await manager!.addMessage(conversation.id, {
      role: "user",
      content: `My name is Jamie and I work at Reins Labs.${longSuffix}`,
    });
    await manager!.addMessage(conversation.id, {
      role: "assistant",
      content: `Thanks Jamie, I will remember your profile.${longSuffix}`,
    });

    expect(trackingMemoryService.implicitWrites.length).toBeGreaterThan(0);
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

  it("auth configure returns configured true when credential is persisted", async () => {
    const dbPath = uniqueDbPath();
    dbPaths.push(dbPath);
    const port = testPort++;
    const authService = createStubAuthService();

    (authService as any).handleCommand = async () => ok({
      action: "configure",
      provider: "brave_search",
      source: "tui",
      credential: {
        id: "auth_brave_search_api_key",
        provider: "brave_search",
        type: "api_key",
      },
    });

    const server = new DaemonHttpServer({
      port,
      authService,
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { sqliteStorePath: dbPath },
    });
    servers.push(server);

    await server.start();

    const response = await fetch(`http://localhost:${port}/api/providers/auth/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "brave_search",
        mode: "api_key",
        key: "brv-test-key",
        source: "tui",
      }),
    });
    expect(response.status).toBe(200);

    const payload = await response.json() as {
      configured?: boolean;
      valid?: boolean;
      provider?: string;
    };
    expect(payload.configured).toBe(true);
    expect(payload.valid).toBe(true);
    expect(payload.provider).toBe("brave_search");
  });

  it("auth configure returns configured false when command returns guidance", async () => {
    const dbPath = uniqueDbPath();
    dbPaths.push(dbPath);
    const port = testPort++;
    const authService = createStubAuthService();

    (authService as any).handleCommand = async () => ok({
      action: "configure",
      provider: "brave_search",
      source: "tui",
      guidance: {
        provider: "brave_search",
        action: "retry",
        message: "Provider brave_search does not support api_key authentication",
        supportedModes: [],
      },
    });

    const server = new DaemonHttpServer({
      port,
      authService,
      modelRouter: new ModelRouter(new ProviderRegistry()),
      conversation: { sqliteStorePath: dbPath },
    });
    servers.push(server);

    await server.start();

    const response = await fetch(`http://localhost:${port}/api/providers/auth/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "brave_search",
        mode: "api_key",
        key: "brv-test-key",
        source: "tui",
      }),
    });
    expect(response.status).toBe(200);

    const payload = await response.json() as {
      configured?: boolean;
      valid?: boolean;
      error?: string;
    };
    expect(payload.configured).toBe(false);
    expect(payload.valid).toBe(false);
    expect(payload.error).toContain("does not support api_key authentication");
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

describe("DaemonHttpServer environment routes", () => {
  const servers: DaemonHttpServer[] = [];
  const tempHomes: string[] = [];
  let testPort = 17520;

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;

    for (const home of tempHomes) {
      await rm(home, { recursive: true, force: true });
    }
    tempHomes.length = 0;
  });

  it("lists environments from /api/environments", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "reins-env-routes-"));
    tempHomes.push(tempHome);
    const port = testPort++;

    const server = new DaemonHttpServer({
      port,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      environment: {
        daemonPathOptions: {
          platform: "linux",
          homeDirectory: tempHome,
          env: {},
        },
      },
      conversation: {
        conversationManager: new ConversationManager(new InMemoryConversationStore()),
      },
    });
    servers.push(server);

    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    const response = await fetch(`http://localhost:${port}/api/environments`);
    expect(response.status).toBe(200);

    const payload = await response.json() as {
      activeEnvironment: string;
      environments: Array<{ name: string }>;
    };

    expect(payload.activeEnvironment).toBe("default");
    expect(payload.environments.some((environment) => environment.name === "default")).toBe(true);
  });

  it("switches environments via /api/environments/switch", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "reins-env-routes-"));
    tempHomes.push(tempHome);

    await bootstrapInstallRoot({
      platform: "linux",
      homeDirectory: tempHome,
      env: {},
    });
    await mkdir(join(tempHome, ".reins", "environments", "work"), { recursive: true });

    const port = testPort++;
    const server = new DaemonHttpServer({
      port,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      environment: {
        daemonPathOptions: {
          platform: "linux",
          homeDirectory: tempHome,
          env: {},
        },
      },
      conversation: {
        conversationManager: new ConversationManager(new InMemoryConversationStore()),
      },
    });
    servers.push(server);

    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    const switchResponse = await fetch(`http://localhost:${port}/api/environments/switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "work" }),
    });
    expect(switchResponse.status).toBe(200);

    const payload = await switchResponse.json() as {
      activeEnvironment: string;
      previousEnvironment: string;
    };
    expect(payload.previousEnvironment).toBe("default");
    expect(payload.activeEnvironment).toBe("work");
  });

  it("reports active overlay resolution via /api/environments/status", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "reins-env-routes-"));
    tempHomes.push(tempHome);

    await bootstrapInstallRoot({
      platform: "linux",
      homeDirectory: tempHome,
      env: {},
    });
    await mkdir(join(tempHome, ".reins", "environments", "work"), { recursive: true });

    const port = testPort++;
    const server = new DaemonHttpServer({
      port,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      environment: {
        daemonPathOptions: {
          platform: "linux",
          homeDirectory: tempHome,
          env: {},
        },
      },
      conversation: {
        conversationManager: new ConversationManager(new InMemoryConversationStore()),
      },
    });
    servers.push(server);

    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    const switchResponse = await fetch(`http://localhost:${port}/api/environments/switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "work" }),
    });
    expect(switchResponse.status).toBe(200);

    const statusResponse = await fetch(`http://localhost:${port}/api/environments/status`);
    expect(statusResponse.status).toBe(200);

    const payload = await statusResponse.json() as {
      activeEnvironment: string;
      resolution: {
        activeEnvironment: string;
        fallbackEnvironment: string;
      };
    };

    expect(payload.activeEnvironment).toBe("work");
    expect(payload.resolution.activeEnvironment).toBe("work");
    expect(payload.resolution.fallbackEnvironment).toBe("default");
  });
});

describe("DaemonHttpServer skill runtime wiring", () => {
  const servers: DaemonHttpServer[] = [];
  const skillServices: SkillDaemonService[] = [];
  const tempHomes: string[] = [];
  let testPort = 17250;

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;

    for (const skillService of skillServices) {
      await skillService.stop();
    }
    skillServices.length = 0;

    for (const tempHome of tempHomes) {
      await rm(tempHome, { recursive: true, force: true });
    }
    tempHomes.length = 0;
  });

  it("injects skill summaries into the environment system prompt", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "reins-skill-wiring-"));
    tempHomes.push(tempHome);

    await bootstrapInstallRoot({
      platform: "linux",
      homeDirectory: tempHome,
      env: {},
    });

    const skillsDir = join(tempHome, ".reins", "skills");
    await writeSkillFixture({
      skillsDir,
      skillName: "git-helper",
      description: "Assist with git workflows.",
      trustLevel: "trusted",
    });

    const skillService = new SkillDaemonService({ skillsDir });
    skillServices.push(skillService);
    const skillStart = await skillService.start();
    expect(skillStart.ok).toBe(true);

    const conversationDbPath = join(tempHome, ".reins", "data", "conversation.db");
    const server = new DaemonHttpServer({
      port: testPort++,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      skillService,
      environment: {
        daemonPathOptions: {
          platform: "linux",
          homeDirectory: tempHome,
          env: {},
        },
      },
      conversation: {
        sqliteStorePath: conversationDbPath,
      },
    });
    servers.push(server);

    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    const manager = server.getConversationManager();
    expect(manager).not.toBeNull();

    const prompt = await manager?.getEnvironmentSystemPrompt();
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("**git-helper**: Assist with git workflows.");
  });

  it("registers skill tools and executes scripts through runtime tool executor", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "reins-skill-tools-"));
    tempHomes.push(tempHome);

    const skillsDir = join(tempHome, "skills");
    await writeSkillFixture({
      skillsDir,
      skillName: "terminal-helper",
      description: "Run terminal helper scripts.",
      trustLevel: "trusted",
      scriptName: "hello.sh",
      scriptContent: "#!/usr/bin/env bash\necho \"hello from skill\"\n",
    });

    const skillService = new SkillDaemonService({ skillsDir });
    skillServices.push(skillService);
    const skillStart = await skillService.start();
    expect(skillStart.ok).toBe(true);

    const server = new DaemonHttpServer({
      port: testPort++,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      skillService,
      conversation: {
        conversationManager: new ConversationManager(new InMemoryConversationStore()),
      },
    });
    servers.push(server);

    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    const internals = server as unknown as { toolExecutor: ToolExecutor; toolDefinitions: ToolDefinition[] };
    const toolRegistry = internals.toolExecutor.getRegistry();
    expect(toolRegistry.has("load_skill")).toBe(true);
    expect(toolRegistry.has("run_skill_script")).toBe(true);
    expect(internals.toolDefinitions.some((definition) => definition.name === "load_skill")).toBe(true);
    expect(internals.toolDefinitions.some((definition) => definition.name === "run_skill_script")).toBe(true);

    const loadResult = await internals.toolExecutor.execute(
      {
        id: "load-1",
        name: "load_skill",
        arguments: {
          name: "terminal-helper",
        },
      },
      {
        conversationId: "conv-1",
        userId: "user-1",
      },
    );
    expect(loadResult.error).toBeUndefined();

    const scriptResult = await internals.toolExecutor.execute(
      {
        id: "script-1",
        name: "run_skill_script",
        arguments: {
          skill: "terminal-helper",
          script: "hello.sh",
          timeout: 5_000,
        },
      },
      {
        conversationId: "conv-1",
        userId: "user-1",
      },
    );

    expect(scriptResult.error).toBeUndefined();
    expect(scriptResult.result).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });

    const output = scriptResult.result as { stdout: string };
    expect(output.stdout).toContain("hello from skill");
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

  it("delegates tool-capable turns to harness loop and completes in one request", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());
    const authService = createConversationReadyStubAuthService({
      allowed: true,
      provider: "anthropic",
      connectionState: "ready",
    });

    const registry = new ProviderRegistry();
    registry.register(createHarnessTwoTurnProvider("anthropic-tool-model"));

    const modelRouter = new ModelRouter(registry, authService);
    const server = new DaemonHttpServer({
      port: testPort++,
      authService,
      modelRouter,
      conversation: { conversationManager: manager },
      toolDefinitions: [createToolDefinition("notes.create")],
      toolExecutor: createToolExecutorForTests("notes.create"),
    });
    servers.push(server);

    await server.start();

    const capture = new StreamEventCapture(server.getStreamRegistry());

    const postResponse = await fetch(`http://localhost:${testPort - 1}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "Create a note then summarize",
        provider: "anthropic",
        model: "anthropic-tool-model",
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

    const streamEvents = await capture.waitForTerminal(payload.conversationId, payload.assistantMessageId);
    expect(streamEvents.map((event) => event.type)).toEqual([
      "message_start",
      "content_chunk",
      "tool_call_start",
      "tool_call_end",
      "content_chunk",
      "message_complete",
    ]);

    const conversation = await manager.load(payload.conversationId);
    const assistant = conversation.messages.find((message) => message.id === payload.assistantMessageId);
    expect(Array.isArray(assistant?.content)).toBe(true);

    if (assistant && Array.isArray(assistant.content)) {
      expect(assistant.content.some((block) => block.type === "tool_use")).toBe(true);
      expect(assistant.content.some((block) => block.type === "tool_result")).toBe(true);
      expect(assistant.content.some((block) => block.type === "text" && block.text === "Q")).toBe(true);
    }
  });

  it("aborts harness execution when websocket subscriber disconnects", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());
    const authService = createConversationReadyStubAuthService({
      allowed: true,
      provider: "anthropic",
      connectionState: "ready",
    });

    const registry = new ProviderRegistry();
    registry.register(createLongRunningToolProvider("anthropic-tool-abort-model"));

    const modelRouter = new ModelRouter(registry, authService);
    const port = testPort++;
    const server = new DaemonHttpServer({
      port,
      authService,
      modelRouter,
      conversation: { conversationManager: manager },
      toolDefinitions: [createToolDefinition("notes.create")],
      toolExecutor: createSlowAbortAwareToolExecutor("notes.create"),
    });
    servers.push(server);

    await server.start();

    const capture = new StreamEventCapture(server.getStreamRegistry());

    const postResponse = await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "Create note and continue",
        provider: "anthropic",
        model: "anthropic-tool-abort-model",
      }),
    });

    expect(postResponse.status).toBe(201);
    const payload = (await postResponse.json()) as {
      conversationId: string;
      assistantMessageId: string;
    };

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
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

    ws.send(JSON.stringify({
      type: "stream.subscribe",
      conversationId: payload.conversationId,
      assistantMessageId: payload.assistantMessageId,
    }));

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const events = capture.eventsFor(payload.conversationId, payload.assistantMessageId);
        if (events.some((event) => event.type === "tool_call_start")) {
          clearInterval(timer);
          resolve();
          return;
        }

        if (Date.now() - startedAt > 1200) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for tool_call_start"));
        }
      }, 20);
    });

    ws.close();

    const completion = await waitForAssistantCompletion({
      manager,
      conversationId: payload.conversationId,
      assistantMessageId: payload.assistantMessageId,
      timeoutMs: 2500,
    });

    expect(completion.status).toBe("complete");
    expect(completion.metadata?.finishReason).toBe("aborted");

    const events = await capture.waitForTerminal(payload.conversationId, payload.assistantMessageId, 2500);
    expect(events.some((event) => event.type === "message_complete")).toBe(true);
    const contentChunks = events.filter((event) => event.type === "content_chunk");
    expect(contentChunks).toHaveLength(0);

    const activeExecutions = (server as unknown as { activeExecutions: Map<string, unknown> }).activeExecutions;
    expect(activeExecutions.size).toBe(0);
  });

  it("keeps single-turn behavior when harness routing is not enabled", async () => {
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
        responseContent: "Legacy path",
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
        content: "No tools",
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
    expect(completion.content).toBe("Legacy path");
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

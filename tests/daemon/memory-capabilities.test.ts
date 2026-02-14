import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok, type Result } from "../../src/result";
import {
  MemoryCapabilitiesResolver,
  readMemoryConfig,
  resolveMemoryCapabilities,
  resolveMemoryConfigPath,
  writeMemoryConfig,
} from "../../src/daemon/memory-capabilities";
import { DaemonHttpServer } from "../../src/daemon/server";
import { ProviderAuthService } from "../../src/providers/auth-service";
import { ProviderRegistry } from "../../src/providers/registry";
import { ModelRouter } from "../../src/providers/router";
import { MemoryService } from "../../src/memory/services/memory-service";
import type {
  CreateMemoryInput,
  ListMemoryOptions,
  UpdateMemoryInput,
  MemoryRepository,
} from "../../src/memory/storage/memory-repository";
import type { MemoryRecord } from "../../src/memory/types/memory-record";
import type { MemoryLayer, MemoryType } from "../../src/memory/types/memory-types";

describe("memory capability resolution", () => {
  it("keeps CRUD enabled and gates embedding-dependent features when config is missing", () => {
    const configPath = "/tmp/reins/embedding-config.json";
    const capabilities = resolveMemoryCapabilities(null, configPath);

    expect(capabilities.embeddingConfigured).toBe(false);
    expect(capabilities.setupRequired).toBe(true);
    expect(capabilities.features.crud.enabled).toBe(true);
    expect(capabilities.features.semanticSearch.enabled).toBe(false);
    expect(capabilities.features.consolidation.enabled).toBe(false);
    expect(capabilities.configPath).toBe(configPath);
  });

  it("enables semantic search and consolidation when embedding config exists", () => {
    const capabilities = resolveMemoryCapabilities(
      {
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
      "/tmp/reins/embedding-config.json",
    );

    expect(capabilities.embeddingConfigured).toBe(true);
    expect(capabilities.setupRequired).toBe(false);
    expect(capabilities.features.crud.enabled).toBe(true);
    expect(capabilities.features.semanticSearch.enabled).toBe(true);
    expect(capabilities.features.consolidation.enabled).toBe(true);
    expect(capabilities.embedding).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
    });
  });
});

describe("memory config persistence", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) {
        continue;
      }
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function createTempRoot(prefix = "reins-memory-capabilities-"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("returns null when config file does not exist", async () => {
    const root = await createTempRoot();
    const result = await readMemoryConfig({ dataRoot: root });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it("writes and reads embedding config from disk", async () => {
    const root = await createTempRoot();

    const writeResult = await writeMemoryConfig(
      {
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
      { dataRoot: root },
    );

    expect(writeResult.ok).toBe(true);
    if (!writeResult.ok) {
      return;
    }

    expect(typeof writeResult.value.updatedAt).toBe("string");

    const readResult = await readMemoryConfig({ dataRoot: root });
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) {
      return;
    }

    expect(readResult.value).toEqual(writeResult.value);
  });

  it("resolves capabilities via resolver using persisted config", async () => {
    const root = await createTempRoot();
    const resolver = new MemoryCapabilitiesResolver({ dataRoot: root });

    const beforeResult = await resolver.getCapabilities();
    expect(beforeResult.ok).toBe(true);
    if (!beforeResult.ok) {
      return;
    }
    expect(beforeResult.value.setupRequired).toBe(true);

    const saveResult = await resolver.saveConfig({
      embedding: {
        provider: "ollama",
        model: "nomic-embed-text",
      },
    });
    expect(saveResult.ok).toBe(true);

    const afterResult = await resolver.getCapabilities();
    expect(afterResult.ok).toBe(true);
    if (!afterResult.ok) {
      return;
    }

    expect(afterResult.value.setupRequired).toBe(false);
    expect(afterResult.value.embeddingConfigured).toBe(true);
    expect(afterResult.value.configPath).toBe(resolveMemoryConfigPath({ dataRoot: root }));
    expect(afterResult.value.features.semanticSearch.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// In-memory repository for HTTP-level degradation tests
// ---------------------------------------------------------------------------

class InMemoryMemoryRepository implements MemoryRepository {
  private readonly records = new Map<string, MemoryRecord>();

  async create(input: CreateMemoryInput): Promise<Result<MemoryRecord>> {
    const now = new Date();
    const record: MemoryRecord = {
      id: randomUUID(),
      content: input.content,
      type: input.type,
      layer: (input.layer === "ltm" ? "ltm" : "stm") as MemoryRecord["layer"],
      tags: input.tags ?? [],
      entities: input.entities ?? [],
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 1.0,
      provenance: {
        sourceType: input.source.type,
        conversationId: input.source.conversationId,
      },
      supersedes: input.supersedes,
      createdAt: now,
      updatedAt: now,
      accessedAt: now,
    };

    this.records.set(record.id, record);
    return ok(record);
  }

  async getById(id: string): Promise<Result<MemoryRecord | null>> {
    return ok(this.records.get(id) ?? null);
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Result<MemoryRecord>> {
    const existing = this.records.get(id);
    if (!existing) {
      return { ok: false, error: new Error(`Memory '${id}' not found`) } as any;
    }

    const updated: MemoryRecord = {
      ...existing,
      content: input.content ?? existing.content,
      importance: input.importance ?? existing.importance,
      confidence: input.confidence ?? existing.confidence,
      tags: input.tags ?? existing.tags,
      entities: input.entities ?? existing.entities,
      updatedAt: new Date(),
      accessedAt: new Date(),
    };

    this.records.set(id, updated);
    return ok(updated);
  }

  async delete(id: string): Promise<Result<void>> {
    this.records.delete(id);
    return ok(undefined);
  }

  async list(options?: ListMemoryOptions): Promise<Result<MemoryRecord[]>> {
    let records = Array.from(this.records.values());

    if (options?.type) {
      records = records.filter((r) => r.type === options.type);
    }

    if (options?.layer) {
      records = records.filter((r) => r.layer === options.layer);
    }

    records.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (typeof options?.offset === "number") {
      records = records.slice(options.offset);
    }

    if (typeof options?.limit === "number") {
      records = records.slice(0, options.limit);
    }

    return ok(records);
  }

  async findByType(type: MemoryType): Promise<Result<MemoryRecord[]>> {
    return this.list({ type });
  }

  async findByLayer(layer: MemoryLayer): Promise<Result<MemoryRecord[]>> {
    if (layer === "stm" || layer === "ltm") {
      return this.list({ layer });
    }
    return ok([]);
  }

  async count(): Promise<Result<number>> {
    return ok(this.records.size);
  }

  async reconcile(): Promise<Result<any>> {
    return ok({
      totalFiles: 0,
      totalDbRecords: this.records.size,
      orphanedFiles: [],
      missingFiles: [],
      contentMismatches: [],
      isConsistent: true,
    });
  }
}

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

// ---------------------------------------------------------------------------
// Graceful degradation: HTTP-level route gating
// ---------------------------------------------------------------------------

describe("graceful degradation for embedding-dependent routes", () => {
  const servers: DaemonHttpServer[] = [];
  const tempDirs: string[] = [];
  let testPort = 19533;

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) {
        continue;
      }
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function createTempRoot(prefix = "reins-degradation-"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function createServerWithCapabilities(
    port: number,
    dataRoot: string,
  ): Promise<DaemonHttpServer> {
    const repository = new InMemoryMemoryRepository();
    const memoryService = new MemoryService({ repository });
    await memoryService.initialize();

    const resolver = new MemoryCapabilitiesResolver({ dataRoot });

    const server = new DaemonHttpServer({
      port,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      memoryService,
      memoryCapabilitiesResolver: resolver,
    });

    servers.push(server);
    return server;
  }

  // -- CRUD always works without embedding config --

  it("POST /api/memory (create) works without embedding config", async () => {
    const port = testPort++;
    const root = await createTempRoot();
    const server = await createServerWithCapabilities(port, root);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Test memory without embeddings" }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBeTruthy();
    expect(body.content).toBe("Test memory without embeddings");
  });

  it("GET /api/memory (list) works without embedding config", async () => {
    const port = testPort++;
    const root = await createTempRoot();
    const server = await createServerWithCapabilities(port, root);
    await server.start();

    // Create a record first
    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Listed memory" }),
    });

    const response = await fetch(`http://localhost:${port}/api/memory`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.memories).toBeDefined();
    expect(body.memories.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/memory/:id (show) works without embedding config", async () => {
    const port = testPort++;
    const root = await createTempRoot();
    const server = await createServerWithCapabilities(port, root);
    await server.start();

    const createResponse = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Shown memory" }),
    });
    const created = await createResponse.json();

    const response = await fetch(`http://localhost:${port}/api/memory/${created.id}`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.id).toBe(created.id);
    expect(body.content).toBe("Shown memory");
  });

  it("DELETE /api/memory/:id works without embedding config", async () => {
    const port = testPort++;
    const root = await createTempRoot();
    const server = await createServerWithCapabilities(port, root);
    await server.start();

    const createResponse = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Deleted memory" }),
    });
    const created = await createResponse.json();

    const response = await fetch(`http://localhost:${port}/api/memory/${created.id}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
  });

  // -- Embedding-dependent routes are gated --

  it("POST /api/memory/search returns 503 without embedding config", async () => {
    const port = testPort++;
    const root = await createTempRoot();
    const server = await createServerWithCapabilities(port, root);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("EMBEDDING_NOT_CONFIGURED");
    expect(body.error).toContain("Semantic search");
    expect(body.error).toContain("/memory setup");
    expect(body.setupRequired).toBe(true);
  });

  it("POST /api/memory/consolidate returns 503 without embedding config", async () => {
    const port = testPort++;
    const root = await createTempRoot();
    const server = await createServerWithCapabilities(port, root);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory/consolidate`, {
      method: "POST",
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("EMBEDDING_NOT_CONFIGURED");
    expect(body.error).toContain("Consolidation");
    expect(body.error).toContain("/memory setup");
    expect(body.setupRequired).toBe(true);
  });

  // -- After setup, all features unlock --

  it("POST /api/memory/search works after embedding config is saved", async () => {
    const port = testPort++;
    const root = await createTempRoot();
    const server = await createServerWithCapabilities(port, root);
    await server.start();

    // Verify search is gated before setup
    const beforeResponse = await fetch(`http://localhost:${port}/api/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });
    expect(beforeResponse.status).toBe(503);

    // Save embedding config
    await writeMemoryConfig(
      { embedding: { provider: "ollama", model: "nomic-embed-text" } },
      { dataRoot: root },
    );

    // Search should now work
    const afterResponse = await fetch(`http://localhost:${port}/api/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });
    expect(afterResponse.status).toBe(200);

    const body = await afterResponse.json();
    expect(body.results).toBeDefined();
  });

  it("POST /api/memory/consolidate works after embedding config is saved", async () => {
    const port = testPort++;
    const root = await createTempRoot();
    const server = await createServerWithCapabilities(port, root);
    await server.start();

    // Verify consolidation is gated before setup
    const beforeResponse = await fetch(`http://localhost:${port}/api/memory/consolidate`, {
      method: "POST",
    });
    expect(beforeResponse.status).toBe(503);

    // Save embedding config
    await writeMemoryConfig(
      { embedding: { provider: "openai", model: "text-embedding-3-small" } },
      { dataRoot: root },
    );

    // Consolidation should now work
    const afterResponse = await fetch(`http://localhost:${port}/api/memory/consolidate`, {
      method: "POST",
    });
    expect(afterResponse.status).toBe(202);

    const body = await afterResponse.json();
    expect(body.status).toBe("accepted");
  });

  it("capabilities endpoint reflects gated state before and after setup", async () => {
    const port = testPort++;
    const root = await createTempRoot();
    const server = await createServerWithCapabilities(port, root);
    await server.start();

    // Before setup
    const beforeResponse = await fetch(`http://localhost:${port}/api/memory/capabilities`);
    expect(beforeResponse.status).toBe(200);
    const before = await beforeResponse.json();
    expect(before.setupRequired).toBe(true);
    expect(before.features.crud.enabled).toBe(true);
    expect(before.features.semanticSearch.enabled).toBe(false);
    expect(before.features.consolidation.enabled).toBe(false);

    // Save config
    await writeMemoryConfig(
      { embedding: { provider: "ollama", model: "nomic-embed-text" } },
      { dataRoot: root },
    );

    // After setup
    const afterResponse = await fetch(`http://localhost:${port}/api/memory/capabilities`);
    expect(afterResponse.status).toBe(200);
    const after = await afterResponse.json();
    expect(after.setupRequired).toBe(false);
    expect(after.features.crud.enabled).toBe(true);
    expect(after.features.semanticSearch.enabled).toBe(true);
    expect(after.features.consolidation.enabled).toBe(true);
  });
});

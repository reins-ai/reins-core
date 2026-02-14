import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok, err, type Result } from "../../src/result";
import { DaemonHttpServer } from "../../src/daemon/server";
import { ProviderAuthService } from "../../src/providers/auth-service";
import { ProviderRegistry } from "../../src/providers/registry";
import { ModelRouter } from "../../src/providers/router";
import { MemoryService } from "../../src/memory/services/memory-service";
import {
  MemoryCapabilitiesResolver,
  writeMemoryConfig,
} from "../../src/daemon/memory-capabilities";
import type {
  CreateMemoryInput,
  ListMemoryOptions,
  UpdateMemoryInput,
  MemoryRepository,
} from "../../src/memory/storage/memory-repository";
import type { MemoryRecord } from "../../src/memory/types/memory-record";
import type { MemoryLayer, MemoryType } from "../../src/memory/types/memory-types";
import {
  validateCreateMemoryRequest,
  validateUpdateMemoryRequest,
  validateSearchMemoryRequest,
  parseListMemoryQueryParams,
} from "../../src/daemon/types/memory-routes";

/**
 * In-memory MemoryRepository for testing daemon memory routes
 * without requiring SQLite or filesystem access.
 */
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
      return err(new Error(`Memory '${id}' not found`) as any);
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

function createMemoryService(): MemoryService {
  const repository = new InMemoryMemoryRepository();
  return new MemoryService({ repository });
}

// ---------------------------------------------------------------------------
// Shared temp directory with pre-configured embedding config so that
// search and consolidation routes are not gated during these tests.
// ---------------------------------------------------------------------------

let sharedDataRoot: string | null = null;

async function getSharedDataRoot(): Promise<string> {
  if (sharedDataRoot) {
    return sharedDataRoot;
  }
  sharedDataRoot = await mkdtemp(join(tmpdir(), "reins-memory-routes-"));
  await writeMemoryConfig(
    { embedding: { provider: "openai", model: "text-embedding-3-small" } },
    { dataRoot: sharedDataRoot },
  );
  return sharedDataRoot;
}

afterAll(async () => {
  if (sharedDataRoot) {
    await rm(sharedDataRoot, { recursive: true, force: true }).catch(() => {});
    sharedDataRoot = null;
  }
});

async function createTestServer(port: number, memoryService?: MemoryService): Promise<DaemonHttpServer> {
  const service = memoryService ?? createMemoryService();
  await service.initialize();

  const dataRoot = await getSharedDataRoot();
  const resolver = new MemoryCapabilitiesResolver({ dataRoot });

  const server = new DaemonHttpServer({
    port,
    authService: createStubAuthService(),
    modelRouter: new ModelRouter(new ProviderRegistry()),
    memoryService: service,
    memoryCapabilitiesResolver: resolver,
  });

  return server;
}

describe("DaemonHttpServer memory routes", () => {
  const servers: DaemonHttpServer[] = [];
  let testPort = 18433;

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;
  });

  // ---------------------------------------------------------------------------
  // Health endpoint
  // ---------------------------------------------------------------------------

  it("health endpoint reports memory capabilities when memory service is active", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/health`);
    expect(response.status).toBe(200);

    const health = await response.json();
    expect(health.discovery.capabilities).toContain("memory.crud");
    expect(health.discovery.capabilities).toContain("memory.search");
    expect(health.discovery.capabilities).toContain("memory.consolidate");
  });

  it("health endpoint does not report memory capabilities when memory service is absent", async () => {
    const port = testPort++;
    const server = new DaemonHttpServer({
      port,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
    });
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/health`);
    const health = await response.json();
    expect(health.discovery.capabilities).not.toContain("memory.crud");
  });

  // ---------------------------------------------------------------------------
  // POST /api/memory — create
  // ---------------------------------------------------------------------------

  it("POST /api/memory creates a memory record", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "The user prefers dark mode",
        type: "preference",
        tags: ["ui", "theme"],
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBeTruthy();
    expect(body.content).toBe("The user prefers dark mode");
    expect(body.type).toBe("preference");
    expect(body.tags).toEqual(["ui", "theme"]);
    expect(body.createdAt).toBeTruthy();
  });

  it("POST /api/memory returns 400 when content is missing", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fact" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("content");
  });

  it("POST /api/memory returns 400 for empty body", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    expect(response.status).toBe(400);
  });

  it("POST /api/memory defaults type to fact when not specified", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Some fact" }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.type).toBe("fact");
  });

  // ---------------------------------------------------------------------------
  // GET /api/memory — list
  // ---------------------------------------------------------------------------

  it("GET /api/memory returns empty list when no memories exist", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.memories).toEqual([]);
  });

  it("GET /api/memory returns created memories", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    // Create two memories
    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Memory one" }),
    });
    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Memory two" }),
    });

    const response = await fetch(`http://localhost:${port}/api/memory`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.memories.length).toBe(2);
  });

  it("GET /api/memory supports type filter", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "A fact", type: "fact" }),
    });
    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "A preference", type: "preference" }),
    });

    const response = await fetch(`http://localhost:${port}/api/memory?type=preference`);
    const body = await response.json();
    expect(body.memories.length).toBe(1);
    expect(body.memories[0].type).toBe("preference");
  });

  it("GET /api/memory supports limit and offset", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    for (let i = 0; i < 5; i++) {
      await fetch(`http://localhost:${port}/api/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `Memory ${i}` }),
      });
    }

    const response = await fetch(`http://localhost:${port}/api/memory?limit=2&offset=1`);
    const body = await response.json();
    expect(body.memories.length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // GET /api/memory/:id — get by ID
  // ---------------------------------------------------------------------------

  it("GET /api/memory/:id returns a specific memory", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const createResponse = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Specific memory" }),
    });
    const created = await createResponse.json();

    const response = await fetch(`http://localhost:${port}/api/memory/${created.id}`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.id).toBe(created.id);
    expect(body.content).toBe("Specific memory");
  });

  it("GET /api/memory/:id returns 404 for non-existent memory", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory/${randomUUID()}`);
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toContain("not found");
  });

  // ---------------------------------------------------------------------------
  // PUT /api/memory/:id — update
  // ---------------------------------------------------------------------------

  it("PUT /api/memory/:id updates a memory record", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const createResponse = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Original content", tags: ["old"] }),
    });
    const created = await createResponse.json();

    const response = await fetch(`http://localhost:${port}/api/memory/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Updated content",
        tags: ["new"],
        importance: 0.9,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content).toBe("Updated content");
    expect(body.tags).toEqual(["new"]);
    expect(body.importance).toBe(0.9);
  });

  it("PUT /api/memory/:id returns 404 for non-existent memory", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory/${randomUUID()}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Updated" }),
    });

    expect(response.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/memory/:id — delete
  // ---------------------------------------------------------------------------

  it("DELETE /api/memory/:id deletes a memory record", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const createResponse = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "To be deleted" }),
    });
    const created = await createResponse.json();

    const deleteResponse = await fetch(`http://localhost:${port}/api/memory/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(204);

    // Verify it's gone
    const getResponse = await fetch(`http://localhost:${port}/api/memory/${created.id}`);
    expect(getResponse.status).toBe(404);
  });

  it("DELETE /api/memory/:id returns 404 for non-existent memory", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory/${randomUUID()}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // POST /api/memory/search — search
  // ---------------------------------------------------------------------------

  it("POST /api/memory/search returns matching memories by content", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "The user likes TypeScript" }),
    });
    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "The user prefers Python" }),
    });

    const response = await fetch(`http://localhost:${port}/api/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "TypeScript" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.query).toBe("TypeScript");
    expect(body.results.length).toBe(1);
    expect(body.results[0].content).toContain("TypeScript");
    expect(body.total).toBe(1);
  });

  it("POST /api/memory/search returns all memories when query is empty", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Memory A" }),
    });
    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Memory B" }),
    });

    const response = await fetch(`http://localhost:${port}/api/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.length).toBe(2);
  });

  it("POST /api/memory/search supports type filter", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "A fact about cats", type: "fact" }),
    });
    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Prefers cats", type: "preference" }),
    });

    const response = await fetch(`http://localhost:${port}/api/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "cats", type: "fact" }),
    });

    const body = await response.json();
    expect(body.results.length).toBe(1);
    expect(body.results[0].type).toBe("fact");
  });

  it("POST /api/memory/search matches on tags", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Some memory", tags: ["typescript", "coding"] }),
    });
    await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Another memory", tags: ["cooking"] }),
    });

    const response = await fetch(`http://localhost:${port}/api/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "typescript" }),
    });

    const body = await response.json();
    expect(body.results.length).toBe(1);
    expect(body.results[0].tags).toContain("typescript");
  });

  // ---------------------------------------------------------------------------
  // POST /api/memory/consolidate — trigger consolidation
  // ---------------------------------------------------------------------------

  it("POST /api/memory/consolidate returns 202 accepted", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory/consolidate`, {
      method: "POST",
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.status).toBe("accepted");
    expect(body.message).toContain("Consolidation");
    expect(body.timestamp).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Method not allowed
  // ---------------------------------------------------------------------------

  it("returns 405 for unsupported methods on memory collection", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory`, {
      method: "DELETE",
    });
    expect(response.status).toBe(405);
  });

  it("returns 405 for unsupported methods on memory search", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory/search`);
    expect(response.status).toBe(405);
  });

  it("returns 405 for unsupported methods on memory consolidate", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory/consolidate`);
    expect(response.status).toBe(405);
  });

  // ---------------------------------------------------------------------------
  // Service unavailable
  // ---------------------------------------------------------------------------

  it("returns 503 when memory service is not available", async () => {
    const port = testPort++;
    const server = new DaemonHttpServer({
      port,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      // No memoryService provided
    });
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory`);
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.error).toContain("not available");
  });

  it("returns 503 when memory service is not ready", async () => {
    const port = testPort++;
    // Create service but don't initialize it
    const memoryService = createMemoryService();
    // Don't call memoryService.initialize()

    const server = new DaemonHttpServer({
      port,
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
      memoryService,
    });
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory`);
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.error).toContain("not ready");
  });

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------

  it("OPTIONS /api/memory returns CORS headers", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    const response = await fetch(`http://localhost:${port}/api/memory`, {
      method: "OPTIONS",
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  // ---------------------------------------------------------------------------
  // Full CRUD lifecycle
  // ---------------------------------------------------------------------------

  it("supports full create-read-update-delete lifecycle", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    servers.push(server);
    await server.start();

    // Create
    const createResponse = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Initial content",
        type: "fact",
        tags: ["test"],
        entities: ["user"],
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.id).toBeTruthy();

    // Read
    const getResponse = await fetch(`http://localhost:${port}/api/memory/${created.id}`);
    expect(getResponse.status).toBe(200);
    const fetched = await getResponse.json();
    expect(fetched.content).toBe("Initial content");

    // Update
    const updateResponse = await fetch(`http://localhost:${port}/api/memory/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Updated content", importance: 0.8 }),
    });
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json();
    expect(updated.content).toBe("Updated content");
    expect(updated.importance).toBe(0.8);

    // Delete
    const deleteResponse = await fetch(`http://localhost:${port}/api/memory/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(204);

    // Verify deleted
    const verifyResponse = await fetch(`http://localhost:${port}/api/memory/${created.id}`);
    expect(verifyResponse.status).toBe(404);

    // List should be empty
    const listResponse = await fetch(`http://localhost:${port}/api/memory`);
    const listBody = await listResponse.json();
    expect(listBody.memories.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DTO validation unit tests
// ---------------------------------------------------------------------------

describe("validateCreateMemoryRequest", () => {
  it("accepts valid minimal request", () => {
    const result = validateCreateMemoryRequest({ content: "Hello world" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("Hello world");
      expect(result.value.type).toBeUndefined();
      expect(result.value.tags).toBeUndefined();
    }
  });

  it("accepts valid full request", () => {
    const result = validateCreateMemoryRequest({
      content: "Full memory",
      type: "fact",
      tags: ["tag1", "tag2"],
      entities: ["entity1"],
      conversationId: "conv-123",
      messageId: "msg-456",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("Full memory");
      expect(result.value.type).toBe("fact");
      expect(result.value.tags).toEqual(["tag1", "tag2"]);
      expect(result.value.entities).toEqual(["entity1"]);
      expect(result.value.conversationId).toBe("conv-123");
      expect(result.value.messageId).toBe("msg-456");
    }
  });

  it("rejects non-object body", () => {
    const result = validateCreateMemoryRequest("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("JSON object");
    }
  });

  it("rejects missing content", () => {
    const result = validateCreateMemoryRequest({ type: "fact" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("content");
    }
  });

  it("rejects empty content", () => {
    const result = validateCreateMemoryRequest({ content: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("content");
    }
  });

  it("rejects invalid type", () => {
    const result = validateCreateMemoryRequest({ content: "test", type: "invalid_type" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("type");
    }
  });

  it("rejects non-string-array tags", () => {
    const result = validateCreateMemoryRequest({ content: "test", tags: [1, 2, 3] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("tags");
    }
  });

  it("rejects non-string-array entities", () => {
    const result = validateCreateMemoryRequest({ content: "test", entities: "not-array" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("entities");
    }
  });

  it("rejects non-string conversationId", () => {
    const result = validateCreateMemoryRequest({ content: "test", conversationId: 123 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("conversationId");
    }
  });

  it("rejects non-string messageId", () => {
    const result = validateCreateMemoryRequest({ content: "test", messageId: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("messageId");
    }
  });
});

describe("validateUpdateMemoryRequest", () => {
  it("accepts valid content update", () => {
    const result = validateUpdateMemoryRequest({ content: "Updated" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("Updated");
    }
  });

  it("accepts valid importance update", () => {
    const result = validateUpdateMemoryRequest({ importance: 0.8 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.importance).toBe(0.8);
    }
  });

  it("accepts valid confidence update", () => {
    const result = validateUpdateMemoryRequest({ confidence: 0.5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.confidence).toBe(0.5);
    }
  });

  it("accepts valid tags update", () => {
    const result = validateUpdateMemoryRequest({ tags: ["new-tag"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tags).toEqual(["new-tag"]);
    }
  });

  it("accepts multiple fields", () => {
    const result = validateUpdateMemoryRequest({
      content: "Updated",
      importance: 0.9,
      tags: ["a", "b"],
      entities: ["e1"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("Updated");
      expect(result.value.importance).toBe(0.9);
      expect(result.value.tags).toEqual(["a", "b"]);
      expect(result.value.entities).toEqual(["e1"]);
    }
  });

  it("rejects empty update (no fields)", () => {
    const result = validateUpdateMemoryRequest({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("At least one field");
    }
  });

  it("rejects non-object body", () => {
    const result = validateUpdateMemoryRequest(null);
    expect(result.ok).toBe(false);
  });

  it("rejects importance out of range (> 1)", () => {
    const result = validateUpdateMemoryRequest({ importance: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("importance");
    }
  });

  it("rejects importance out of range (< 0)", () => {
    const result = validateUpdateMemoryRequest({ importance: -0.1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("importance");
    }
  });

  it("rejects confidence out of range", () => {
    const result = validateUpdateMemoryRequest({ confidence: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("confidence");
    }
  });

  it("rejects non-string content", () => {
    const result = validateUpdateMemoryRequest({ content: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("content");
    }
  });

  it("rejects non-string-array tags", () => {
    const result = validateUpdateMemoryRequest({ tags: "not-array" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("tags");
    }
  });
});

describe("validateSearchMemoryRequest", () => {
  it("accepts empty object (all optional)", () => {
    const result = validateSearchMemoryRequest({});
    expect(result.ok).toBe(true);
  });

  it("accepts valid query", () => {
    const result = validateSearchMemoryRequest({ query: "find this" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.query).toBe("find this");
    }
  });

  it("trims query whitespace", () => {
    const result = validateSearchMemoryRequest({ query: "  padded  " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.query).toBe("padded");
    }
  });

  it("accepts valid type filter", () => {
    const result = validateSearchMemoryRequest({ type: "preference" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe("preference");
    }
  });

  it("accepts valid layer filter", () => {
    const result = validateSearchMemoryRequest({ layer: "stm" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.layer).toBe("stm");
    }
  });

  it("accepts valid limit", () => {
    const result = validateSearchMemoryRequest({ limit: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.limit).toBe(10);
    }
  });

  it("rejects non-object body", () => {
    const result = validateSearchMemoryRequest([1, 2, 3]);
    expect(result.ok).toBe(false);
  });

  it("rejects non-string query", () => {
    const result = validateSearchMemoryRequest({ query: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("query");
    }
  });

  it("rejects invalid type", () => {
    const result = validateSearchMemoryRequest({ type: "bogus" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("type");
    }
  });

  it("rejects invalid layer", () => {
    const result = validateSearchMemoryRequest({ layer: "working" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("layer");
    }
  });

  it("rejects non-positive limit", () => {
    const result = validateSearchMemoryRequest({ limit: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("limit");
    }
  });

  it("rejects non-integer limit", () => {
    const result = validateSearchMemoryRequest({ limit: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("limit");
    }
  });
});

describe("parseListMemoryQueryParams", () => {
  it("returns empty params for no query string", () => {
    const url = new URL("http://localhost/api/memory");
    const params = parseListMemoryQueryParams(url);
    expect(params.type).toBeUndefined();
    expect(params.layer).toBeUndefined();
    expect(params.limit).toBeUndefined();
    expect(params.offset).toBeUndefined();
    expect(params.sortBy).toBeUndefined();
    expect(params.sortOrder).toBeUndefined();
  });

  it("parses valid type", () => {
    const url = new URL("http://localhost/api/memory?type=fact");
    const params = parseListMemoryQueryParams(url);
    expect(params.type).toBe("fact");
  });

  it("ignores invalid type", () => {
    const url = new URL("http://localhost/api/memory?type=bogus");
    const params = parseListMemoryQueryParams(url);
    expect(params.type).toBeUndefined();
  });

  it("parses valid layer", () => {
    const url = new URL("http://localhost/api/memory?layer=ltm");
    const params = parseListMemoryQueryParams(url);
    expect(params.layer).toBe("ltm");
  });

  it("ignores invalid layer", () => {
    const url = new URL("http://localhost/api/memory?layer=working");
    const params = parseListMemoryQueryParams(url);
    expect(params.layer).toBeUndefined();
  });

  it("parses valid limit and offset", () => {
    const url = new URL("http://localhost/api/memory?limit=10&offset=5");
    const params = parseListMemoryQueryParams(url);
    expect(params.limit).toBe(10);
    expect(params.offset).toBe(5);
  });

  it("ignores non-numeric limit", () => {
    const url = new URL("http://localhost/api/memory?limit=abc");
    const params = parseListMemoryQueryParams(url);
    expect(params.limit).toBeUndefined();
  });

  it("ignores negative limit", () => {
    const url = new URL("http://localhost/api/memory?limit=-5");
    const params = parseListMemoryQueryParams(url);
    expect(params.limit).toBeUndefined();
  });

  it("parses valid sortBy and sortOrder", () => {
    const url = new URL("http://localhost/api/memory?sortBy=importance&sortOrder=asc");
    const params = parseListMemoryQueryParams(url);
    expect(params.sortBy).toBe("importance");
    expect(params.sortOrder).toBe("asc");
  });

  it("ignores invalid sortBy", () => {
    const url = new URL("http://localhost/api/memory?sortBy=name");
    const params = parseListMemoryQueryParams(url);
    expect(params.sortBy).toBeUndefined();
  });

  it("ignores invalid sortOrder", () => {
    const url = new URL("http://localhost/api/memory?sortOrder=random");
    const params = parseListMemoryQueryParams(url);
    expect(params.sortOrder).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HTTP-level validation tests (through the server)
// ---------------------------------------------------------------------------

describe("DaemonHttpServer memory route validation", () => {
  const servers: DaemonHttpServer[] = [];
  let testPort = 19433;

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;
  });

  it("rejects create with invalid type field", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    await server.start();
    servers.push(server);

    const response = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test", type: "not_a_real_type" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("type");
  });

  it("rejects create with non-string-array tags", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    await server.start();
    servers.push(server);

    const response = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test", tags: [1, 2, 3] }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("tags");
  });

  it("rejects update with empty body (no fields)", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    await server.start();
    servers.push(server);

    // Create a memory first
    const createResponse = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test memory" }),
    });
    const created = await createResponse.json();

    const response = await fetch(`http://localhost:${port}/api/memory/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("At least one field");
  });

  it("rejects update with out-of-range importance", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    await server.start();
    servers.push(server);

    const createResponse = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test memory" }),
    });
    const created = await createResponse.json();

    const response = await fetch(`http://localhost:${port}/api/memory/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ importance: 1.5 }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("importance");
  });

  it("rejects search with invalid type filter", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    await server.start();
    servers.push(server);

    const response = await fetch(`http://localhost:${port}/api/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test", type: "bogus" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("type");
  });

  it("rejects search with invalid layer filter", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    await server.start();
    servers.push(server);

    const response = await fetch(`http://localhost:${port}/api/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test", layer: "working" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("layer");
  });

  it("rejects search with non-positive limit", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    await server.start();
    servers.push(server);

    const response = await fetch(`http://localhost:${port}/api/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test", limit: 0 }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("limit");
  });

  it("rejects create with non-JSON body", async () => {
    const port = testPort++;
    const server = await createTestServer(port);
    await server.start();
    servers.push(server);

    const response = await fetch(`http://localhost:${port}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Invalid JSON");
  });
});

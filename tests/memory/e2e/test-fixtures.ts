import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BM25Retriever } from "../../../src/memory/search/index";
import { MemoryService } from "../../../src/memory/services";
import {
  SqliteMemoryDb,
  SqliteMemoryRepository,
  type CreateMemoryInput,
} from "../../../src/memory/storage";

export interface MemoryStoragePaths {
  rootDir: string;
  dbPath: string;
  dataDir: string;
}

export interface MemoryRuntime {
  db: SqliteMemoryDb;
  repository: SqliteMemoryRepository;
  service: MemoryService;
  bm25: BM25Retriever;
}

export function createDeterministicMemoryInputs(
  conversationId = "restart-session-a",
): CreateMemoryInput[] {
  return [
    {
      content:
        "RESTART-E2E-FACT: User laptop serial ZX-2048 is assigned to analytics workstation.",
      type: "fact",
      layer: "stm",
      importance: 0.71,
      confidence: 0.96,
      tags: ["restart", "fixture", "fact"],
      entities: ["device:laptop", "team:analytics"],
      source: {
        type: "explicit",
        conversationId,
        messageId: "session-a-fact",
      },
    },
    {
      content:
        "RESTART-E2E-PREFERENCE: User prefers concise architecture diffs with concrete migration notes.",
      type: "preference",
      layer: "ltm",
      importance: 0.84,
      confidence: 0.9,
      tags: ["restart", "fixture", "preference"],
      entities: ["style:concise", "topic:migrations"],
      source: {
        type: "implicit",
        conversationId,
        messageId: "session-a-preference",
      },
    },
    {
      content:
        "RESTART-E2E-DECISION: Team selected Bun runtime for daemon memory workflows in release train R8.",
      type: "decision",
      layer: "stm",
      importance: 0.93,
      confidence: 0.98,
      tags: ["restart", "fixture", "decision"],
      entities: ["runtime:bun", "release:r8"],
      source: {
        type: "explicit",
        conversationId,
        messageId: "session-a-decision",
      },
    },
  ];
}

export async function createIsolatedMemoryStorage(
  prefix = "reins-memory-restart-e2e-",
): Promise<MemoryStoragePaths> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  const dbPath = join(rootDir, "memory.db");
  const dataDir = join(rootDir, "memory-files");

  await mkdir(dataDir, { recursive: true });

  return {
    rootDir,
    dbPath,
    dataDir,
  };
}

export async function createMemoryRuntime(
  storage: MemoryStoragePaths,
): Promise<MemoryRuntime> {
  const db = new SqliteMemoryDb({ dbPath: storage.dbPath });
  const initResult = db.initialize();
  if (!initResult.ok) {
    throw initResult.error;
  }

  const repository = new SqliteMemoryRepository({
    db,
    dataDir: storage.dataDir,
  });

  const service = new MemoryService({ repository });
  const serviceInit = await service.initialize();
  if (!serviceInit.ok) {
    db.close();
    throw serviceInit.error;
  }

  const bm25 = new BM25Retriever({ db });

  return {
    db,
    repository,
    service,
    bm25,
  };
}

export async function closeMemoryRuntime(runtime: MemoryRuntime): Promise<void> {
  await runtime.service.shutdown();
  runtime.db.close();
}

export async function cleanupIsolatedMemoryStorage(
  storage: MemoryStoragePaths,
): Promise<void> {
  await rm(storage.rootDir, { recursive: true, force: true });
}

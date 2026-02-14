#!/usr/bin/env bun

/**
 * Daemon entry point - starts HTTP server and managed services.
 */

import { DaemonRuntime } from "./runtime";
import { DaemonHttpServer } from "./server";
import { getBuiltinToolDefinitions } from "../tools/builtins";
import { MemoryDaemonService } from "./memory-daemon-service";
import { getDataRoot } from "./paths";
import { DaemonError } from "./types";
import { err, ok, type Result } from "../result";
import { join } from "node:path";
import { MemoryError, type MemoryServiceContract } from "../memory/services";
import { MemoryService } from "../memory/services/memory-service";
import { SqliteMemoryDb, SqliteMemoryRepository } from "../memory/storage";

interface InitializedMemoryRuntime {
  memoryService: MemoryServiceContract;
  checkStorageHealth: () => Promise<Result<boolean, MemoryError>>;
  closeStorage: () => Promise<Result<void, MemoryError>>;
}

function initializeMemoryRuntime(dbPath: string, dataDir: string): Result<InitializedMemoryRuntime, DaemonError> {
  const db = new SqliteMemoryDb({ dbPath });
  const initializeResult = db.initialize();
  if (!initializeResult.ok) {
    return err(new DaemonError("Failed to initialize memory SQLite storage", initializeResult.error.code, initializeResult.error));
  }

  try {
    const repository = new SqliteMemoryRepository({
      db,
      dataDir,
    });

    const memoryService = new MemoryService({
      repository,
      logger: {
        info: (message) => {
          console.info(`[memory] ${message}`);
        },
        warn: (message) => {
          console.warn(`[memory] ${message}`);
        },
        error: (message) => {
          console.error(`[memory] ${message}`);
        },
      },
    });

    return ok({
      memoryService,
      checkStorageHealth: async () => {
        try {
          db.getDb().query("SELECT 1").get();
          return ok(true);
        } catch (error) {
          return err(
            new MemoryError(
              "Failed to verify memory SQLite connectivity",
              "MEMORY_DB_ERROR",
              error instanceof Error ? error : undefined,
            ),
          );
        }
      },
      closeStorage: async () => {
        try {
          db.close();
          return ok(undefined);
        } catch (error) {
          return err(
            new MemoryError(
              "Failed to close memory SQLite storage",
              "MEMORY_SHUTDOWN_FAILED",
              error instanceof Error ? error : undefined,
            ),
          );
        }
      },
    });
  } catch (error) {
    db.close();
    return err(new DaemonError("Failed to initialize memory runtime", "DAEMON_MEMORY_INIT_FAILED", error instanceof Error ? error : undefined));
  }
}

async function main() {
  const runtime = new DaemonRuntime();
  const httpServer = new DaemonHttpServer({
    toolDefinitions: getBuiltinToolDefinitions(),
  });
  const dataRoot = getDataRoot();
  const memoryDataDir = join(dataRoot, "memory");
  const memoryDbPath = join(memoryDataDir, "memory.db");

  const memoryRuntimeResult = initializeMemoryRuntime(memoryDbPath, memoryDataDir);
  if (!memoryRuntimeResult.ok) {
    console.error("Failed to initialize memory runtime:", memoryRuntimeResult.error.message);
    process.exit(1);
  }

  const memoryRuntime = memoryRuntimeResult.value;

  const memoryService = new MemoryDaemonService({
    dbPath: memoryDbPath,
    dataDir: memoryDataDir,
    memoryService: memoryRuntime.memoryService,
    checkStorageHealth: memoryRuntime.checkStorageHealth,
    closeStorage: memoryRuntime.closeStorage,
  });

  // Register HTTP server as managed service
  const httpRegistration = runtime.registerService(httpServer);
  if (!httpRegistration.ok) {
    console.error("Failed to register HTTP service:", httpRegistration.error.message);
    process.exit(1);
  }

  const memoryRegistration = runtime.registerService(memoryService);
  if (!memoryRegistration.ok) {
    console.error("Failed to register memory service:", memoryRegistration.error.message);
    process.exit(1);
  }

  // Start daemon (starts all registered services)
  const startResult = await runtime.start();
  if (!startResult.ok) {
    console.error("Failed to start daemon:", startResult.error.message);
    process.exit(1);
  }

  console.log("Daemon started successfully");

  // Handle shutdown signals
  process.on("SIGTERM", async () => {
    console.log("Received SIGTERM, shutting down...");
    await runtime.stop({ signal: "SIGTERM" });
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("Received SIGINT, shutting down...");
    await runtime.stop({ signal: "SIGINT" });
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal daemon error:", error);
  process.exit(1);
});

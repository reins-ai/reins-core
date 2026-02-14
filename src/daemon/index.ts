#!/usr/bin/env bun

/**
 * Daemon entry point - starts HTTP server and managed services.
 */

import { DaemonRuntime } from "./runtime";
import { DaemonHttpServer } from "./server";
import { getBuiltinToolDefinitions } from "../tools/builtins";
import { MemoryDaemonService } from "./memory-daemon-service";
import { getDataRoot } from "./paths";
import { ok } from "../result";
import { join } from "node:path";
import type { MemoryServiceContract } from "../memory/services";

async function main() {
  const runtime = new DaemonRuntime();
  const httpServer = new DaemonHttpServer({
    toolDefinitions: getBuiltinToolDefinitions(),
  });
  const dataRoot = getDataRoot();

  const memoryServiceContract: MemoryServiceContract = {
    initialize: async () => ok(undefined),
    shutdown: async () => ok(undefined),
    isReady: () => true,
    healthCheck: async () =>
      ok({
        dbConnected: true,
        memoryCount: 0,
      }),
  };
  const memoryService = new MemoryDaemonService({
    dbPath: join(dataRoot, "memory", "memory.db"),
    dataDir: join(dataRoot, "memory"),
    memoryService: memoryServiceContract,
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

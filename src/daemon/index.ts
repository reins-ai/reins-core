#!/usr/bin/env bun

/**
 * Daemon entry point - starts HTTP server and managed services.
 */

import { DaemonRuntime } from "./runtime";
import { DaemonHttpServer } from "./server";
import { getBuiltinToolDefinitions } from "../tools/builtins";

async function main() {
  const runtime = new DaemonRuntime();
  const httpServer = new DaemonHttpServer({
    toolDefinitions: getBuiltinToolDefinitions(),
  });

  // Register HTTP server as managed service
  runtime.registerService(httpServer);

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

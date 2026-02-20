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
import { MemoryError } from "../memory/services";
import { MemoryService } from "../memory/services/memory-service";
import { SqliteMemoryDb, SqliteMemoryRepository } from "../memory/storage";
import { MemoryConsolidationJob } from "../cron/jobs/memory-consolidation-job";
import { MorningBriefingJob } from "../cron/jobs/morning-briefing-job";
import { registerMemoryCronJobs, type MemoryCronHandle } from "./memory-cron-registration";
import { MemoryCapabilitiesResolver } from "./memory-capabilities";
import { bootstrapInstallRoot } from "../environment";
import { SkillDaemonService } from "../skills";
import { BrowserDaemonService } from "../browser/browser-daemon-service";
import { WatcherCronManager } from "../browser/watcher-cron-manager";
import { SnapshotEngine } from "../browser/snapshot";
import { ElementRefRegistry } from "../browser/element-ref-registry";
import {
  ConversationNotificationDelivery,
  type NotificationDelivery,
} from "../browser/conversation-notification-delivery";
import { CronScheduler } from "../cron/scheduler";
import { LocalCronStore } from "../cron/store";

interface InitializedMemoryRuntime {
  memoryService: MemoryService;
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

function createStubConsolidationJob(): MemoryConsolidationJob {
  const stubRunner = {
    run: async () => ok({
      runId: crypto.randomUUID(),
      timestamp: new Date(),
      stats: { candidatesProcessed: 0, factsDistilled: 0, created: 0, updated: 0, superseded: 0, skipped: 0 },
      mergeResult: null,
      errors: [],
      durationMs: 0,
    }),
  } as unknown as import("../memory/consolidation/consolidation-runner").ConsolidationRunner;

  return new MemoryConsolidationJob({
    runner: stubRunner,
    onComplete: (result) => {
      console.info(`[cron] Consolidation completed: ${result.stats.factsDistilled} facts distilled`);
    },
    onError: (error) => {
      console.error(`[cron] Consolidation failed: ${error.message}`);
    },
  });
}

function createStubBriefingJob(): MorningBriefingJob {
  const stubService = {
    generateBriefing: async () => ok({
      timestamp: new Date(),
      sections: [],
      totalItems: 0,
      generatedInMs: 0,
    }),
  } as unknown as import("../memory/proactive/morning-briefing-service").MorningBriefingService;

  return new MorningBriefingJob({
    service: stubService,
    onComplete: (briefing) => {
      console.info(`[cron] Morning briefing generated: ${briefing.totalItems} items`);
    },
    onError: (error) => {
      console.error(`[cron] Morning briefing failed: ${error.message}`);
    },
  });
}

async function main() {
  const runtime = new DaemonRuntime();

  const bootstrapResult = await bootstrapInstallRoot();
  if (!bootstrapResult.ok) {
    console.error("Failed to bootstrap install root:", bootstrapResult.error.message);
    process.exit(1);
  }

  const dataRoot = getDataRoot();
  const memoryDataDir = join(dataRoot, "memory");
  const memoryDbPath = join(memoryDataDir, "memory.db");

  const memoryRuntimeResult = initializeMemoryRuntime(memoryDbPath, memoryDataDir);
  if (!memoryRuntimeResult.ok) {
    console.error("Failed to initialize memory runtime:", memoryRuntimeResult.error.message);
    process.exit(1);
  }

  const memoryRuntime = memoryRuntimeResult.value;
  const memoryCapabilitiesResolver = new MemoryCapabilitiesResolver({ dataRoot });
  const configuredSkillsDir = process.env.REINS_SKILLS_DIR?.trim();
  const skillsDir = configuredSkillsDir && configuredSkillsDir.length > 0
    ? configuredSkillsDir
    : join(dataRoot, "skills");
  const skillService = new SkillDaemonService({
    skillsDir,
  });
  const conversationDbPath = join(dataRoot, "conversation.db");

  // ── Browser + Watcher stack ──────────────────────────────────────────────
  // BrowserDaemonService and WatcherCronManager have a mutual dependency:
  // each needs the other at construction time. We break the cycle by creating
  // BrowserDaemonService first, then calling setWatcherManager() afterwards.
  //
  // ConversationNotificationDelivery also has a dependency on ConversationManager
  // which is only available after httpServer.start(). We use a stable proxy
  // object captured in a closure to allow late initialization.

  const browserCronDir = join(dataRoot, "browser", "cron");
  const browserCronStore = new LocalCronStore(browserCronDir);

  // Container for the cron manager — populated below after construction.
  // The closure in onExecute safely reads it only at tick time (post-start).
  const watcherContainer: { cronManager: WatcherCronManager | undefined } = {
    cronManager: undefined,
  };
  const browserCronScheduler = new CronScheduler({
    store: browserCronStore,
    onExecute: async (job) => {
      await watcherContainer.cronManager?.handleCronExecution(job.id);
    },
  });

  // Lazy notification delivery — initialized after httpServer.start() once the
  // ConversationManager is available. Silently drops notifications until then.
  let conversationNotificationDelivery: ConversationNotificationDelivery | undefined;
  const lazyNotificationDelivery: NotificationDelivery = {
    async sendWatcherNotification(watcherId, url, diff) {
      return conversationNotificationDelivery?.sendWatcherNotification(watcherId, url, diff);
    },
  };

  const browserService = new BrowserDaemonService();
  const watcherElementRefRegistry = new ElementRefRegistry();
  const watcherSnapshotEngine = new SnapshotEngine(watcherElementRefRegistry);

  const watcherCronManager = new WatcherCronManager({
    snapshotEngine: watcherSnapshotEngine,
    browserService,
    cronScheduler: browserCronScheduler,
    notificationDelivery: lazyNotificationDelivery,
  });
  watcherContainer.cronManager = watcherCronManager;
  browserService.setWatcherManager(watcherCronManager);
  // ── End browser + watcher stack ──────────────────────────────────────────

  const httpServer = new DaemonHttpServer({
    toolDefinitions: getBuiltinToolDefinitions(),
    memoryService: memoryRuntime.memoryService,
    memoryCapabilitiesResolver,
    skillService,
    browserService,
    cronScheduler: browserCronScheduler,
    conversation: {
      sqliteStorePath: conversationDbPath,
    },
  });

  const memoryService = new MemoryDaemonService({
    dbPath: memoryDbPath,
    dataDir: memoryDataDir,
    memoryService: memoryRuntime.memoryService,
    checkStorageHealth: memoryRuntime.checkStorageHealth,
    closeStorage: memoryRuntime.closeStorage,
    capabilitiesResolver: memoryCapabilitiesResolver,
  });

  const browserRegistration = runtime.registerService(browserService);
  if (!browserRegistration.ok) {
    console.error("Failed to register browser service:", browserRegistration.error.message);
    process.exit(1);
  }

  const skillRegistration = runtime.registerService(skillService);
  if (!skillRegistration.ok) {
    console.error("Failed to register skill service:", skillRegistration.error.message);
    process.exit(1);
  }

  const memoryRegistration = runtime.registerService(memoryService);
  if (!memoryRegistration.ok) {
    console.error("Failed to register memory service:", memoryRegistration.error.message);
    process.exit(1);
  }

  // Register HTTP server after dependent managed services.
  const httpRegistration = runtime.registerService(httpServer);
  if (!httpRegistration.ok) {
    console.error("Failed to register HTTP service:", httpRegistration.error.message);
    process.exit(1);
  }

  // Start daemon (starts all registered services)
  const startResult = await runtime.start();
  if (!startResult.ok) {
    console.error("Failed to start daemon:", startResult.error.message);
    process.exit(1);
  }

  // Start the browser watcher cron scheduler now that all services are running.
  const schedulerStartResult = await browserCronScheduler.start();
  if (!schedulerStartResult.ok) {
    console.warn("Failed to start browser watcher cron scheduler:", schedulerStartResult.error.message);
  }

  // Wire up conversation notifications for watchers — the ConversationManager
  // is only available after httpServer has started.
  const conversationManager = httpServer.getConversationManager();
  if (conversationManager) {
    conversationNotificationDelivery = new ConversationNotificationDelivery(conversationManager);
  } else {
    console.warn("ConversationManager not available — watcher notifications will be suppressed");
  }

  // Register memory cron jobs after memory service is confirmed ready.
  // Consolidation and briefing runners use stub implementations until
  // the full pipeline (embedding provider, LLM) is configured in Wave 5.
  let cronHandle: MemoryCronHandle | undefined;
  if (memoryService.isReady()) {
    const cronResult = registerMemoryCronJobs({
      consolidationJob: createStubConsolidationJob(),
      briefingJob: createStubBriefingJob(),
      isMemoryReady: () => memoryService.isReady(),
    });

    if (cronResult.ok) {
      cronHandle = cronResult.value;
      console.log("Memory cron jobs registered successfully");
    } else {
      console.warn("Failed to register memory cron jobs:", cronResult.error.message);
    }
  } else {
    console.warn("Memory service not ready — skipping cron job registration");
  }

  console.log("Daemon started successfully");

  // Handle shutdown signals
  process.on("SIGTERM", async () => {
    console.log("Received SIGTERM, shutting down...");
    cronHandle?.stopAll();
    await browserCronScheduler.stop();
    await runtime.stop({ signal: "SIGTERM" });
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("Received SIGINT, shutting down...");
    cronHandle?.stopAll();
    await browserCronScheduler.stop();
    await runtime.stop({ signal: "SIGINT" });
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal daemon error:", error);
  process.exit(1);
});

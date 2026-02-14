import { describe, expect, it } from "bun:test";

import { MemoryDaemonService } from "../../../src/daemon/memory-daemon-service";
import { err, ok } from "../../../src/result";
import { MemoryError, type MemoryHealthStatus, type MemoryServiceContract } from "../../../src/memory/services";

function createMemoryServiceContract(overrides: Partial<MemoryServiceContract> = {}): MemoryServiceContract {
  return {
    initialize: async () => ok(undefined),
    shutdown: async () => ok(undefined),
    isReady: () => true,
    healthCheck: async () =>
      ok({
        dbConnected: true,
        memoryCount: 3,
      }),
    ...overrides,
  };
}

describe("MemoryDaemonService", () => {
  it("constructs with valid options", () => {
    const service = new MemoryDaemonService({
      dbPath: "/tmp/reins/memory.db",
      dataDir: "/tmp/reins/memory",
      memoryService: createMemoryServiceContract(),
    });

    expect(service.id).toBe("memory");
    expect(service.getState()).toBe("idle");
    expect(service.isReady()).toBe(false);
  });

  it("starts successfully with mocked initialization hooks", async () => {
    const callOrder: string[] = [];
    const service = new MemoryDaemonService({
      dbPath: "/tmp/reins/memory.db",
      dataDir: "/tmp/reins/memory",
      memoryService: createMemoryServiceContract({
        initialize: async () => {
          callOrder.push("service.initialize");
          return ok(undefined);
        },
      }),
      initializeStorage: async () => {
        callOrder.push("initializeStorage");
        return ok(undefined);
      },
      scanDataDirectory: async () => {
        callOrder.push("scanDataDirectory");
        return ok(5);
      },
    });

    const result = await service.start();

    expect(result.ok).toBe(true);
    expect(service.getState()).toBe("ready");
    expect(service.isReady()).toBe(true);
    expect(callOrder).toEqual(["initializeStorage", "scanDataDirectory", "service.initialize"]);
  });

  it("stops cleanly and runs shutdown hooks", async () => {
    const events: string[] = [];
    const service = new MemoryDaemonService({
      dbPath: "/tmp/reins/memory.db",
      dataDir: "/tmp/reins/memory",
      memoryService: createMemoryServiceContract({
        shutdown: async () => {
          events.push("shutdown");
          return ok(undefined);
        },
      }),
      flushPendingWrites: async () => {
        events.push("flush");
        return ok(undefined);
      },
      closeStorage: async () => {
        events.push("close");
        return ok(undefined);
      },
    });

    await service.start();
    const stopResult = await service.stop();

    expect(stopResult.ok).toBe(true);
    expect(service.getState()).toBe("stopped");
    expect(events).toEqual(["flush", "shutdown", "close"]);
  });

  it("closes storage even when shutdown steps fail", async () => {
    const events: string[] = [];
    const service = new MemoryDaemonService({
      dbPath: "/tmp/reins/memory.db",
      dataDir: "/tmp/reins/memory",
      memoryService: createMemoryServiceContract({
        shutdown: async () => {
          events.push("shutdown");
          return err(new MemoryError("shutdown failed", "MEMORY_SHUTDOWN_FAILED"));
        },
      }),
      flushPendingWrites: async () => {
        events.push("flush");
        return err(new MemoryError("flush failed", "MEMORY_SHUTDOWN_FAILED"));
      },
      closeStorage: async () => {
        events.push("close");
        return ok(undefined);
      },
    });

    await service.start();
    const stopResult = await service.stop();

    expect(stopResult.ok).toBe(false);
    if (!stopResult.ok) {
      expect(stopResult.error.code).toBe("MEMORY_SHUTDOWN_FAILED");
    }
    expect(service.getState()).toBe("error");
    expect(events).toEqual(["flush", "shutdown", "close"]);
  });

  it("enters error state when initialization fails", async () => {
    const service = new MemoryDaemonService({
      dbPath: "/tmp/reins/memory.db",
      dataDir: "/tmp/reins/memory",
      memoryService: createMemoryServiceContract(),
      initializeStorage: async () => err(new MemoryError("sqlite unavailable", "MEMORY_INIT_FAILED")),
    });

    const result = await service.start();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MEMORY_INIT_FAILED");
      expect(result.error.name).toBe("DaemonError");
      expect(result.error.cause).toBeInstanceOf(MemoryError);
    }
    expect(service.getState()).toBe("error");
  });

  it("refuses health checks while not ready", async () => {
    const service = new MemoryDaemonService({
      dbPath: "/tmp/reins/memory.db",
      dataDir: "/tmp/reins/memory",
      memoryService: createMemoryServiceContract(),
    });

    const health = await service.healthCheck();

    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.error.code).toBe("MEMORY_NOT_READY");
    }
  });

  it("returns health status from contract when ready", async () => {
    const status: MemoryHealthStatus = {
      dbConnected: true,
      memoryCount: 2,
      embeddingProvider: "openai",
      lastConsolidation: new Date("2026-02-13T00:00:00.000Z"),
    };

    const service = new MemoryDaemonService({
      dbPath: "/tmp/reins/memory.db",
      dataDir: "/tmp/reins/memory",
      embeddingProvider: "openai",
      memoryService: createMemoryServiceContract({
        healthCheck: async () => ok(status),
      }),
      scanDataDirectory: async () => ok(4),
    });

    await service.start();
    const health = await service.healthCheck();

    expect(health.ok).toBe(true);
    if (health.ok) {
      expect(health.value.dbConnected).toBe(true);
      expect(health.value.memoryCount).toBe(4);
      expect(health.value.embeddingProvider).toBe("openai");
      expect(health.value.lastConsolidation?.toISOString()).toBe("2026-02-13T00:00:00.000Z");
    }
  });

  it("includes storage connectivity in health status", async () => {
    const service = new MemoryDaemonService({
      dbPath: "/tmp/reins/memory.db",
      dataDir: "/tmp/reins/memory",
      memoryService: createMemoryServiceContract({
        healthCheck: async () =>
          ok({
            dbConnected: true,
            memoryCount: 2,
          }),
      }),
      checkStorageHealth: async () => ok(false),
    });

    await service.start();
    const health = await service.healthCheck();

    expect(health.ok).toBe(true);
    if (health.ok) {
      expect(health.value.dbConnected).toBe(false);
    }
  });

  it("tracks state transitions through start and stop", async () => {
    let sawStarting = false;
    let sawStopping = false;

    const service = new MemoryDaemonService({
      dbPath: "/tmp/reins/memory.db",
      dataDir: "/tmp/reins/memory",
      memoryService: createMemoryServiceContract(),
      initializeStorage: async () => {
        sawStarting = service.getState() === "starting";
        return ok(undefined);
      },
      flushPendingWrites: async () => {
        sawStopping = service.getState() === "stopping";
        return ok(undefined);
      },
    });

    expect(service.getState()).toBe("idle");
    await service.start();
    expect(sawStarting).toBe(true);
    expect(service.getState()).toBe("ready");

    await service.stop();
    expect(sawStopping).toBe(true);
    expect(service.getState()).toBe("stopped");
  });
});

import { describe, expect, it, mock } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { ok, err } from "../../../src/result";
import { MemoryFileSyncService } from "../../../src/memory/services/memory-file-sync";
import type { MemoryFileWatcher } from "../../../src/memory/io/memory-file-watcher";
import { MemoryWatcherError } from "../../../src/memory/io/memory-file-watcher";
import type { MemoryFileIngestor, ScanReport } from "../../../src/memory/io/memory-file-ingestor";
import { MemoryIngestError } from "../../../src/memory/io/memory-file-ingestor";
import type { MemoryEvent } from "../../../src/memory/types/memory-events";
import type { MemoryRecord } from "../../../src/memory/types/memory-record";

function createMockWatcher(overrides: Partial<MemoryFileWatcher> = {}): MemoryFileWatcher {
  return {
    isRunning: false,
    start: mock(() => Promise.resolve(ok(undefined))),
    stop: mock(() => Promise.resolve(ok(undefined))),
    rescan: mock(() => Promise.resolve(ok({
      totalFiles: 0,
      ingested: 0,
      updated: 0,
      skipped: 0,
      quarantined: 0,
      errors: [],
    }))),
    ...overrides,
  } as unknown as MemoryFileWatcher;
}

function createMockIngestor(overrides: Partial<MemoryFileIngestor> = {}): MemoryFileIngestor {
  return {
    ingestFile: mock(() => Promise.resolve(ok({ action: "created" as const, memoryId: "test-id" }))),
    handleDeletion: mock(() => Promise.resolve(ok(undefined))),
    scanDirectory: mock(() => Promise.resolve(ok({
      totalFiles: 0,
      ingested: 0,
      updated: 0,
      skipped: 0,
      quarantined: 0,
      errors: [],
    } satisfies ScanReport))),
    ...overrides,
  } as unknown as MemoryFileIngestor;
}

function createMockRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date();
  return {
    id: "mem-test-001",
    content: "Test memory content",
    type: "fact",
    layer: "ltm",
    tags: ["test"],
    entities: [],
    importance: 0.7,
    confidence: 0.9,
    provenance: { sourceType: "explicit", conversationId: "conv-1" },
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
    ...overrides,
  };
}

function createSilentLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

describe("MemoryFileSyncService", () => {
  it("starts and stops cleanly", async () => {
    const watcher = createMockWatcher();
    const ingestor = createMockIngestor();
    const logger = createSilentLogger();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      memoriesDir: "/tmp/reins-test-memories-start-stop",
      logger,
    });

    expect(service.isRunning).toBe(false);

    const startResult = await service.start();
    expect(startResult.ok).toBe(true);
    expect(service.isRunning).toBe(true);

    const stopResult = await service.stop();
    expect(stopResult.ok).toBe(true);
    expect(service.isRunning).toBe(false);
  });

  it("calls ingestor.scanDirectory with the correct path on start", async () => {
    const ingestor = createMockIngestor();
    const watcher = createMockWatcher();
    const memoriesDir = "/tmp/reins-test-memories-scan";

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      memoriesDir,
    });

    await service.start();

    expect(ingestor.scanDirectory).toHaveBeenCalledWith(memoriesDir);
  });

  it("calls watcher.start() on start", async () => {
    const watcher = createMockWatcher();
    const ingestor = createMockIngestor();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      memoriesDir: "/tmp/reins-test-memories-watcher-start",
    });

    await service.start();

    expect(watcher.start).toHaveBeenCalled();
  });

  it("calls watcher.stop() on stop", async () => {
    const watcher = createMockWatcher();
    const ingestor = createMockIngestor();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      memoriesDir: "/tmp/reins-test-memories-watcher-stop",
    });

    await service.start();
    await service.stop();

    expect(watcher.stop).toHaveBeenCalled();
  });

  it("defaults memoriesDir to ~/.reins/environments/default/memories/", () => {
    const watcher = createMockWatcher();
    const ingestor = createMockIngestor();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
    });

    const expected = join(homedir(), ".reins", "environments", "default", "memories");
    expect(service.dir).toBe(expected);
  });

  it("handles ingestor scanDirectory errors gracefully without throwing", async () => {
    const ingestor = createMockIngestor({
      scanDirectory: mock(() =>
        Promise.resolve(err(new MemoryIngestError("scan failed"))),
      ),
    });
    const watcher = createMockWatcher();
    const logger = createSilentLogger();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      memoriesDir: "/tmp/reins-test-memories-ingest-error",
      logger,
    });

    const result = await service.start();

    // Service should still start even if initial ingestion fails
    expect(result.ok).toBe(true);
    expect(service.isRunning).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns error when watcher.start() fails", async () => {
    const watcher = createMockWatcher({
      start: mock(() =>
        Promise.resolve(err(new MemoryWatcherError("watcher failed"))),
      ),
    });
    const ingestor = createMockIngestor();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      memoriesDir: "/tmp/reins-test-memories-watcher-fail",
    });

    const result = await service.start();

    expect(result.ok).toBe(false);
    expect(service.isRunning).toBe(false);
  });

  it("is idempotent on double start", async () => {
    const watcher = createMockWatcher();
    const ingestor = createMockIngestor();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      memoriesDir: "/tmp/reins-test-memories-double-start",
    });

    await service.start();
    const secondResult = await service.start();

    expect(secondResult.ok).toBe(true);
    // watcher.start should only be called once
    expect(watcher.start).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on double stop", async () => {
    const watcher = createMockWatcher();
    const ingestor = createMockIngestor();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      memoriesDir: "/tmp/reins-test-memories-double-stop",
    });

    const firstResult = await service.stop();
    expect(firstResult.ok).toBe(true);

    const secondResult = await service.stop();
    expect(secondResult.ok).toBe(true);
    // watcher.stop should not be called since service was never started
    expect(watcher.stop).toHaveBeenCalledTimes(0);
  });

  it("has id 'memory-file-sync'", () => {
    const watcher = createMockWatcher();
    const ingestor = createMockIngestor();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
    });

    expect(service.id).toBe("memory-file-sync");
  });

  it("handleMemoryEvent writes .md file for 'created' events", async () => {
    const watcher = createMockWatcher();
    const ingestor = createMockIngestor();
    const logger = createSilentLogger();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      memoriesDir: "/tmp/reins-test-memories-event-write",
      logger,
    });

    await service.start();

    const record = createMockRecord({ id: "mem-event-001" });
    const event: MemoryEvent = {
      type: "created",
      record,
      timestamp: new Date(),
    };

    // Should not throw
    await service.handleMemoryEvent(event);

    expect(logger.info).toHaveBeenCalled();
  });

  it("handleMemoryEvent ignores 'updated' and 'deleted' events", async () => {
    const watcher = createMockWatcher();
    const ingestor = createMockIngestor();
    const logger = createSilentLogger();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      memoriesDir: "/tmp/reins-test-memories-event-ignore",
      logger,
    });

    await service.start();

    const record = createMockRecord();

    const updatedEvent: MemoryEvent = {
      type: "updated",
      record,
      timestamp: new Date(),
    };

    const deletedEvent: MemoryEvent = {
      type: "deleted",
      record,
      timestamp: new Date(),
    };

    await service.handleMemoryEvent(updatedEvent);
    await service.handleMemoryEvent(deletedEvent);

    // Logger should only have start-related info calls, not write calls
    const infoCalls = (logger.info as ReturnType<typeof mock>).mock.calls;
    const writeLogCalls = infoCalls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("Wrote memory file"),
    );
    expect(writeLogCalls.length).toBe(0);
  });

  it("handleMemoryEvent logs error when file write fails", async () => {
    const watcher = createMockWatcher();
    const ingestor = createMockIngestor();
    const logger = createSilentLogger();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      // Use an invalid directory to trigger write failure
      memoriesDir: "/nonexistent/path/that/should/fail",
      logger,
    });

    const record = createMockRecord({ id: "mem-fail-001" });
    const event: MemoryEvent = {
      type: "created",
      record,
      timestamp: new Date(),
    };

    // Should not throw, but should log error
    await service.handleMemoryEvent(event);

    expect(logger.error).toHaveBeenCalled();
  });

  it("returns error when watcher.stop() fails", async () => {
    const watcher = createMockWatcher({
      stop: mock(() =>
        Promise.resolve(err(new MemoryWatcherError("stop failed"))),
      ),
    });
    const ingestor = createMockIngestor();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      memoriesDir: "/tmp/reins-test-memories-stop-fail",
    });

    await service.start();
    const result = await service.stop();

    expect(result.ok).toBe(false);
  });

  it("handles ingestor scanDirectory throwing unexpectedly", async () => {
    const ingestor = createMockIngestor({
      scanDirectory: mock(() => {
        throw new Error("unexpected crash");
      }),
    });
    const watcher = createMockWatcher();
    const logger = createSilentLogger();

    const service = new MemoryFileSyncService({
      watcher,
      ingestor,
      memoriesDir: "/tmp/reins-test-memories-ingest-throw",
      logger,
    });

    const result = await service.start();

    // Service should still start even if ingestion throws
    expect(result.ok).toBe(true);
    expect(service.isRunning).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});

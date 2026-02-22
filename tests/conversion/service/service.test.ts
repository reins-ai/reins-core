import { describe, expect, it } from "bun:test";

import { AgentStore } from "../../../src/agents/store";
import {
  ALL_CONVERSION_CATEGORIES,
  type ConversionCategory,
} from "../../../src/agents/types";
import { IdentityFileManager } from "../../../src/agents/identity";
import { AgentWorkspaceManager } from "../../../src/agents/workspace";
import { ImportLogWriter } from "../../../src/conversion/import-log";
import type { Conflict } from "../../../src/conversion/conflict";
import {
  ConversionService,
  type ConversionServiceOptions,
} from "../../../src/conversion/service";
import { ok, type Result } from "../../../src/result";
import type { KeychainProvider } from "../../../src/security/keychain-provider";
import type { SecurityError } from "../../../src/security/security-error";

type MapperResult = {
  converted: number;
  skipped: number;
  errors: Array<{ item: string; reason: string }>;
};

function createMockKeychainProvider(): KeychainProvider {
  return {
    async get(): Promise<Result<string | null, SecurityError>> {
      return ok(null);
    },
    async set(): Promise<Result<void, SecurityError>> {
      return ok(undefined);
    },
    async delete(): Promise<Result<void, SecurityError>> {
      return ok(undefined);
    },
  };
}

function createServiceOptions(
  runnerByCategory?: Partial<
    Record<ConversionCategory, (executionOrder: ConversionCategory[]) => MapperResult>
  >,
): ConversionServiceOptions {
  const executionOrder: ConversionCategory[] = [];

  const mapperRunners: Partial<
    Record<ConversionCategory, (options: { dryRun?: boolean }) => Promise<MapperResult>>
  > = {};

  for (const category of ALL_CONVERSION_CATEGORIES) {
    mapperRunners[category] = async () => {
      executionOrder.push(category);
      const runner = runnerByCategory?.[category];
      if (runner) {
        return runner(executionOrder);
      }

      return {
        converted: 1,
        skipped: 0,
        errors: [],
      };
    };
  }

  const options: ConversionServiceOptions = {
    keychainProvider: createMockKeychainProvider(),
    agentStore: new AgentStore({ filePath: "/tmp/reins-core-conversion-service-agents.json" }),
    workspaceManager: new AgentWorkspaceManager({ baseDir: "/tmp/reins-core-conversion-workspaces" }),
    identityManager: new IdentityFileManager(),
    importLogWriter: new ImportLogWriter({ outputPath: "/tmp/reins-core-conversion-import-log.md" }),
    mapperRunners,
  };

  return options;
}

describe("ConversionService", () => {
  it("returns nine category results when all categories are selected", async () => {
    const service = new ConversionService(createServiceOptions());

    const result = await service.convert({
      selectedCategories: [...ALL_CONVERSION_CATEGORIES],
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.categories).toHaveLength(9);
    expect(result.value.totalConverted).toBe(9);
    expect(result.value.totalSkipped).toBe(0);
    expect(result.value.totalErrors).toBe(0);
  });

  it("marks deselected categories with skippedReason", async () => {
    const selected: ConversionCategory[] = ["agents", "skills"];
    const service = new ConversionService(createServiceOptions());

    const result = await service.convert({
      selectedCategories: selected,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.categories).toHaveLength(9);

    for (const categoryResult of result.value.categories) {
      if (selected.includes(categoryResult.category)) {
        expect(categoryResult.skippedReason).toBeUndefined();
      } else {
        expect(categoryResult.skippedReason).toBe("not selected");
      }
    }
  });

  it("marks all categories as skipped when selectedCategories is empty", async () => {
    const service = new ConversionService(createServiceOptions());

    const result = await service.convert({
      selectedCategories: [],
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.categories).toHaveLength(9);
    for (const categoryResult of result.value.categories) {
      expect(categoryResult.skippedReason).toBe("not selected");
      expect(categoryResult.converted).toBe(0);
      expect(categoryResult.errors).toHaveLength(0);
    }
  });

  it("emits progress events for selected categories", async () => {
    const service = new ConversionService(createServiceOptions());
    const events: Array<{ category: ConversionCategory; status: string }> = [];

    const result = await service.convert({
      selectedCategories: ["agents", "skills"],
      onProgress: (event) => {
        events.push({
          category: event.category,
          status: event.status,
        });
      },
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual([
      { category: "agents", status: "started" },
      { category: "agents", status: "complete" },
      { category: "skills", status: "started" },
      { category: "skills", status: "complete" },
    ]);
  });

  it("supports start and stop lifecycle", async () => {
    const service = new ConversionService(createServiceOptions());

    expect(service.isRunning()).toBe(false);
    await service.start();
    expect(service.isRunning()).toBe(true);
    await service.stop();
    expect(service.isRunning()).toBe(false);
  });

  it("detects conflicts, invokes onConflict per item, and records resolutions", async () => {
    const conflicts: Conflict[] = [
      {
        category: "agents",
        itemName: "assistant",
        existingValue: { id: "existing" },
        incomingValue: { id: "incoming" },
        path: "agents",
      },
      {
        category: "auth-profiles",
        itemName: "anthropic",
        existingValue: "[keychain:reins-byok/anthropic]",
        incomingValue: { provider: "anthropic" },
        path: "keychain/reins-byok/anthropic",
      },
    ];

    const seenPlan: Array<{ agents?: number; providerKeys?: number; channels?: number }> = [];
    const seenCallbacks: string[] = [];

    const service = new ConversionService({
      ...createServiceOptions(),
      conflictDetector: {
        async detect(plan) {
          seenPlan.push({
            agents: plan.agents?.length,
            providerKeys: plan.providerKeys?.length,
            channels: plan.channels?.length,
          });
          return conflicts;
        },
      },
      conflictResolver: {
        resolve(conflict, strategy) {
          return {
            conflict,
            strategy,
            outcome: strategy === "skip" ? "skipped" : "applied",
          };
        },
      },
    });

    const result = await service.convert({
      selectedCategories: [...ALL_CONVERSION_CATEGORIES],
      dryRun: true,
      onConflict: async (conflict) => {
        seenCallbacks.push(conflict.itemName);
        return conflict.category === "agents" ? "merge" : "skip";
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(seenPlan).toHaveLength(1);
    expect(seenCallbacks).toEqual(["assistant", "anthropic"]);
    expect(result.value.conflicts).toBeDefined();
    expect(result.value.conflicts).toHaveLength(2);
    expect(result.value.conflicts?.map((record) => record.strategy)).toEqual(["merge", "skip"]);
  });

  it("wires mapper onProgress callback through conversion progress events", async () => {
    const events: Array<{ category: ConversionCategory; status: string; processed: number }> = [];

    const service = new ConversionService({
      ...createServiceOptions({
        agents: () => ({
          converted: 1,
          skipped: 0,
          errors: [],
        }),
      }),
      progressEmitter: {
        emit(event) {
          events.push({
            category: event.category,
            status: event.status,
            processed: event.processed,
          });
        },
        emitThrottled(event) {
          events.push({
            category: event.category,
            status: event.status,
            processed: event.processed,
          });
        },
      },
      mapperRunners: {
        agents: async (options) => {
          options.onProgress?.(1, 3);
          options.onProgress?.(2, 3);
          return { converted: 1, skipped: 0, errors: [] };
        },
      },
    });

    const result = await service.convert({
      selectedCategories: ["agents"],
      dryRun: true,
      onProgress: (event) => {
        events.push({
          category: event.category,
          status: event.status,
          processed: event.processed,
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(events.some((event) => event.status === "progress")).toBe(true);
  });
});

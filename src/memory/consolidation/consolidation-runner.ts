import { randomUUID } from "node:crypto";

import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type { MemoryRecord } from "../types/index";
import type { DistilledFact } from "./distillation-schema";
import type { DistillationEngine } from "./distillation-engine";
import type { MergeEngine, MergeResult } from "./merge-engine";
import type { StmSelector } from "./stm-selector";

export interface RetryPolicy {
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseBackoffMs: 1_000,
  maxBackoffMs: 30_000,
};

export interface ConsolidationRunConfig {
  retryPolicy: RetryPolicy;
  now: () => Date;
  generateRunId: () => string;
}

export const DEFAULT_CONSOLIDATION_RUN_CONFIG: Omit<ConsolidationRunConfig, "now" | "generateRunId"> = {
  retryPolicy: DEFAULT_RETRY_POLICY,
};

export interface ConsolidationRunStats {
  candidatesProcessed: number;
  factsDistilled: number;
  created: number;
  updated: number;
  superseded: number;
  skipped: number;
}

export interface ConsolidationRunResult {
  runId: string;
  timestamp: Date;
  stats: ConsolidationRunStats;
  mergeResult: MergeResult | null;
  errors: string[];
  durationMs: number;
}

export interface LtmWriter {
  write(records: MemoryRecord[]): Promise<Result<void, ReinsError>>;
  getExisting(facts: DistilledFact[]): Promise<Result<MemoryRecord[], ReinsError>>;
}

export class ConsolidationRunnerError extends ReinsError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = "ConsolidationRunnerError";
  }
}

export interface ConsolidationRunnerOptions {
  selector: StmSelector;
  distillationEngine: DistillationEngine;
  mergeEngine: MergeEngine;
  ltmWriter: LtmWriter;
  config?: Partial<ConsolidationRunConfig>;
}

export class ConsolidationRunner {
  private readonly selector: StmSelector;
  private readonly distillationEngine: DistillationEngine;
  private readonly mergeEngine: MergeEngine;
  private readonly ltmWriter: LtmWriter;
  private readonly config: ConsolidationRunConfig;

  constructor(options: ConsolidationRunnerOptions) {
    this.selector = options.selector;
    this.distillationEngine = options.distillationEngine;
    this.mergeEngine = options.mergeEngine;
    this.ltmWriter = options.ltmWriter;
    this.config = {
      retryPolicy: options.config?.retryPolicy ?? DEFAULT_RETRY_POLICY,
      now: options.config?.now ?? (() => new Date()),
      generateRunId: options.config?.generateRunId ?? randomUUID,
    };
  }

  async run(): Promise<Result<ConsolidationRunResult, ConsolidationRunnerError>> {
    const startTime = this.config.now();
    const runId = this.config.generateRunId();
    const errors: string[] = [];

    const batchResult = await this.selector.selectBatch();
    if (!batchResult.ok) {
      return err(
        new ConsolidationRunnerError(
          "Failed to select STM batch for consolidation",
          "CONSOLIDATION_RUN_SELECT_FAILED",
          batchResult.error,
        ),
      );
    }

    const batch = batchResult.value;

    if (batch.candidates.length === 0) {
      return ok({
        runId,
        timestamp: startTime,
        stats: emptyStats(),
        mergeResult: null,
        errors: [],
        durationMs: elapsed(startTime, this.config.now()),
      });
    }

    const candidateIds = batch.candidates.map((c) => c.record.id);
    const markProcessingResult = this.selector.markProcessing(batch.batchId, candidateIds);
    if (!markProcessingResult.ok) {
      errors.push(`Failed to mark candidates as processing: ${markProcessingResult.error.message}`);
    }

    const distillResult = await this.retryAsync(
      () => this.distillationEngine.distill(batch),
      "distillation",
    );

    if (!distillResult.ok) {
      this.selector.markFailed(candidateIds);
      return err(
        new ConsolidationRunnerError(
          "Consolidation distillation failed after retries",
          "CONSOLIDATION_RUN_DISTILL_FAILED",
          distillResult.error,
        ),
      );
    }

    const distillation = distillResult.value;
    if (distillation.warnings.length > 0) {
      errors.push(...distillation.warnings);
    }

    if (distillation.failedCandidateIds.length > 0) {
      this.selector.markFailed(distillation.failedCandidateIds);
    }

    if (distillation.facts.length === 0) {
      const successfulIds = candidateIds.filter(
        (id) => !distillation.failedCandidateIds.includes(id),
      );
      if (successfulIds.length > 0) {
        this.selector.markConsolidated(successfulIds);
      }

      return ok({
        runId,
        timestamp: startTime,
        stats: {
          candidatesProcessed: batch.candidates.length,
          factsDistilled: 0,
          created: 0,
          updated: 0,
          superseded: 0,
          skipped: 0,
        },
        mergeResult: null,
        errors,
        durationMs: elapsed(startTime, this.config.now()),
      });
    }

    const existingResult = await this.ltmWriter.getExisting(distillation.facts);
    if (!existingResult.ok) {
      this.selector.markFailed(candidateIds);
      return err(
        new ConsolidationRunnerError(
          "Failed to fetch existing LTM records for merge",
          "CONSOLIDATION_RUN_LTM_FETCH_FAILED",
          existingResult.error,
        ),
      );
    }

    const mergeResult = this.mergeEngine.merge(distillation.facts, existingResult.value);
    if (!mergeResult.ok) {
      this.selector.markFailed(candidateIds);
      return err(
        new ConsolidationRunnerError(
          "Consolidation merge failed",
          "CONSOLIDATION_RUN_MERGE_FAILED",
          mergeResult.error,
        ),
      );
    }

    const recordsToWrite = collectWriteRecords(mergeResult.value);
    if (recordsToWrite.length > 0) {
      const writeResult = await this.retryAsync(
        () => this.ltmWriter.write(recordsToWrite),
        "ltm-write",
      );

      if (!writeResult.ok) {
        this.selector.markFailed(candidateIds);
        return err(
          new ConsolidationRunnerError(
            "Failed to persist LTM records after merge",
            "CONSOLIDATION_RUN_WRITE_FAILED",
            writeResult.error,
          ),
        );
      }
    }

    const successfulIds = candidateIds.filter(
      (id) => !distillation.failedCandidateIds.includes(id),
    );
    if (successfulIds.length > 0) {
      this.selector.markConsolidated(successfulIds);
    }

    return ok({
      runId,
      timestamp: startTime,
      stats: {
        candidatesProcessed: batch.candidates.length,
        factsDistilled: distillation.facts.length,
        created: mergeResult.value.created.length,
        updated: mergeResult.value.updated.length,
        superseded: mergeResult.value.superseded.length,
        skipped: mergeResult.value.skipped.length,
      },
      mergeResult: mergeResult.value,
      errors,
      durationMs: elapsed(startTime, this.config.now()),
    });
  }

  private async retryAsync<T, E extends ReinsError>(
    operation: () => Promise<Result<T, E>>,
    label: string,
  ): Promise<Result<T, ConsolidationRunnerError>> {
    const { maxRetries, baseBackoffMs, maxBackoffMs } = this.config.retryPolicy;
    let lastError: E | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const result = await operation();
      if (result.ok) {
        return ok(result.value);
      }

      lastError = result.error;

      if (attempt < maxRetries) {
        const backoff = Math.min(
          baseBackoffMs * Math.pow(2, attempt),
          maxBackoffMs,
        );
        await sleep(backoff);
      }
    }

    return err(
      new ConsolidationRunnerError(
        `${label} failed after ${maxRetries + 1} attempts`,
        "CONSOLIDATION_RUN_RETRY_EXHAUSTED",
        lastError,
      ),
    );
  }
}

function emptyStats(): ConsolidationRunStats {
  return {
    candidatesProcessed: 0,
    factsDistilled: 0,
    created: 0,
    updated: 0,
    superseded: 0,
    skipped: 0,
  };
}

function elapsed(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

function collectWriteRecords(mergeResult: MergeResult): MemoryRecord[] {
  const records: MemoryRecord[] = [];

  for (const created of mergeResult.created) {
    records.push(created.record);
  }

  for (const updated of mergeResult.updated) {
    records.push(updated.record);
  }

  for (const superseded of mergeResult.superseded) {
    records.push(superseded.record);
  }

  return records;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

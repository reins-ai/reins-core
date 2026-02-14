import { randomUUID } from "node:crypto";

import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type { MemoryRecord } from "../types/index";
import {
  DEFAULT_BATCH_CONFIG,
  type BatchConfig,
  type ConsolidationCandidate,
  type ConsolidationCandidateStatus,
  type StmBatch,
} from "./stm-queue";

export const CONSOLIDATION_ERROR_CODES = [
  "CONSOLIDATION_SELECTION_FAILED",
  "CONSOLIDATION_TRANSITION_INVALID",
] as const;

export type ConsolidationErrorCode = (typeof CONSOLIDATION_ERROR_CODES)[number];

export class ConsolidationError extends ReinsError {
  constructor(message: string, code: ConsolidationErrorCode, cause?: Error) {
    super(message, code, cause);
    this.name = "ConsolidationError";
  }
}

export interface StmRecordSource {
  listStmRecords(): Promise<Result<MemoryRecord[]>>;
}

export interface StmSelectorOptions {
  source: StmRecordSource;
  config?: Partial<BatchConfig>;
  now?: () => Date;
  generateId?: () => string;
}

export class StmSelector {
  private readonly source: StmRecordSource;
  private readonly config: BatchConfig;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly candidates: Map<string, ConsolidationCandidate>;

  constructor(options: StmSelectorOptions) {
    this.source = options.source;
    this.config = {
      batchSize: options.config?.batchSize ?? DEFAULT_BATCH_CONFIG.batchSize,
      dedupeWindowMs: options.config?.dedupeWindowMs ?? DEFAULT_BATCH_CONFIG.dedupeWindowMs,
      maxRetries: options.config?.maxRetries ?? DEFAULT_BATCH_CONFIG.maxRetries,
      minAgeMs: options.config?.minAgeMs ?? DEFAULT_BATCH_CONFIG.minAgeMs,
    };
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
    this.candidates = new Map();
  }

  async selectBatch(): Promise<Result<StmBatch, ConsolidationError>> {
    const listResult = await this.source.listStmRecords();
    if (!listResult.ok) {
      return err(
        new ConsolidationError(
          "Failed to list STM records for consolidation",
          "CONSOLIDATION_SELECTION_FAILED",
          listResult.error,
        ),
      );
    }

    const now = this.now();
    const cutoffAge = new Date(now.getTime() - this.config.minAgeMs);

    const eligible = listResult.value
      .filter((record) => record.layer === "stm")
      .filter((record) => !record.supersededBy)
      .filter((record) => record.createdAt <= cutoffAge)
      .filter((record) => !this.isInDedupeWindow(record.id, now))
      .filter((record) => !this.isExhaustedOrTerminal(record.id))
      .sort((a, b) => {
        const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
        if (timeDiff !== 0) {
          return timeDiff;
        }
        return a.id.localeCompare(b.id);
      })
      .slice(0, this.config.batchSize);

    const batchId = this.generateId();
    const candidates: ConsolidationCandidate[] = eligible.map((record) => {
      const existing = this.candidates.get(record.id);
      return {
        record,
        status: "eligible" as const,
        retryCount: existing?.retryCount ?? 0,
        lastAttemptAt: existing?.lastAttemptAt,
        batchId,
      };
    });

    for (const candidate of candidates) {
      this.candidates.set(candidate.record.id, candidate);
    }

    return ok({
      batchId,
      candidates,
      createdAt: now,
    });
  }

  markProcessing(batchId: string, candidateIds: string[]): Result<void, ConsolidationError> {
    return this.transitionCandidates(candidateIds, "processing", (candidate) => {
      if (candidate.status !== "eligible") {
        return false;
      }
      if (candidate.batchId !== batchId) {
        return false;
      }
      return true;
    });
  }

  markConsolidated(candidateIds: string[]): Result<void, ConsolidationError> {
    return this.transitionCandidates(candidateIds, "consolidated", (candidate) => {
      return candidate.status === "processing" || candidate.status === "consolidated";
    });
  }

  markFailed(candidateIds: string[]): Result<void, ConsolidationError> {
    const now = this.now();

    for (const id of candidateIds) {
      const candidate = this.candidates.get(id);
      if (!candidate) {
        continue;
      }

      if (candidate.status === "failed") {
        continue;
      }

      if (candidate.status !== "processing") {
        continue;
      }

      const nextRetryCount = candidate.retryCount + 1;
      const nextStatus: ConsolidationCandidateStatus =
        nextRetryCount >= this.config.maxRetries ? "skipped" : "failed";

      this.candidates.set(id, {
        ...candidate,
        status: nextStatus,
        retryCount: nextRetryCount,
        lastAttemptAt: now,
      });
    }

    return ok(undefined);
  }

  getCandidateStatus(id: string): ConsolidationCandidate | undefined {
    return this.candidates.get(id);
  }

  private isInDedupeWindow(recordId: string, now: Date): boolean {
    const candidate = this.candidates.get(recordId);
    if (!candidate) {
      return false;
    }

    if (candidate.status !== "consolidated" && candidate.status !== "failed") {
      return false;
    }

    if (!candidate.lastAttemptAt) {
      return false;
    }

    const elapsed = now.getTime() - candidate.lastAttemptAt.getTime();
    return elapsed < this.config.dedupeWindowMs;
  }

  private isExhaustedOrTerminal(recordId: string): boolean {
    const candidate = this.candidates.get(recordId);
    if (!candidate) {
      return false;
    }

    if (candidate.status === "consolidated") {
      return true;
    }

    if (candidate.status === "skipped") {
      return true;
    }

    if (candidate.status === "processing") {
      return true;
    }

    return false;
  }

  private transitionCandidates(
    candidateIds: string[],
    targetStatus: ConsolidationCandidateStatus,
    isValid: (candidate: ConsolidationCandidate) => boolean,
  ): Result<void, ConsolidationError> {
    const now = this.now();

    for (const id of candidateIds) {
      const candidate = this.candidates.get(id);
      if (!candidate) {
        continue;
      }

      if (candidate.status === targetStatus) {
        continue;
      }

      if (!isValid(candidate)) {
        continue;
      }

      this.candidates.set(id, {
        ...candidate,
        status: targetStatus,
        lastAttemptAt: now,
      });
    }

    return ok(undefined);
  }
}

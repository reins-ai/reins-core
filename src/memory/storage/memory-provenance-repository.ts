import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type { MemorySourceType } from "../types/memory-types";
import {
  validateProvenance,
  type ProvenanceFilter,
  type ProvenanceRecord,
} from "../types/provenance";

export class ProvenanceRepositoryError extends ReinsError {
  constructor(message: string, code = "PROVENANCE_REPOSITORY_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "ProvenanceRepositoryError";
  }
}

interface StoredProvenance {
  provenance: ProvenanceRecord;
  storedAt: string;
}

/**
 * Repository for storing and querying extended provenance metadata.
 *
 * Provides a logical layer for provenance-specific queries on top of
 * the existing memory storage. Uses in-memory Map storage since the
 * actual SQLite integration is handled by the dual-write memory-repository.
 */
export interface ProvenanceRepository {
  saveProvenance(memoryId: string, provenance: ProvenanceRecord): Promise<Result<void>>;
  getProvenance(memoryId: string): Promise<Result<ProvenanceRecord | null>>;
  findByFilter(filter: ProvenanceFilter): Promise<Result<string[]>>;
  findByConversation(conversationId: string): Promise<Result<string[]>>;
  findBySource(source: MemorySourceType): Promise<Result<string[]>>;
}

export interface MemoryProvenanceRepositoryOptions {
  now?: () => Date;
}

export class MemoryProvenanceRepository implements ProvenanceRepository {
  private readonly store = new Map<string, StoredProvenance>();
  private readonly now: () => Date;

  constructor(options?: MemoryProvenanceRepositoryOptions) {
    this.now = options?.now ?? (() => new Date());
  }

  async saveProvenance(
    memoryId: string,
    provenance: ProvenanceRecord,
  ): Promise<Result<void>> {
    if (!memoryId || typeof memoryId !== "string" || memoryId.trim().length === 0) {
      return err(
        new ProvenanceRepositoryError(
          "memoryId is required and must be a non-empty string",
          "PROVENANCE_REPOSITORY_INVALID_INPUT",
        ),
      );
    }

    const validation = validateProvenance(provenance);
    if (!validation.ok) {
      return err(
        new ProvenanceRepositoryError(
          `Provenance validation failed: ${validation.error.message}`,
          "PROVENANCE_REPOSITORY_VALIDATION_ERROR",
          validation.error,
        ),
      );
    }

    this.store.set(memoryId, {
      provenance: validation.value,
      storedAt: this.now().toISOString(),
    });

    return ok(undefined);
  }

  async getProvenance(memoryId: string): Promise<Result<ProvenanceRecord | null>> {
    if (!memoryId || typeof memoryId !== "string" || memoryId.trim().length === 0) {
      return err(
        new ProvenanceRepositoryError(
          "memoryId is required and must be a non-empty string",
          "PROVENANCE_REPOSITORY_INVALID_INPUT",
        ),
      );
    }

    const stored = this.store.get(memoryId);
    if (!stored) {
      return ok(null);
    }

    return ok(stored.provenance);
  }

  async findByFilter(filter: ProvenanceFilter): Promise<Result<string[]>> {
    const matchingIds: string[] = [];

    for (const [memoryId, stored] of this.store.entries()) {
      if (matchesFilter(stored.provenance, filter)) {
        matchingIds.push(memoryId);
      }
    }

    return ok(matchingIds);
  }

  async findByConversation(conversationId: string): Promise<Result<string[]>> {
    if (!conversationId || typeof conversationId !== "string" || conversationId.trim().length === 0) {
      return err(
        new ProvenanceRepositoryError(
          "conversationId is required and must be a non-empty string",
          "PROVENANCE_REPOSITORY_INVALID_INPUT",
        ),
      );
    }

    return this.findByFilter({ conversationId });
  }

  async findBySource(source: MemorySourceType): Promise<Result<string[]>> {
    return this.findByFilter({ source });
  }
}

function matchesFilter(provenance: ProvenanceRecord, filter: ProvenanceFilter): boolean {
  if (filter.source !== undefined) {
    const sources = Array.isArray(filter.source) ? filter.source : [filter.source];
    if (!sources.includes(provenance.source)) {
      return false;
    }
  }

  if (filter.conversationId !== undefined) {
    if (provenance.conversationId !== filter.conversationId) {
      return false;
    }
  }

  if (filter.extractionEvent !== undefined) {
    if (provenance.extractionEvent !== filter.extractionEvent) {
      return false;
    }
  }

  if (filter.after !== undefined) {
    if (provenance.extractedAt < filter.after) {
      return false;
    }
  }

  if (filter.before !== undefined) {
    if (provenance.extractedAt >= filter.before) {
      return false;
    }
  }

  return true;
}

import { ReinsError } from "../../errors";
import type { MemoryRecord } from "../types/index";

export const AUDIT_RUN_STATUSES = ["success", "partial", "failed"] as const;

export type AuditRunStatus = (typeof AUDIT_RUN_STATUSES)[number];

export const ROLLBACK_ACTIONS = ["create", "update", "supersede"] as const;

export type RollbackAction = (typeof ROLLBACK_ACTIONS)[number];

export interface AuditEntry {
  runId: string;
  timestamp: Date;
  durationMs: number;
  status: AuditRunStatus;
  candidateCount: number;
  candidateIds: string[];
  factsCreated: number;
  factsUpdated: number;
  factsSuperseded: number;
  factsSkipped: number;
  errors: string[];
}

export interface RollbackMarker {
  markerId: string;
  runId: string;
  action: RollbackAction;
  targetRecordId: string;
  previousState: MemoryRecord | null;
  newState: MemoryRecord;
  reversible: boolean;
}

export interface AuditQueryOptions {
  startDate?: Date;
  endDate?: Date;
  status?: AuditRunStatus;
  limit?: number;
}

export interface AuditSummary {
  totalRuns: number;
  successCount: number;
  partialCount: number;
  failedCount: number;
  successRate: number;
  averageDurationMs: number;
  totalFactsCreated: number;
  totalFactsUpdated: number;
  totalFactsSuperseded: number;
  totalFactsSkipped: number;
}

interface SerializedAuditEntry {
  runId: string;
  timestamp: string;
  durationMs: number;
  status: AuditRunStatus;
  candidateCount: number;
  candidateIds: string[];
  factsCreated: number;
  factsUpdated: number;
  factsSuperseded: number;
  factsSkipped: number;
  errors: string[];
}

interface SerializedMemoryRecord {
  id: string;
  content: string;
  type: string;
  layer: string;
  tags: string[];
  entities: string[];
  importance: number;
  confidence: number;
  provenance: { sourceType: string; conversationId?: string };
  supersedes?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
}

interface SerializedRollbackMarker {
  markerId: string;
  runId: string;
  action: RollbackAction;
  targetRecordId: string;
  previousState: SerializedMemoryRecord | null;
  newState: SerializedMemoryRecord;
  reversible: boolean;
}

interface SerializedAuditLog {
  version: 1;
  entries: SerializedAuditEntry[];
  markers: SerializedRollbackMarker[];
}

export class ConsolidationAuditLogError extends ReinsError {
  constructor(message: string) {
    super(message, "CONSOLIDATION_AUDIT_LOG_ERROR");
    this.name = "ConsolidationAuditLogError";
  }
}

export class ConsolidationAuditLog {
  private readonly entries: Map<string, AuditEntry> = new Map();
  private readonly markers: Map<string, RollbackMarker[]> = new Map();
  private readonly markersByRecord: Map<string, RollbackMarker[]> = new Map();

  recordRun(entry: AuditEntry): void {
    if (!entry.runId || entry.runId.trim().length === 0) {
      throw new ConsolidationAuditLogError("runId must be a non-empty string");
    }
    if (this.entries.has(entry.runId)) {
      throw new ConsolidationAuditLogError(`run ${entry.runId} already recorded`);
    }
    this.entries.set(entry.runId, { ...entry });
    if (!this.markers.has(entry.runId)) {
      this.markers.set(entry.runId, []);
    }
  }

  addRollbackMarker(marker: RollbackMarker): void {
    if (!marker.markerId || marker.markerId.trim().length === 0) {
      throw new ConsolidationAuditLogError("markerId must be a non-empty string");
    }
    if (!this.entries.has(marker.runId)) {
      throw new ConsolidationAuditLogError(`run ${marker.runId} not found — record the run first`);
    }

    const runMarkers = this.markers.get(marker.runId) ?? [];
    runMarkers.push({ ...marker });
    this.markers.set(marker.runId, runMarkers);

    const recordMarkers = this.markersByRecord.get(marker.targetRecordId) ?? [];
    recordMarkers.push(marker);
    this.markersByRecord.set(marker.targetRecordId, recordMarkers);
  }

  getRunHistory(options?: AuditQueryOptions): AuditEntry[] {
    let results = [...this.entries.values()];

    if (options?.startDate) {
      const start = options.startDate.getTime();
      results = results.filter((entry) => entry.timestamp.getTime() >= start);
    }

    if (options?.endDate) {
      const end = options.endDate.getTime();
      results = results.filter((entry) => entry.timestamp.getTime() <= end);
    }

    if (options?.status) {
      results = results.filter((entry) => entry.status === options.status);
    }

    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    if (options?.limit !== undefined && options.limit > 0) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  getMarkersForRun(runId: string): RollbackMarker[] {
    return [...(this.markers.get(runId) ?? [])];
  }

  getRollbackChain(recordId: string): RollbackMarker[] {
    const markers = this.markersByRecord.get(recordId) ?? [];
    return [...markers].sort((a, b) => {
      const entryA = this.entries.get(a.runId);
      const entryB = this.entries.get(b.runId);
      if (!entryA || !entryB) return 0;
      return entryA.timestamp.getTime() - entryB.timestamp.getTime();
    });
  }

  getSummary(options?: AuditQueryOptions): AuditSummary {
    const runs = this.getRunHistory(options);

    if (runs.length === 0) {
      return {
        totalRuns: 0,
        successCount: 0,
        partialCount: 0,
        failedCount: 0,
        successRate: 0,
        averageDurationMs: 0,
        totalFactsCreated: 0,
        totalFactsUpdated: 0,
        totalFactsSuperseded: 0,
        totalFactsSkipped: 0,
      };
    }

    let successCount = 0;
    let partialCount = 0;
    let failedCount = 0;
    let totalDuration = 0;
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalSuperseded = 0;
    let totalSkipped = 0;

    for (const run of runs) {
      if (run.status === "success") successCount += 1;
      else if (run.status === "partial") partialCount += 1;
      else failedCount += 1;

      totalDuration += run.durationMs;
      totalCreated += run.factsCreated;
      totalUpdated += run.factsUpdated;
      totalSuperseded += run.factsSuperseded;
      totalSkipped += run.factsSkipped;
    }

    return {
      totalRuns: runs.length,
      successCount,
      partialCount,
      failedCount,
      successRate: successCount / runs.length,
      averageDurationMs: totalDuration / runs.length,
      totalFactsCreated: totalCreated,
      totalFactsUpdated: totalUpdated,
      totalFactsSuperseded: totalSuperseded,
      totalFactsSkipped: totalSkipped,
    };
  }

  serialize(): string {
    const entries: SerializedAuditEntry[] = [...this.entries.values()].map(serializeEntry);
    const markers: SerializedRollbackMarker[] = [];

    for (const runMarkers of this.markers.values()) {
      for (const marker of runMarkers) {
        markers.push(serializeMarker(marker));
      }
    }

    const payload: SerializedAuditLog = { version: 1, entries, markers };
    return JSON.stringify(payload);
  }

  static deserialize(json: string): ConsolidationAuditLog {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new ConsolidationAuditLogError("invalid JSON in audit log");
    }

    if (!isObject(parsed) || parsed.version !== 1) {
      throw new ConsolidationAuditLogError("unsupported audit log version");
    }

    const data = parsed as unknown as SerializedAuditLog;
    const log = new ConsolidationAuditLog();

    if (!Array.isArray(data.entries)) {
      throw new ConsolidationAuditLogError("entries must be an array");
    }

    for (const raw of data.entries) {
      log.recordRun(deserializeEntry(raw));
    }

    if (Array.isArray(data.markers)) {
      for (const raw of data.markers) {
        log.addRollbackMarker(deserializeMarker(raw));
      }
    }

    return log;
  }
}

function serializeEntry(entry: AuditEntry): SerializedAuditEntry {
  return {
    runId: entry.runId,
    timestamp: entry.timestamp.toISOString(),
    durationMs: entry.durationMs,
    status: entry.status,
    candidateCount: entry.candidateCount,
    candidateIds: entry.candidateIds,
    factsCreated: entry.factsCreated,
    factsUpdated: entry.factsUpdated,
    factsSuperseded: entry.factsSuperseded,
    factsSkipped: entry.factsSkipped,
    errors: entry.errors,
  };
}

function deserializeEntry(raw: SerializedAuditEntry): AuditEntry {
  return {
    runId: raw.runId,
    timestamp: new Date(raw.timestamp),
    durationMs: raw.durationMs,
    status: raw.status,
    candidateCount: raw.candidateCount,
    candidateIds: raw.candidateIds,
    factsCreated: raw.factsCreated,
    factsUpdated: raw.factsUpdated,
    factsSuperseded: raw.factsSuperseded,
    factsSkipped: raw.factsSkipped,
    errors: raw.errors,
  };
}

function serializeMemoryRecord(record: MemoryRecord): SerializedMemoryRecord {
  return {
    id: record.id,
    content: record.content,
    type: record.type,
    layer: record.layer,
    tags: record.tags,
    entities: record.entities,
    importance: record.importance,
    confidence: record.confidence,
    provenance: {
      sourceType: record.provenance.sourceType,
      conversationId: record.provenance.conversationId,
    },
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    accessedAt: record.accessedAt.toISOString(),
  };
}

function deserializeMemoryRecord(raw: SerializedMemoryRecord): MemoryRecord {
  return {
    id: raw.id,
    content: raw.content,
    type: raw.type,
    layer: raw.layer,
    tags: raw.tags,
    entities: raw.entities,
    importance: raw.importance,
    confidence: raw.confidence,
    provenance: {
      sourceType: raw.provenance.sourceType,
      conversationId: raw.provenance.conversationId,
    },
    supersedes: raw.supersedes,
    supersededBy: raw.supersededBy,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    accessedAt: new Date(raw.accessedAt),
  } as MemoryRecord;
}

function serializeMarker(marker: RollbackMarker): SerializedRollbackMarker {
  return {
    markerId: marker.markerId,
    runId: marker.runId,
    action: marker.action,
    targetRecordId: marker.targetRecordId,
    previousState: marker.previousState ? serializeMemoryRecord(marker.previousState) : null,
    newState: serializeMemoryRecord(marker.newState),
    reversible: marker.reversible,
  };
}

function deserializeMarker(raw: SerializedRollbackMarker): RollbackMarker {
  return {
    markerId: raw.markerId,
    runId: raw.runId,
    action: raw.action,
    targetRecordId: raw.targetRecordId,
    previousState: raw.previousState ? deserializeMemoryRecord(raw.previousState) : null,
    newState: deserializeMemoryRecord(raw.newState),
    reversible: raw.reversible,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type { MemoryRecord } from "../types/index";
import type { DistilledFact } from "./distillation-schema";
import { ImportanceScorer } from "./importance-scorer";

export interface SupersessionRecord {
  originalId: string;
  replacedById: string;
  reason: string;
  timestamp: Date;
}

export interface MergeSkippedFact {
  fact: DistilledFact;
  reason: "duplicate" | "low_confidence" | "supersession_chain_depth_exceeded";
}

export interface MergeCreatedRecord {
  record: MemoryRecord;
  sourceCandidateIds: string[];
  reasoning: string;
}

export interface MergeUpdatedRecord {
  record: MemoryRecord;
  sourceCandidateIds: string[];
}

export interface MergeResult {
  created: MergeCreatedRecord[];
  updated: MergeUpdatedRecord[];
  superseded: MergeUpdatedRecord[];
  skipped: MergeSkippedFact[];
  supersessionChain: SupersessionRecord[];
}

export interface MergeConfig {
  similarityThreshold: number;
  maxSupersessionChainDepth: number;
  minConfidenceToMerge: number;
  now: () => Date;
  generateId: () => string;
}

export interface MemoryLookup {
  findDuplicate(
    fact: DistilledFact,
    normalizedFactContent: string,
    records: ReadonlyArray<MemoryRecord>,
    similarityThreshold: number,
  ): MemoryRecord | undefined;
  findContradictions(
    fact: DistilledFact,
    records: ReadonlyArray<MemoryRecord>,
  ): MemoryRecord[];
}

const DEFAULT_MERGE_CONFIG: Omit<MergeConfig, "generateId" | "now"> = {
  similarityThreshold: 1,
  maxSupersessionChainDepth: 8,
  minConfidenceToMerge: 0.5,
};

export class MergeEngineError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "MEMORY_CONSOLIDATION_MERGE_FAILED", cause);
    this.name = "MergeEngineError";
  }
}

export class MergeEngine {
  private readonly lookup: MemoryLookup;
  private readonly scorer: ImportanceScorer;
  private readonly config: MergeConfig;

  constructor(options: {
    lookup: MemoryLookup;
    scorer: ImportanceScorer;
    config: Omit<Partial<MergeConfig>, "generateId" | "now"> & {
      now?: () => Date;
      generateId: () => string;
    };
  }) {
    this.lookup = options.lookup;
    this.scorer = options.scorer;
    this.config = {
      similarityThreshold: options.config.similarityThreshold ?? DEFAULT_MERGE_CONFIG.similarityThreshold,
      maxSupersessionChainDepth:
        options.config.maxSupersessionChainDepth ?? DEFAULT_MERGE_CONFIG.maxSupersessionChainDepth,
      minConfidenceToMerge: options.config.minConfidenceToMerge ?? DEFAULT_MERGE_CONFIG.minConfidenceToMerge,
      now: options.config.now ?? (() => new Date()),
      generateId: options.config.generateId,
    };
  }

  merge(
    facts: DistilledFact[],
    existingLtm: MemoryRecord[],
  ): Result<MergeResult, MergeEngineError> {
    try {
      if (facts.length === 0) {
        return ok({
          created: [],
          updated: [],
          superseded: [],
          skipped: [],
          supersessionChain: [],
        });
      }

      const now = this.config.now();
      const recordsById = new Map<string, MemoryRecord>();
      const allRecords: MemoryRecord[] = existingLtm.map((record) => {
        const decayed = {
          ...record,
          importance: this.scorer.decay(record.importance, record.accessedAt, now),
        };
        recordsById.set(decayed.id, decayed);
        return decayed;
      });

      const created: MergeCreatedRecord[] = [];
      const updatedById = new Map<string, MergeUpdatedRecord>();
      const supersededById = new Map<string, MergeUpdatedRecord>();
      const skipped: MergeSkippedFact[] = [];
      const supersessionChain: SupersessionRecord[] = [];

      for (const fact of facts) {
        if (fact.confidence < this.config.minConfidenceToMerge) {
          skipped.push({ fact, reason: "low_confidence" });
          continue;
        }

        const normalizedFactContent = normalizeContent(fact.content);
        const duplicate = this.lookup.findDuplicate(
          fact,
          normalizedFactContent,
          allRecords,
          this.config.similarityThreshold,
        );
        if (duplicate) {
          const reinforced = {
            ...duplicate,
            importance: this.scorer.reinforce(duplicate.importance, 1),
            updatedAt: now,
            accessedAt: now,
          };
          recordsById.set(reinforced.id, reinforced);
          replaceRecord(allRecords, reinforced);
          updatedById.set(reinforced.id, {
            record: reinforced,
            sourceCandidateIds: fact.sourceCandidateIds,
          });
          skipped.push({ fact, reason: "duplicate" });
          continue;
        }

        const contradictions = this.lookup
          .findContradictions(fact, allRecords)
          .filter((record) => !record.supersededBy);

        if (contradictions.length > 0) {
          const latest = contradictions
            .slice()
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

          const depth = computeSupersessionDepth(latest, recordsById);
          if (depth >= this.config.maxSupersessionChainDepth) {
            skipped.push({
              fact,
              reason: "supersession_chain_depth_exceeded",
            });
            continue;
          }

          const createdRecord = this.createRecordFromFact(fact, now, latest.id);
          const supersededRecord = {
            ...latest,
            supersededBy: createdRecord.id,
            updatedAt: now,
          };

          recordsById.set(supersededRecord.id, supersededRecord);
          recordsById.set(createdRecord.id, createdRecord);
          replaceRecord(allRecords, supersededRecord);
          allRecords.push(createdRecord);

          created.push({
            record: createdRecord,
            sourceCandidateIds: fact.sourceCandidateIds,
            reasoning: fact.reasoning,
          });
          supersededById.set(supersededRecord.id, {
            record: supersededRecord,
            sourceCandidateIds: fact.sourceCandidateIds,
          });
          supersessionChain.push({
            originalId: supersededRecord.id,
            replacedById: createdRecord.id,
            reason: "newer_wins_contradiction",
            timestamp: now,
          });
          continue;
        }

        const newRecord = this.createRecordFromFact(fact, now);
        recordsById.set(newRecord.id, newRecord);
        allRecords.push(newRecord);
        created.push({
          record: newRecord,
          sourceCandidateIds: fact.sourceCandidateIds,
          reasoning: fact.reasoning,
        });
      }

      return ok({
        created,
        updated: [...updatedById.values()],
        superseded: [...supersededById.values()],
        skipped,
        supersessionChain,
      });
    } catch (error: unknown) {
      return err(
        new MergeEngineError(
          "Failed to merge distilled facts into LTM candidates",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  private createRecordFromFact(
    fact: DistilledFact,
    timestamp: Date,
    supersedes?: string,
  ): MemoryRecord {
    return {
      id: this.config.generateId(),
      content: fact.content.trim(),
      type: fact.type,
      layer: "ltm",
      tags: dedupeStrings(fact.tags),
      entities: dedupeStrings(fact.entities),
      importance: fact.confidence,
      confidence: fact.confidence,
      provenance: {
        sourceType: "consolidation",
        conversationId: fact.sourceCandidateIds.join(","),
      },
      supersedes,
      createdAt: timestamp,
      updatedAt: timestamp,
      accessedAt: timestamp,
    };
  }
}

export class SimpleMemoryLookup implements MemoryLookup {
  findDuplicate(
    fact: DistilledFact,
    normalizedFactContent: string,
    records: ReadonlyArray<MemoryRecord>,
    similarityThreshold: number,
  ): MemoryRecord | undefined {
    for (const record of records) {
      if (record.type !== fact.type || record.layer !== "ltm" || record.supersededBy) {
        continue;
      }

      const normalizedRecord = normalizeContent(record.content);
      if (normalizedRecord === normalizedFactContent) {
        return record;
      }

      const similarity = jaccardSimilarity(normalizedFactContent, normalizedRecord);
      if (similarity >= similarityThreshold) {
        return record;
      }
    }

    return undefined;
  }

  findContradictions(
    fact: DistilledFact,
    records: ReadonlyArray<MemoryRecord>,
  ): MemoryRecord[] {
    const factNormalized = normalizeContent(fact.content);
    const factEntitySet = new Set(
      fact.entities
        .map((entity) => normalizeContent(entity))
        .filter((entity) => !isGenericEntity(entity)),
    );
    const factTagSet = new Set(fact.tags.map((tag) => normalizeContent(tag)));

    return records.filter((record) => {
      if (record.layer !== "ltm" || record.type !== fact.type || record.supersededBy) {
        return false;
      }

      const normalizedRecord = normalizeContent(record.content);
      if (normalizedRecord === factNormalized) {
        return false;
      }

      const entityOverlap = record.entities
        .map((entity) => normalizeContent(entity))
        .filter((entity) => !isGenericEntity(entity))
        .some((entity) => factEntitySet.has(entity));
      const tagOverlap = record.tags.some((tag) => factTagSet.has(normalizeContent(tag)));
      if (!entityOverlap && !tagOverlap) {
        return false;
      }

      const factNegative = hasNegativePolarity(factNormalized);
      const recordNegative = hasNegativePolarity(normalizedRecord);
      if (factNegative !== recordNegative) {
        return true;
      }

      return jaccardSimilarity(factNormalized, normalizedRecord) >= 0.5;
    });
  }
}

function normalizeContent(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function isGenericEntity(value: string): boolean {
  return value === "user" || value === "assistant" || value === "system" || value === "me";
}

function replaceRecord(records: MemoryRecord[], next: MemoryRecord): void {
  const index = records.findIndex((record) => record.id === next.id);
  if (index >= 0) {
    records[index] = next;
  }
}

function computeSupersessionDepth(
  record: MemoryRecord,
  recordsById: ReadonlyMap<string, MemoryRecord>,
): number {
  let current: MemoryRecord | undefined = record;
  let depth = 0;
  const visited = new Set<string>();

  while (current?.supersedes) {
    if (visited.has(current.id)) {
      break;
    }
    visited.add(current.id);
    depth += 1;
    current = recordsById.get(current.supersedes);
  }

  return depth;
}

function hasNegativePolarity(value: string): boolean {
  return /(\bnot\b|\bnever\b|\bno\b|\bcannot\b|\bcan t\b|\bdon t\b|\bdoesn t\b|\bdislike\b|\bwon t\b)/.test(
    value,
  );
}

function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

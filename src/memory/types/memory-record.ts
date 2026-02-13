import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import {
  isValidMemorySourceType,
  isValidMemoryType,
  isValidPersistedMemoryLayer,
  type MemorySourceType,
  type MemoryType,
  type PersistedMemoryLayer,
} from "./memory-types";

interface MemoryRecordObject {
  id?: unknown;
  content?: unknown;
  type?: unknown;
  layer?: unknown;
  tags?: unknown;
  entities?: unknown;
  importance?: unknown;
  confidence?: unknown;
  provenance?: unknown;
  supersedes?: unknown;
  supersededBy?: unknown;
  embedding?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  accessedAt?: unknown;
}

interface MemoryProvenanceObject {
  sourceType?: unknown;
  conversationId?: unknown;
}

interface MemoryEmbeddingMetadataObject {
  provider?: unknown;
  model?: unknown;
  dimension?: unknown;
  version?: unknown;
}

export interface MemoryProvenance {
  sourceType: MemorySourceType;
  conversationId?: string;
}

export interface MemoryEmbeddingMetadata {
  provider: string;
  model: string;
  dimension: number;
  version: string;
}

export interface MemoryRecord {
  id: string;
  content: string;
  type: MemoryType;
  layer: PersistedMemoryLayer;
  tags: string[];
  entities: string[];
  importance: number;
  confidence: number;
  provenance: MemoryProvenance;
  supersedes?: string;
  supersededBy?: string;
  embedding?: MemoryEmbeddingMetadata;
  createdAt: Date;
  updatedAt: Date;
  accessedAt: Date;
}

export interface StmMemoryRecord extends MemoryRecord {
  layer: "stm";
}

export interface LtmMemoryRecord extends MemoryRecord {
  layer: "ltm";
}

export class MemoryDomainValidationError extends ReinsError {
  constructor(message: string) {
    super(message, "MEMORY_DOMAIN_VALIDATION_ERROR");
    this.name = "MemoryDomainValidationError";
  }
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseProvenance(value: unknown): Result<MemoryProvenance, MemoryDomainValidationError> {
  if (!isObject(value)) {
    return err(new MemoryDomainValidationError("provenance must be an object"));
  }

  const provenance = value as MemoryProvenanceObject;
  if (typeof provenance.sourceType !== "string" || !isValidMemorySourceType(provenance.sourceType)) {
    return err(new MemoryDomainValidationError("provenance.sourceType must be valid"));
  }

  if (typeof provenance.conversationId !== "undefined" && !isNonEmptyString(provenance.conversationId)) {
    return err(new MemoryDomainValidationError("provenance.conversationId must be a string when provided"));
  }

  return ok({
    sourceType: provenance.sourceType,
    conversationId: provenance.conversationId,
  });
}

function parseEmbedding(
  value: unknown,
): Result<MemoryEmbeddingMetadata | undefined, MemoryDomainValidationError> {
  if (typeof value === "undefined") {
    return ok(undefined);
  }

  if (!isObject(value)) {
    return err(new MemoryDomainValidationError("embedding must be an object when provided"));
  }

  const embedding = value as MemoryEmbeddingMetadataObject;
  if (!isNonEmptyString(embedding.provider)) {
    return err(new MemoryDomainValidationError("embedding.provider must be a non-empty string"));
  }

  if (!isNonEmptyString(embedding.model)) {
    return err(new MemoryDomainValidationError("embedding.model must be a non-empty string"));
  }

  if (
    typeof embedding.dimension !== "number" ||
    !Number.isInteger(embedding.dimension) ||
    embedding.dimension <= 0
  ) {
    return err(new MemoryDomainValidationError("embedding.dimension must be a positive integer"));
  }

  if (!isNonEmptyString(embedding.version)) {
    return err(new MemoryDomainValidationError("embedding.version must be a non-empty string"));
  }

  return ok({
    provider: embedding.provider,
    model: embedding.model,
    dimension: embedding.dimension,
    version: embedding.version,
  });
}

export function validateMemoryRecord(
  record: unknown,
): Result<MemoryRecord> {
  if (!isObject(record)) {
    return err(new MemoryDomainValidationError("memory record must be an object"));
  }

  const candidate = record as MemoryRecordObject;

  if (!isNonEmptyString(candidate.id)) {
    return err(new MemoryDomainValidationError("id must be a non-empty string"));
  }

  if (!isNonEmptyString(candidate.content)) {
    return err(new MemoryDomainValidationError("content must be a non-empty string"));
  }

  if (typeof candidate.type !== "string" || !isValidMemoryType(candidate.type)) {
    return err(new MemoryDomainValidationError("type must be a valid memory type"));
  }

  if (typeof candidate.layer !== "string" || !isValidPersistedMemoryLayer(candidate.layer)) {
    return err(new MemoryDomainValidationError("layer must be a valid persisted memory layer"));
  }

  if (!isStringArray(candidate.tags)) {
    return err(new MemoryDomainValidationError("tags must be a string array"));
  }

  if (!isStringArray(candidate.entities)) {
    return err(new MemoryDomainValidationError("entities must be a string array"));
  }

  if (!isScore(candidate.importance)) {
    return err(new MemoryDomainValidationError("importance must be a number between 0 and 1"));
  }

  if (!isScore(candidate.confidence)) {
    return err(new MemoryDomainValidationError("confidence must be a number between 0 and 1"));
  }

  const parsedProvenance = parseProvenance(candidate.provenance);
  if (!parsedProvenance.ok) {
    return parsedProvenance;
  }

  const parsedEmbedding = parseEmbedding(candidate.embedding);
  if (!parsedEmbedding.ok) {
    return parsedEmbedding;
  }

  if (typeof candidate.supersedes !== "undefined" && !isNonEmptyString(candidate.supersedes)) {
    return err(new MemoryDomainValidationError("supersedes must be a string when provided"));
  }

  if (typeof candidate.supersededBy !== "undefined" && !isNonEmptyString(candidate.supersededBy)) {
    return err(new MemoryDomainValidationError("supersededBy must be a string when provided"));
  }

  if (!isDate(candidate.createdAt)) {
    return err(new MemoryDomainValidationError("createdAt must be a valid Date"));
  }

  if (!isDate(candidate.updatedAt)) {
    return err(new MemoryDomainValidationError("updatedAt must be a valid Date"));
  }

  if (!isDate(candidate.accessedAt)) {
    return err(new MemoryDomainValidationError("accessedAt must be a valid Date"));
  }

  return ok({
    id: candidate.id,
    content: candidate.content,
    type: candidate.type,
    layer: candidate.layer,
    tags: candidate.tags,
    entities: candidate.entities,
    importance: candidate.importance,
    confidence: candidate.confidence,
    provenance: parsedProvenance.value,
    supersedes: candidate.supersedes,
    supersededBy: candidate.supersededBy,
    embedding: parsedEmbedding.value,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    accessedAt: candidate.accessedAt,
  });
}

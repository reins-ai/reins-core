import {
  MEMORY_TYPES,
  MEMORY_SOURCE_TYPES,
  PERSISTED_MEMORY_LAYERS,
  type MemoryType,
  type MemorySourceType,
  type PersistedMemoryLayer,
} from "../types/memory-types";

export interface SchemaError {
  path: string;
  message: string;
}

export type SchemaResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: SchemaError[] };

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isIsoDateString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

export interface ValidatedExportedMemoryRecord {
  id: string;
  content: string;
  type: MemoryType;
  layer: PersistedMemoryLayer;
  importance: number;
  confidence: number;
  tags: string[];
  entities: string[];
  provenance: {
    sourceType: MemorySourceType;
    conversationId?: string;
  };
  supersedes?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
}

export interface ValidatedMemoryExportFile {
  version: string;
  exportedAt: string;
  memories: ValidatedExportedMemoryRecord[];
}

export function validateExportedMemoryRecord(
  value: unknown,
  index: number,
): SchemaResult<ValidatedExportedMemoryRecord> {
  const errors: SchemaError[] = [];
  const prefix = `memories[${index}]`;

  if (typeof value !== "object" || value === null) {
    return { ok: false, errors: [{ path: prefix, message: "must be an object" }] };
  }

  const record = value as Record<string, unknown>;

  if (!isString(record.id) || record.id.trim().length === 0) {
    errors.push({ path: `${prefix}.id`, message: "must be a non-empty string" });
  }

  if (!isString(record.content) || record.content.trim().length === 0) {
    errors.push({ path: `${prefix}.content`, message: "must be a non-empty string" });
  }

  if (!isString(record.type) || !MEMORY_TYPES.includes(record.type as MemoryType)) {
    const typeValue = isString(record.type) ? record.type : String(record.type);
    errors.push({
      path: `${prefix}.type`,
      message: `Unknown memory type: ${typeValue}`,
    });
  }

  if (
    typeof record.layer !== "undefined" &&
    record.layer !== null &&
    (!isString(record.layer) || !PERSISTED_MEMORY_LAYERS.includes(record.layer as PersistedMemoryLayer))
  ) {
    errors.push({ path: `${prefix}.layer`, message: "must be a valid persisted memory layer (stm, ltm)" });
  }

  if (!isNumber(record.importance) || record.importance < 0 || record.importance > 1) {
    errors.push({ path: `${prefix}.importance`, message: "must be a number between 0 and 1" });
  }

  if (
    typeof record.confidence !== "undefined" &&
    record.confidence !== null &&
    (!isNumber(record.confidence) || record.confidence < 0 || record.confidence > 1)
  ) {
    errors.push({ path: `${prefix}.confidence`, message: "must be a number between 0 and 1" });
  }

  if (!Array.isArray(record.tags) || !isStringArray(record.tags)) {
    errors.push({ path: `${prefix}.tags`, message: "must be an array of strings" });
  }

  if (
    typeof record.entities !== "undefined" &&
    record.entities !== null &&
    (!Array.isArray(record.entities) || !isStringArray(record.entities))
  ) {
    errors.push({ path: `${prefix}.entities`, message: "must be an array of strings when provided" });
  }

  if (typeof record.provenance !== "undefined" && record.provenance !== null) {
    if (typeof record.provenance !== "object") {
      errors.push({ path: `${prefix}.provenance`, message: "must be an object when provided" });
    } else {
      const prov = record.provenance as Record<string, unknown>;
      if (
        !isString(prov.sourceType) ||
        !MEMORY_SOURCE_TYPES.includes(prov.sourceType as MemorySourceType)
      ) {
        errors.push({
          path: `${prefix}.provenance.sourceType`,
          message: "must be a valid memory source type",
        });
      }
      if (typeof prov.conversationId !== "undefined" && prov.conversationId !== null && !isString(prov.conversationId)) {
        errors.push({
          path: `${prefix}.provenance.conversationId`,
          message: "must be a string when provided",
        });
      }
    }
  }

  if (typeof record.supersedes !== "undefined" && record.supersedes !== null && !isString(record.supersedes)) {
    errors.push({ path: `${prefix}.supersedes`, message: "must be a string when provided" });
  }

  if (typeof record.supersededBy !== "undefined" && record.supersededBy !== null && !isString(record.supersededBy)) {
    errors.push({ path: `${prefix}.supersededBy`, message: "must be a string when provided" });
  }

  if (!isIsoDateString(record.createdAt)) {
    errors.push({ path: `${prefix}.createdAt`, message: "must be a valid ISO date string" });
  }

  if (!isIsoDateString(record.updatedAt)) {
    errors.push({ path: `${prefix}.updatedAt`, message: "must be a valid ISO date string" });
  }

  if (!isIsoDateString(record.accessedAt)) {
    errors.push({ path: `${prefix}.accessedAt`, message: "must be a valid ISO date string" });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const prov = (record.provenance as Record<string, unknown> | undefined) ?? {};
  const validated: ValidatedExportedMemoryRecord = {
    id: record.id as string,
    content: record.content as string,
    type: record.type as MemoryType,
    layer: (isString(record.layer) && PERSISTED_MEMORY_LAYERS.includes(record.layer as PersistedMemoryLayer))
      ? record.layer as PersistedMemoryLayer
      : "stm",
    importance: record.importance as number,
    confidence: isNumber(record.confidence) ? record.confidence : 1.0,
    tags: record.tags as string[],
    entities: isStringArray(record.entities) ? record.entities : [],
    provenance: {
      sourceType: (isString(prov.sourceType) && MEMORY_SOURCE_TYPES.includes(prov.sourceType as MemorySourceType))
        ? prov.sourceType as MemorySourceType
        : "explicit",
      ...(isString(prov.conversationId) ? { conversationId: prov.conversationId } : {}),
    },
    ...(isString(record.supersedes) ? { supersedes: record.supersedes } : {}),
    ...(isString(record.supersededBy) ? { supersededBy: record.supersededBy } : {}),
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string,
    accessedAt: record.accessedAt as string,
  };

  return { ok: true, value: validated };
}

export function validateMemoryExportFile(
  value: unknown,
): SchemaResult<ValidatedMemoryExportFile> {
  const errors: SchemaError[] = [];

  if (typeof value !== "object" || value === null) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }

  const file = value as Record<string, unknown>;

  if (!isString(file.version)) {
    errors.push({ path: "version", message: "must be a string" });
  } else if (file.version !== "1.0") {
    errors.push({ path: "version", message: `unsupported version: ${file.version} (expected "1.0")` });
  }

  if (!isIsoDateString(file.exportedAt)) {
    errors.push({ path: "exportedAt", message: "must be a valid ISO date string" });
  }

  if (!Array.isArray(file.memories)) {
    errors.push({ path: "memories", message: "must be an array" });
    return { ok: false, errors };
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const validatedMemories: ValidatedExportedMemoryRecord[] = [];
  const recordErrors: SchemaError[] = [];

  for (let i = 0; i < file.memories.length; i++) {
    const result = validateExportedMemoryRecord(file.memories[i], i);
    if (result.ok) {
      validatedMemories.push(result.value);
    } else {
      recordErrors.push(...result.errors);
    }
  }

  if (recordErrors.length > 0) {
    return { ok: false, errors: recordErrors };
  }

  return {
    ok: true,
    value: {
      version: file.version as string,
      exportedAt: file.exportedAt as string,
      memories: validatedMemories,
    },
  };
}

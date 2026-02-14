/**
 * Memory route request/response DTOs.
 *
 * These types define the HTTP contract between daemon memory endpoints
 * and consumers (TUI, SDK). All dates are ISO 8601 strings in JSON.
 * Consumers import these types to build typed HTTP clients.
 */

import type {
  MemoryType,
  MemorySourceType,
  PersistedMemoryLayer,
  MemoryLayer,
} from "../../memory/types/index";
import { isValidMemoryType, isValidPersistedMemoryLayer } from "../../memory/types/index";

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

/** JSON-safe provenance attached to every memory DTO. */
export interface MemoryProvenanceDto {
  sourceType: MemorySourceType;
  conversationId?: string;
}

/** JSON-safe embedding metadata (present only when embeddings exist). */
export interface MemoryEmbeddingDto {
  provider: string;
  model: string;
  dimension: number;
  version: string;
}

/**
 * Canonical memory record DTO returned by all read endpoints.
 * Dates are ISO 8601 strings (not Date objects).
 */
export interface MemoryRecordDto {
  id: string;
  content: string;
  type: MemoryType;
  layer: PersistedMemoryLayer;
  tags: string[];
  entities: string[];
  importance: number;
  confidence: number;
  provenance: MemoryProvenanceDto;
  supersedes?: string;
  supersededBy?: string;
  embedding?: MemoryEmbeddingDto;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
}

/** GET /api/memory response body. */
export interface MemoryListResponseDto {
  memories: MemoryRecordDto[];
}

/** POST /api/memory/search response body. */
export interface MemorySearchResponseDto {
  query: string;
  results: MemoryRecordDto[];
  total: number;
}

/** POST /api/memory/consolidate response body. */
export interface MemoryConsolidateResponseDto {
  status: "accepted";
  message: string;
  timestamp: string;
}

/** Standard error envelope for memory routes. */
export interface MemoryErrorResponseDto {
  error: string;
}

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

/** POST /api/memory request body. */
export interface CreateMemoryRequestDto {
  content: string;
  type?: MemoryType;
  tags?: string[];
  entities?: string[];
  conversationId?: string;
  messageId?: string;
}

/** PUT /api/memory/:id request body. */
export interface UpdateMemoryRequestDto {
  content?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  entities?: string[];
}

/** POST /api/memory/search request body. */
export interface SearchMemoryRequestDto {
  query?: string;
  type?: MemoryType;
  layer?: PersistedMemoryLayer;
  limit?: number;
}

/** GET /api/memory query parameters (parsed from URL). */
export interface ListMemoryQueryParams {
  type?: MemoryType;
  layer?: MemoryLayer;
  limit?: number;
  offset?: number;
  sortBy?: "createdAt" | "importance" | "accessedAt";
  sortOrder?: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

interface ValidationResult<T> {
  ok: true;
  value: T;
}

interface ValidationError {
  ok: false;
  error: string;
}

type Validated<T> = ValidationResult<T> | ValidationError;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validate and normalize a POST /api/memory request body.
 * Returns a typed DTO or a validation error string.
 */
export function validateCreateMemoryRequest(body: unknown): Validated<CreateMemoryRequestDto> {
  if (!isObject(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  if (typeof body.content !== "string" || body.content.trim().length === 0) {
    return { ok: false, error: "content is required and must be a non-empty string" };
  }

  const dto: CreateMemoryRequestDto = {
    content: body.content,
  };

  if (typeof body.type !== "undefined") {
    if (typeof body.type !== "string" || !isValidMemoryType(body.type)) {
      return { ok: false, error: `type must be a valid memory type when provided` };
    }
    dto.type = body.type;
  }

  if (typeof body.tags !== "undefined") {
    if (!isStringArray(body.tags)) {
      return { ok: false, error: "tags must be an array of strings when provided" };
    }
    dto.tags = body.tags;
  }

  if (typeof body.entities !== "undefined") {
    if (!isStringArray(body.entities)) {
      return { ok: false, error: "entities must be an array of strings when provided" };
    }
    dto.entities = body.entities;
  }

  if (typeof body.conversationId !== "undefined") {
    if (typeof body.conversationId !== "string") {
      return { ok: false, error: "conversationId must be a string when provided" };
    }
    dto.conversationId = body.conversationId;
  }

  if (typeof body.messageId !== "undefined") {
    if (typeof body.messageId !== "string") {
      return { ok: false, error: "messageId must be a string when provided" };
    }
    dto.messageId = body.messageId;
  }

  return { ok: true, value: dto };
}

/**
 * Validate and normalize a PUT /api/memory/:id request body.
 * At least one field must be present.
 */
export function validateUpdateMemoryRequest(body: unknown): Validated<UpdateMemoryRequestDto> {
  if (!isObject(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const dto: UpdateMemoryRequestDto = {};
  let hasField = false;

  if (typeof body.content !== "undefined") {
    if (typeof body.content !== "string") {
      return { ok: false, error: "content must be a string when provided" };
    }
    dto.content = body.content;
    hasField = true;
  }

  if (typeof body.importance !== "undefined") {
    if (typeof body.importance !== "number" || !Number.isFinite(body.importance) || body.importance < 0 || body.importance > 1) {
      return { ok: false, error: "importance must be a number between 0 and 1 when provided" };
    }
    dto.importance = body.importance;
    hasField = true;
  }

  if (typeof body.confidence !== "undefined") {
    if (typeof body.confidence !== "number" || !Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1) {
      return { ok: false, error: "confidence must be a number between 0 and 1 when provided" };
    }
    dto.confidence = body.confidence;
    hasField = true;
  }

  if (typeof body.tags !== "undefined") {
    if (!isStringArray(body.tags)) {
      return { ok: false, error: "tags must be an array of strings when provided" };
    }
    dto.tags = body.tags;
    hasField = true;
  }

  if (typeof body.entities !== "undefined") {
    if (!isStringArray(body.entities)) {
      return { ok: false, error: "entities must be an array of strings when provided" };
    }
    dto.entities = body.entities;
    hasField = true;
  }

  if (!hasField) {
    return { ok: false, error: "At least one field must be provided for update" };
  }

  return { ok: true, value: dto };
}

/**
 * Validate and normalize a POST /api/memory/search request body.
 */
export function validateSearchMemoryRequest(body: unknown): Validated<SearchMemoryRequestDto> {
  if (!isObject(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const dto: SearchMemoryRequestDto = {};

  if (typeof body.query !== "undefined") {
    if (typeof body.query !== "string") {
      return { ok: false, error: "query must be a string when provided" };
    }
    dto.query = body.query.trim();
  }

  if (typeof body.type !== "undefined") {
    if (typeof body.type !== "string" || !isValidMemoryType(body.type)) {
      return { ok: false, error: "type must be a valid memory type when provided" };
    }
    dto.type = body.type;
  }

  if (typeof body.layer !== "undefined") {
    if (typeof body.layer !== "string" || !isValidPersistedMemoryLayer(body.layer)) {
      return { ok: false, error: "layer must be a valid persisted memory layer when provided" };
    }
    dto.layer = body.layer;
  }

  if (typeof body.limit !== "undefined") {
    if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1) {
      return { ok: false, error: "limit must be a positive integer when provided" };
    }
    dto.limit = body.limit;
  }

  return { ok: true, value: dto };
}

/**
 * Parse and validate GET /api/memory query parameters from a URL.
 */
export function parseListMemoryQueryParams(url: URL): ListMemoryQueryParams {
  const params: ListMemoryQueryParams = {};

  const typeParam = url.searchParams.get("type");
  if (typeParam && isValidMemoryType(typeParam)) {
    params.type = typeParam;
  }

  const layerParam = url.searchParams.get("layer");
  if (layerParam && isValidPersistedMemoryLayer(layerParam)) {
    params.layer = layerParam;
  }

  const limitParam = url.searchParams.get("limit");
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      params.limit = parsed;
    }
  }

  const offsetParam = url.searchParams.get("offset");
  if (offsetParam) {
    const parsed = parseInt(offsetParam, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      params.offset = parsed;
    }
  }

  const sortByParam = url.searchParams.get("sortBy");
  if (sortByParam === "createdAt" || sortByParam === "importance" || sortByParam === "accessedAt") {
    params.sortBy = sortByParam;
  }

  const sortOrderParam = url.searchParams.get("sortOrder");
  if (sortOrderParam === "asc" || sortOrderParam === "desc") {
    params.sortOrder = sortOrderParam;
  }

  return params;
}

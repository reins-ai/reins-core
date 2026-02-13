import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import {
  isValidMemorySourceType,
  isValidMemoryType,
  isValidPersistedMemoryLayer,
} from "../types/memory-types";

export class MemoryFormatError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "MEMORY_FORMAT_ERROR", cause);
    this.name = "MemoryFormatError";
  }
}

export const FRONTMATTER_VERSION = 1;

/**
 * Canonical key order for stable diffs. Serialization MUST follow this order.
 */
export const CANONICAL_KEY_ORDER = [
  "id",
  "version",
  "type",
  "layer",
  "importance",
  "confidence",
  "tags",
  "entities",
  "source",
  "supersedes",
  "supersededBy",
  "createdAt",
  "updatedAt",
  "accessedAt",
] as const;

export interface MemorySource {
  type: string;
  conversationId?: string;
  messageId?: string;
}

export interface MemoryFileRecord {
  id: string;
  version: number;
  type: string;
  layer: string;
  importance: number;
  confidence: number;
  tags: string[];
  entities: string[];
  source: MemorySource;
  supersedes: string | null;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
  content: string;
}

export type FrontmatterData = Omit<MemoryFileRecord, "content">;

interface FieldError {
  field: string;
  message: string;
}

function collectErrors(data: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [];

  if (typeof data["id"] !== "string" || data["id"].length === 0) {
    errors.push({ field: "id", message: "id must be a non-empty string" });
  }

  if (typeof data["version"] !== "number" || !Number.isInteger(data["version"])) {
    errors.push({ field: "version", message: "version must be an integer" });
  }

  if (typeof data["type"] !== "string" || !isValidMemoryType(data["type"])) {
    errors.push({ field: "type", message: `type must be one of the valid memory types` });
  }

  if (typeof data["layer"] !== "string" || !isValidPersistedMemoryLayer(data["layer"])) {
    errors.push({ field: "layer", message: "layer must be 'stm' or 'ltm'" });
  }

  if (typeof data["importance"] !== "number" || data["importance"] < 0 || data["importance"] > 1) {
    errors.push({ field: "importance", message: "importance must be a number between 0 and 1" });
  }

  if (typeof data["confidence"] !== "number" || data["confidence"] < 0 || data["confidence"] > 1) {
    errors.push({ field: "confidence", message: "confidence must be a number between 0 and 1" });
  }

  if (!Array.isArray(data["tags"])) {
    errors.push({ field: "tags", message: "tags must be an array" });
  } else {
    for (let i = 0; i < data["tags"].length; i++) {
      if (typeof data["tags"][i] !== "string") {
        errors.push({ field: `tags[${i}]`, message: "each tag must be a string" });
      }
    }
  }

  if (!Array.isArray(data["entities"])) {
    errors.push({ field: "entities", message: "entities must be an array" });
  } else {
    for (let i = 0; i < data["entities"].length; i++) {
      if (typeof data["entities"][i] !== "string") {
        errors.push({ field: `entities[${i}]`, message: "each entity must be a string" });
      }
    }
  }

  if (typeof data["source"] !== "object" || data["source"] === null) {
    errors.push({ field: "source", message: "source must be an object" });
  } else {
    const source = data["source"] as Record<string, unknown>;
    if (typeof source["type"] !== "string" || !isValidMemorySourceType(source["type"])) {
      errors.push({ field: "source.type", message: "source.type must be a valid source type" });
    }
    if (source["conversationId"] !== undefined && typeof source["conversationId"] !== "string") {
      errors.push({ field: "source.conversationId", message: "source.conversationId must be a string" });
    }
    if (source["messageId"] !== undefined && typeof source["messageId"] !== "string") {
      errors.push({ field: "source.messageId", message: "source.messageId must be a string" });
    }
  }

  if (data["supersedes"] !== null && typeof data["supersedes"] !== "string") {
    errors.push({ field: "supersedes", message: "supersedes must be a string or null" });
  }

  if (data["supersededBy"] !== null && typeof data["supersededBy"] !== "string") {
    errors.push({ field: "supersededBy", message: "supersededBy must be a string or null" });
  }

  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

  for (const field of ["createdAt", "updatedAt", "accessedAt"] as const) {
    if (typeof data[field] !== "string" || !isoPattern.test(data[field] as string)) {
      errors.push({ field, message: `${field} must be an ISO 8601 date string` });
    }
  }

  return errors;
}

export function validateFrontmatter(
  data: Record<string, unknown>,
): Result<FrontmatterData, MemoryFormatError> {
  const withDefaults: Record<string, unknown> = { ...data };

  // Apply defaults for optional fields
  if (withDefaults["version"] === undefined) {
    withDefaults["version"] = FRONTMATTER_VERSION;
  }
  if (withDefaults["confidence"] === undefined) {
    withDefaults["confidence"] = 1.0;
  }
  if (withDefaults["tags"] === undefined) {
    withDefaults["tags"] = [];
  }
  if (withDefaults["entities"] === undefined) {
    withDefaults["entities"] = [];
  }
  if (withDefaults["supersedes"] === undefined) {
    withDefaults["supersedes"] = null;
  }
  if (withDefaults["supersededBy"] === undefined) {
    withDefaults["supersededBy"] = null;
  }

  const errors = collectErrors(withDefaults);

  if (errors.length > 0) {
    const messages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    return err(new MemoryFormatError(`Invalid frontmatter: ${messages}`));
  }

  const source = withDefaults["source"] as Record<string, unknown>;

  const validated: FrontmatterData = {
    id: withDefaults["id"] as string,
    version: withDefaults["version"] as number,
    type: withDefaults["type"] as string,
    layer: withDefaults["layer"] as string,
    importance: withDefaults["importance"] as number,
    confidence: withDefaults["confidence"] as number,
    tags: withDefaults["tags"] as string[],
    entities: withDefaults["entities"] as string[],
    source: {
      type: source["type"] as string,
      conversationId: source["conversationId"] as string | undefined,
      messageId: source["messageId"] as string | undefined,
    },
    supersedes: withDefaults["supersedes"] as string | null,
    supersededBy: withDefaults["supersededBy"] as string | null,
    createdAt: withDefaults["createdAt"] as string,
    updatedAt: withDefaults["updatedAt"] as string,
    accessedAt: withDefaults["accessedAt"] as string,
  };

  return ok(validated);
}

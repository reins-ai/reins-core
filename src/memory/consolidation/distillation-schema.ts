import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";

export const DISTILLED_FACT_TYPES = ["fact", "preference", "decision", "entity"] as const;

export type DistilledFactType = (typeof DISTILLED_FACT_TYPES)[number];

export interface DistilledFact {
  type: DistilledFactType;
  content: string;
  confidence: number;
  sourceCandidateIds: string[];
  entities: string[];
  tags: string[];
  reasoning: string;
}

export interface DistillationResult {
  facts: DistilledFact[];
  failedCandidateIds: string[];
  warnings: string[];
}

export interface DistillationConfig {
  confidenceThreshold: number;
  maxFactsPerBatch: number;
  promptTemplate: string;
}

export const DEFAULT_DISTILLATION_PROMPT_TEMPLATE = [
  "You are distilling short-term memory extracts into durable structured knowledge.",
  "Only use information present in the candidate extracts.",
  "Return ONLY valid JSON matching this structure:",
  "{",
  '  "facts": [',
  "    {",
  '      "type": "fact|preference|decision|entity",',
  '      "content": "string",',
  '      "confidence": 0.0,',
  '      "sourceCandidateIds": ["candidate-id"],',
  '      "entities": ["string"],',
  '      "tags": ["string"],',
  '      "reasoning": "short rationale citing evidence"',
  "    }",
  "  ]",
  "}",
  "Rules:",
  "- Extract only high-signal durable knowledge.",
  "- Each fact must cite one or more sourceCandidateIds from the provided candidates.",
  "- Confidence must be between 0 and 1.",
  "- Do not invent facts, entities, or IDs.",
  "- Keep content concise and atomic.",
  "- Keep reasoning to one short sentence.",
  "",
  "Confidence threshold: {{confidenceThreshold}}",
  "Max facts allowed: {{maxFactsPerBatch}}",
  "",
  "Candidates:",
  "{{candidates}}",
].join("\n");

export const DEFAULT_DISTILLATION_CONFIG: DistillationConfig = {
  confidenceThreshold: 0.5,
  maxFactsPerBatch: 25,
  promptTemplate: DEFAULT_DISTILLATION_PROMPT_TEMPLATE,
};

export class DistillationSchemaError extends ReinsError {
  constructor(message: string) {
    super(message, "DISTILLATION_SCHEMA_INVALID");
    this.name = "DistillationSchemaError";
  }
}

export interface DistillationValidationResult {
  facts: DistilledFact[];
  warnings: string[];
  invalidCount: number;
}

interface DistilledFactObject {
  type?: unknown;
  content?: unknown;
  confidence?: unknown;
  sourceCandidateIds?: unknown;
  entities?: unknown;
  tags?: unknown;
  reasoning?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDistilledFactType(value: string): value is DistilledFactType {
  return DISTILLED_FACT_TYPES.includes(value as DistilledFactType);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

function toStringList(value: unknown, fieldName: string): Result<string[], DistillationSchemaError> {
  if (!Array.isArray(value)) {
    return err(new DistillationSchemaError(`${fieldName} must be an array of strings`));
  }

  const normalized = value
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => typeof item === "string");

  if (normalized.length !== value.length) {
    return err(new DistillationSchemaError(`${fieldName} must contain only non-empty strings`));
  }

  return ok([...new Set(normalized)]);
}

function validateConfidence(value: unknown): Result<number, DistillationSchemaError> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return err(new DistillationSchemaError("confidence must be a finite number"));
  }

  if (value < 0 || value > 1) {
    return err(new DistillationSchemaError("confidence must be between 0 and 1"));
  }

  return ok(Math.round(value * 1000) / 1000);
}

export function validateDistilledFact(
  value: unknown,
  allowedCandidateIds?: ReadonlySet<string>,
): Result<DistilledFact, DistillationSchemaError> {
  if (!isObject(value)) {
    return err(new DistillationSchemaError("distilled fact must be an object"));
  }

  const candidate = value as DistilledFactObject;

  if (typeof candidate.type !== "string" || !isDistilledFactType(candidate.type)) {
    return err(
      new DistillationSchemaError(
        `type must be one of: ${DISTILLED_FACT_TYPES.join(", ")}`,
      ),
    );
  }

  const content = asNonEmptyString(candidate.content);
  if (!content) {
    return err(new DistillationSchemaError("content must be a non-empty string"));
  }

  const confidence = validateConfidence(candidate.confidence);
  if (!confidence.ok) {
    return confidence;
  }

  const sourceCandidateIds = toStringList(candidate.sourceCandidateIds, "sourceCandidateIds");
  if (!sourceCandidateIds.ok) {
    return sourceCandidateIds;
  }

  if (sourceCandidateIds.value.length === 0) {
    return err(new DistillationSchemaError("sourceCandidateIds must include at least one candidate ID"));
  }

  if (allowedCandidateIds) {
    for (const sourceId of sourceCandidateIds.value) {
      if (!allowedCandidateIds.has(sourceId)) {
        return err(
          new DistillationSchemaError(
            `sourceCandidateIds contains unknown candidate id: ${sourceId}`,
          ),
        );
      }
    }
  }

  const entities = toStringList(candidate.entities, "entities");
  if (!entities.ok) {
    return entities;
  }

  const tags = toStringList(candidate.tags, "tags");
  if (!tags.ok) {
    return tags;
  }

  const reasoning = asNonEmptyString(candidate.reasoning);
  if (!reasoning) {
    return err(new DistillationSchemaError("reasoning must be a non-empty string"));
  }

  return ok({
    type: candidate.type,
    content,
    confidence: confidence.value,
    sourceCandidateIds: sourceCandidateIds.value,
    entities: entities.value,
    tags: tags.value,
    reasoning,
  });
}

export function validateDistillationPayload(
  value: unknown,
  allowedCandidateIds?: ReadonlySet<string>,
): DistillationValidationResult {
  let rawFacts: unknown[] = [];

  if (Array.isArray(value)) {
    rawFacts = value;
  } else if (isObject(value) && Array.isArray(value.facts)) {
    rawFacts = value.facts;
  }

  const facts: DistilledFact[] = [];
  const warnings: string[] = [];

  for (let index = 0; index < rawFacts.length; index += 1) {
    const parsed = validateDistilledFact(rawFacts[index], allowedCandidateIds);
    if (!parsed.ok) {
      warnings.push(`Rejected fact[${index}]: ${parsed.error.message}`);
      continue;
    }
    facts.push(parsed.value);
  }

  if (!Array.isArray(value) && !(isObject(value) && Array.isArray(value.facts))) {
    warnings.push("Distillation payload did not include a facts array");
  }

  return {
    facts,
    warnings,
    invalidCount: rawFacts.length - facts.length,
  };
}

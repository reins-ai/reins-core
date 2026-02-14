import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type { StmBatch } from "./stm-queue";
import {
  DEFAULT_DISTILLATION_CONFIG,
  type DistillationConfig,
  type DistillationResult,
  validateDistillationPayload,
} from "./distillation-schema";

export type DistillationProvider = (prompt: string) => Promise<string>;

export interface DistillationEngineOptions {
  provider: DistillationProvider;
  config?: Partial<DistillationConfig>;
}

export class DistillationEngineError extends ReinsError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = "DistillationEngineError";
  }
}

export class DistillationEngine {
  private readonly provider: DistillationProvider;
  private readonly config: DistillationConfig;

  constructor(options: DistillationEngineOptions) {
    this.provider = options.provider;
    this.config = {
      confidenceThreshold:
        options.config?.confidenceThreshold ?? DEFAULT_DISTILLATION_CONFIG.confidenceThreshold,
      maxFactsPerBatch: options.config?.maxFactsPerBatch ?? DEFAULT_DISTILLATION_CONFIG.maxFactsPerBatch,
      promptTemplate: options.config?.promptTemplate ?? DEFAULT_DISTILLATION_CONFIG.promptTemplate,
    };
  }

  async distill(batch: StmBatch): Promise<Result<DistillationResult, DistillationEngineError>> {
    if (batch.candidates.length === 0) {
      return ok({
        facts: [],
        failedCandidateIds: [],
        warnings: [],
      });
    }

    const candidateIds = batch.candidates.map((candidate) => candidate.record.id);
    const candidateIdSet = new Set(candidateIds);
    const prompt = this.buildPrompt(batch);

    let rawResponse = "";
    try {
      rawResponse = await this.provider(prompt);
    } catch (error: unknown) {
      const cause = error instanceof Error ? error : undefined;
      return err(
        new DistillationEngineError(
          "Distillation provider failed",
          "DISTILLATION_PROVIDER_FAILED",
          cause,
        ),
      );
    }

    const parsedJson = parseJsonPayload(rawResponse);
    if (!parsedJson.ok) {
      return ok({
        facts: [],
        failedCandidateIds: candidateIds,
        warnings: [parsedJson.error.message],
      });
    }

    const validation = validateDistillationPayload(parsedJson.value, candidateIdSet);

    const warnings = [...validation.warnings];
    const threshold = this.config.confidenceThreshold;

    const thresholdFacts = validation.facts.filter((fact) => {
      if (fact.confidence >= threshold) {
        return true;
      }

      warnings.push(
        `Rejected fact below confidence threshold (${threshold.toFixed(2)}): ${fact.content}`,
      );
      return false;
    });

    let facts = thresholdFacts;
    if (thresholdFacts.length > this.config.maxFactsPerBatch) {
      facts = thresholdFacts
        .slice()
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, this.config.maxFactsPerBatch);

      warnings.push(
        `Truncated distilled facts to maxFactsPerBatch (${this.config.maxFactsPerBatch})`,
      );
    }

    const successfulCandidateIds = new Set(
      facts.flatMap((fact) => fact.sourceCandidateIds),
    );
    const failedCandidateIds = candidateIds.filter((id) => !successfulCandidateIds.has(id));

    if (validation.invalidCount > 0) {
      warnings.push(`Rejected ${validation.invalidCount} malformed distilled fact(s)`);
    }

    return ok({
      facts,
      failedCandidateIds,
      warnings,
    });
  }

  private buildPrompt(batch: StmBatch): string {
    const candidateLines = batch.candidates.map((candidate) => {
      const record = candidate.record;
      const createdAt = record.createdAt.toISOString();
      const tags = record.tags.length > 0 ? record.tags.join(", ") : "none";
      const entities = record.entities.length > 0 ? record.entities.join(", ") : "none";
      return [
        `- candidateId: ${record.id}`,
        `  type: ${record.type}`,
        `  confidence: ${record.confidence.toFixed(3)}`,
        `  importance: ${record.importance.toFixed(3)}`,
        `  createdAt: ${createdAt}`,
        `  sourceType: ${record.provenance.sourceType}`,
        `  tags: ${tags}`,
        `  entities: ${entities}`,
        `  content: ${sanitizeForPrompt(record.content)}`,
      ].join("\n");
    });

    return this.config.promptTemplate
      .replaceAll("{{confidenceThreshold}}", this.config.confidenceThreshold.toFixed(2))
      .replaceAll("{{maxFactsPerBatch}}", String(this.config.maxFactsPerBatch))
      .replaceAll("{{candidates}}", candidateLines.join("\n"));
  }
}

function sanitizeForPrompt(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseJsonPayload(value: string): Result<unknown, DistillationEngineError> {
  const trimmed = value.trim();
  if (!trimmed) {
    return err(
      new DistillationEngineError(
        "Distillation provider returned empty response",
        "DISTILLATION_PARSE_FAILED",
      ),
    );
  }

  const direct = safeJsonParse(trimmed);
  if (direct.ok) {
    return direct;
  }

  const fenced = extractFencedJson(trimmed);
  if (fenced) {
    const parsedFenced = safeJsonParse(fenced);
    if (parsedFenced.ok) {
      return parsedFenced;
    }
  }

  const extracted = extractJsonSubstring(trimmed);
  if (extracted) {
    const parsedExtracted = safeJsonParse(extracted);
    if (parsedExtracted.ok) {
      return parsedExtracted;
    }
  }

  return err(
    new DistillationEngineError(
      "Unable to parse distillation provider output as JSON",
      "DISTILLATION_PARSE_FAILED",
    ),
  );
}

function safeJsonParse(value: string): Result<unknown, DistillationEngineError> {
  try {
    return ok(JSON.parse(value));
  } catch {
    return err(
      new DistillationEngineError(
        "Invalid JSON in distillation provider output",
        "DISTILLATION_PARSE_FAILED",
      ),
    );
  }
}

function extractFencedJson(value: string): string | undefined {
  const match = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (!match) {
    return undefined;
  }

  return match[1].trim();
}

function extractJsonSubstring(value: string): string | undefined {
  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return value.slice(objectStart, objectEnd + 1);
  }

  const arrayStart = value.indexOf("[");
  const arrayEnd = value.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return value.slice(arrayStart, arrayEnd + 1);
  }

  return undefined;
}

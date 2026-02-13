import { err, ok, type Result } from "../../result";
import type { CreateMemoryInput } from "../storage/memory-repository";
import { MemoryError } from "./memory-error";

export const MAX_CONTENT_LENGTH = 10000;
export const MIN_IMPLICIT_CONFIDENCE = 0.3;

export interface WritePolicy {
  name: string;
  validate(input: CreateMemoryInput): Result<void>;
}

export interface WritePolicyResult {
  passed: boolean;
  violations: WritePolicyViolation[];
  warnings: WritePolicyWarning[];
}

export interface WritePolicyViolation {
  policy: string;
  message: string;
}

export interface WritePolicyWarning {
  policy: string;
  message: string;
}

export class ContentPolicy implements WritePolicy {
  readonly name = "content";

  validate(input: CreateMemoryInput): Result<void> {
    if (!input.content || !input.content.trim()) {
      return err(
        new MemoryError("Memory content must not be empty", "MEMORY_DB_ERROR"),
      );
    }

    if (input.content.length > MAX_CONTENT_LENGTH) {
      return err(
        new MemoryError(
          `Memory content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`,
          "MEMORY_DB_ERROR",
        ),
      );
    }

    return ok(undefined);
  }
}

export class ConfidencePolicy implements WritePolicy {
  readonly name = "confidence";

  validate(input: CreateMemoryInput): Result<void> {
    if (input.source.type !== "implicit") {
      return ok(undefined);
    }

    const confidence = input.confidence ?? 1.0;
    if (confidence < MIN_IMPLICIT_CONFIDENCE) {
      return err(
        new MemoryError(
          `Implicit memory confidence ${confidence} is below minimum threshold of ${MIN_IMPLICIT_CONFIDENCE}`,
          "MEMORY_DB_ERROR",
        ),
      );
    }

    return ok(undefined);
  }
}

export class AttributionPolicy implements WritePolicy {
  readonly name = "attribution";

  validate(input: CreateMemoryInput): Result<void> {
    if (input.source.type !== "implicit") {
      return ok(undefined);
    }

    if (!input.source.conversationId) {
      return err(
        new MemoryError(
          "Implicit memories must include a source conversationId for attribution",
          "MEMORY_DB_ERROR",
        ),
      );
    }

    return ok(undefined);
  }
}

export interface DuplicateChecker {
  hasExactContent(content: string): Promise<boolean>;
}

export class DuplicatePolicy implements WritePolicy {
  readonly name = "duplicate";

  private readonly checker: DuplicateChecker;

  constructor(checker: DuplicateChecker) {
    this.checker = checker;
  }

  validate(_input: CreateMemoryInput): Result<void> {
    // Synchronous validation only — duplicate check is async and handled
    // separately by the service via checkDuplicateAsync
    return ok(undefined);
  }

  async checkDuplicateAsync(content: string): Promise<WritePolicyWarning | null> {
    const exists = await this.checker.hasExactContent(content);
    if (exists) {
      return {
        policy: this.name,
        message: "A memory with identical content already exists",
      };
    }

    return null;
  }
}

export function createDefaultPolicies(checker: DuplicateChecker): WritePolicy[] {
  return [
    new ContentPolicy(),
    new ConfidencePolicy(),
    new AttributionPolicy(),
    new DuplicatePolicy(checker),
  ];
}

export function runPolicies(
  policies: WritePolicy[],
  input: CreateMemoryInput,
): WritePolicyResult {
  const violations: WritePolicyViolation[] = [];
  const warnings: WritePolicyWarning[] = [];

  for (const policy of policies) {
    const result = policy.validate(input);
    if (!result.ok) {
      violations.push({
        policy: policy.name,
        message: result.error.message,
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    warnings,
  };
}

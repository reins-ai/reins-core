import { ReinsError } from "../errors";

export class SkillError extends ReinsError {
  constructor(message: string, codeOrCause?: SkillErrorCode | string | Error, cause?: Error) {
    const resolvedCode = typeof codeOrCause === "string" ? codeOrCause : "SKILL_ERROR";
    const resolvedCause = codeOrCause instanceof Error ? codeOrCause : cause;
    super(message, resolvedCode, resolvedCause);
    this.name = "SkillError";
  }
}

export const SKILL_ERROR_CODES = {
  PARSE: "SKILL_PARSE_ERROR",
  VALIDATION: "SKILL_VALIDATION_ERROR",
  EXECUTION: "SKILL_EXECUTION_ERROR",
  PERMISSION: "SKILL_PERMISSION_ERROR",
  NOT_FOUND: "SKILL_NOT_FOUND_ERROR",
} as const;

export type SkillErrorCode = typeof SKILL_ERROR_CODES[keyof typeof SKILL_ERROR_CODES];

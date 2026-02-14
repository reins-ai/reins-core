import { ReinsError } from "../errors";

export const ENVIRONMENT_ERROR_CODES = [
  "ENVIRONMENT_NOT_FOUND",
  "DOCUMENT_NOT_FOUND",
  "INVALID_ENVIRONMENT_NAME",
  "BOOTSTRAP_FAILED",
  "SCOPE_VIOLATION",
  "SWITCH_FAILED",
] as const;

export type EnvironmentErrorCode = (typeof ENVIRONMENT_ERROR_CODES)[number];

export class EnvironmentError extends ReinsError {
  constructor(message: string, code: EnvironmentErrorCode, cause?: Error) {
    super(message, code, cause);
    this.name = "EnvironmentError";
  }
}

export class EnvironmentNotFoundError extends EnvironmentError {
  constructor(environmentName: string, cause?: Error) {
    super(`Environment not found: ${environmentName}`, "ENVIRONMENT_NOT_FOUND", cause);
    this.name = "EnvironmentNotFoundError";
  }
}

export class DocumentNotFoundError extends EnvironmentError {
  constructor(documentType: string, environmentName: string, cause?: Error) {
    super(
      `Document ${documentType} not found for environment: ${environmentName}`,
      "DOCUMENT_NOT_FOUND",
      cause,
    );
    this.name = "DocumentNotFoundError";
  }
}

export class InvalidEnvironmentNameError extends EnvironmentError {
  constructor(environmentName: string) {
    super(`Invalid environment name: ${environmentName}`, "INVALID_ENVIRONMENT_NAME");
    this.name = "InvalidEnvironmentNameError";
  }
}

export class EnvironmentBootstrapFailedError extends EnvironmentError {
  constructor(message: string, cause?: Error) {
    super(message, "BOOTSTRAP_FAILED", cause);
    this.name = "EnvironmentBootstrapFailedError";
  }
}

export class EnvironmentScopeViolationError extends EnvironmentError {
  constructor(message: string, cause?: Error) {
    super(message, "SCOPE_VIOLATION", cause);
    this.name = "EnvironmentScopeViolationError";
  }
}

export class EnvironmentSwitchFailedError extends EnvironmentError {
  constructor(message: string, cause?: Error) {
    super(message, "SWITCH_FAILED", cause);
    this.name = "EnvironmentSwitchFailedError";
  }
}

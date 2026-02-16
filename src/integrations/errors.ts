import { ReinsError } from "../errors";

/**
 * Integration domain error for integration registry, lifecycle, and operation failures.
 */
export class IntegrationError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "INTEGRATION_ERROR", cause);
    this.name = "IntegrationError";
  }
}

/**
 * Common integration error codes for specific failure modes.
 */
export const INTEGRATION_ERROR_CODES = {
  CONNECTION: "INTEGRATION_CONNECTION_ERROR",
  AUTH: "INTEGRATION_AUTH_ERROR",
  OPERATION: "INTEGRATION_OPERATION_ERROR",
  VALIDATION: "INTEGRATION_VALIDATION_ERROR",
  STATE_TRANSITION: "INTEGRATION_STATE_TRANSITION_ERROR",
} as const;

export type IntegrationErrorCode = typeof INTEGRATION_ERROR_CODES[keyof typeof INTEGRATION_ERROR_CODES];

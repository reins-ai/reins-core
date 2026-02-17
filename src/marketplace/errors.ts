import { ReinsError } from "../errors";

/**
 * Common marketplace error codes for external source failures.
 */
export const MARKETPLACE_ERROR_CODES = {
  NOT_FOUND: "MARKETPLACE_NOT_FOUND",
  RATE_LIMITED: "MARKETPLACE_RATE_LIMITED",
  NETWORK_ERROR: "MARKETPLACE_NETWORK_ERROR",
  INVALID_RESPONSE: "MARKETPLACE_INVALID_RESPONSE",
  SOURCE_ERROR: "MARKETPLACE_SOURCE_ERROR",
  DOWNLOAD_ERROR: "MARKETPLACE_DOWNLOAD_ERROR",
} as const;

export type MarketplaceErrorCode = typeof MARKETPLACE_ERROR_CODES[keyof typeof MARKETPLACE_ERROR_CODES];

/**
 * Marketplace domain error used by registry and source integrations.
 */
export class MarketplaceError extends ReinsError {
  constructor(message: string, code: MarketplaceErrorCode, cause?: Error) {
    super(message, code, cause);
    this.name = "MarketplaceError";
  }
}

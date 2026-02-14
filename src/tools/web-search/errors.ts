import { ReinsError } from "../../errors";
import type { SearchProviderName } from "./types";

export class WebSearchError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "WEB_SEARCH_ERROR", cause);
    this.name = "WebSearchError";
  }
}

export type WebSearchErrorCode =
  | "UNSUPPORTED_SEARCH_TYPE"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "NETWORK_ERROR";

export interface WebSearchErrorDetail {
  code: WebSearchErrorCode;
  message: string;
  retryable: boolean;
  provider?: SearchProviderName;
  retryAfterMs?: number;
}

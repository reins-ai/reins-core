import type { ToolErrorDetail } from "../../types";
import type { SearchType } from "./types";

export type WebSearchAction = "search";

export const WEB_SEARCH_ACTIONS = ["search"] as const;

export interface WebSearchToolInput {
  action: WebSearchAction;
  query: string;
  searchType?: string;
  limit?: number;
  offset?: number;
}

export const WEB_SEARCH_ERROR_CODES = {
  UNSUPPORTED_TYPE: "WEB_SEARCH_UNSUPPORTED_TYPE",
  AUTH_FAILED: "WEB_SEARCH_AUTH_FAILED",
  RATE_LIMITED: "WEB_SEARCH_RATE_LIMITED",
  PROVIDER_ERROR: "WEB_SEARCH_PROVIDER_ERROR",
  NETWORK_ERROR: "WEB_SEARCH_NETWORK_ERROR",
  INVALID_INPUT: "WEB_SEARCH_INVALID_INPUT",
} as const;

export function createWebSearchErrorDetail(
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): ToolErrorDetail {
  return { code, message, retryable, details };
}

const VALID_SEARCH_TYPES = ["text", "image", "video", "news"] as const;

export function isValidSearchType(value: unknown): value is SearchType {
  return typeof value === "string" &&
    (VALID_SEARCH_TYPES as readonly string[]).includes(value);
}

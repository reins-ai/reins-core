import type { ToolErrorDetail } from "../../types";
import type { SearchProviderName, SearchType } from "./types";
import type { WebSearchError } from "./errors";
import { WEB_SEARCH_ERROR_CODES } from "./tool-contract";
import type { SearchProviderCapabilities } from "./provider-contract";

/**
 * Maps a WebSearchError into a ToolErrorDetail for the tool pipeline.
 */
export function mapSearchErrorToToolError(
  error: WebSearchError,
  provider?: SearchProviderName,
): ToolErrorDetail {
  const classification = classifySearchError(error);
  return {
    code: classification.code,
    message: classification.message,
    retryable: classification.retryable,
    details: {
      ...(provider ? { provider } : {}),
      ...(classification.retryAfterMs ? { retryAfterMs: classification.retryAfterMs } : {}),
    },
  };
}

/**
 * Creates a ToolErrorDetail for unsupported search type.
 * This is a "soft" error — the search didn't crash, the provider just doesn't support it.
 */
export function createUnsupportedTypeError(
  provider: SearchProviderName,
  searchType: SearchType,
  capabilities: SearchProviderCapabilities,
): ToolErrorDetail {
  const supported = getSupportedTypes(capabilities);
  return {
    code: WEB_SEARCH_ERROR_CODES.UNSUPPORTED_TYPE,
    message: `Search type "${searchType}" is not supported by ${provider}. Supported types: ${supported.join(", ")}.`,
    retryable: false,
    details: {
      provider,
      requestedType: searchType,
      supportedTypes: supported,
    },
  };
}

/**
 * Creates a ToolErrorDetail for missing API key.
 */
export function createMissingKeyError(
  provider: SearchProviderName,
): ToolErrorDetail {
  return {
    code: WEB_SEARCH_ERROR_CODES.AUTH_FAILED,
    message: `No API key configured for ${provider}. Add one in BYOK settings.`,
    retryable: false,
    details: { provider },
  };
}

interface ErrorClassification {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

function classifySearchError(error: WebSearchError): ErrorClassification {
  const message = error.message.toLowerCase();

  if (message.includes("rate limit")) {
    return {
      code: WEB_SEARCH_ERROR_CODES.RATE_LIMITED,
      message: error.message,
      retryable: true,
      retryAfterMs: 1000,
    };
  }

  if (
    message.includes("invalid") || message.includes("missing") ||
    message.includes("api key") || message.includes("401")
  ) {
    return {
      code: WEB_SEARCH_ERROR_CODES.AUTH_FAILED,
      message: error.message,
      retryable: false,
    };
  }

  if (message.includes("does not support")) {
    return {
      code: WEB_SEARCH_ERROR_CODES.UNSUPPORTED_TYPE,
      message: error.message,
      retryable: false,
    };
  }

  if (
    message.includes("network") || message.includes("fetch") ||
    message.includes("econnrefused") || message.includes("enotfound")
  ) {
    return {
      code: WEB_SEARCH_ERROR_CODES.NETWORK_ERROR,
      message: error.message,
      retryable: true,
    };
  }

  return {
    code: WEB_SEARCH_ERROR_CODES.PROVIDER_ERROR,
    message: error.message,
    retryable: true,
  };
}

function getSupportedTypes(capabilities: SearchProviderCapabilities): SearchType[] {
  const types: SearchType[] = [];
  if (capabilities.text) types.push("text");
  if (capabilities.image) types.push("image");
  if (capabilities.video) types.push("video");
  if (capabilities.news) types.push("news");
  return types;
}

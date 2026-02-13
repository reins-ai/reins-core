/**
 * Claude Code Request/Response Transform Layer
 *
 * When using Anthropic OAuth credentials (Claude Pro/Max plan), the API
 * validates that requests match the Claude Code CLI protocol. This module
 * provides transparent request transformation and response untransformation
 * so the rest of the system works with clean, unprefixed tool names.
 *
 * Transforms applied (outbound):
 * 1. System prompt: prepends "You are Claude Code..." identifier
 * 2. Beta headers: adds claude-code-20250219 + fine-grained-tool-streaming
 * 3. Tool names: prefixes all tool definitions with "mcp_"
 * 4. Message tool_use blocks: prefixes tool names in conversation history
 * 5. URL: appends ?beta=true to /v1/messages endpoint
 *
 * Transforms applied (inbound):
 * 1. Streaming: strips "mcp_" prefix from tool names in SSE chunks
 * 2. JSON responses: strips "mcp_" prefix from tool names
 *
 * This module is ONLY used by the OAuth provider. BYOK (API key) requests
 * are sent unmodified.
 */

const TOOL_PREFIX = "mcp_";

const CLAUDE_CODE_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Beta headers required for Claude Code credential acceptance.
 * These are merged with any existing beta headers on the request.
 */
const CLAUDE_CODE_BETAS = [
  "oauth-2025-04-20",
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
] as const;

/**
 * Merge required Claude Code beta flags with any existing beta header value.
 * Deduplicates entries.
 */
export function mergeClaudeCodeBetas(existingBeta?: string): string {
  const existing = existingBeta
    ? existingBeta
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean)
    : [];

  return [...new Set([...CLAUDE_CODE_BETAS, ...existing])].join(",");
}

/**
 * Build the full set of headers required for Claude Code OAuth requests.
 */
export function claudeCodeHeaders(
  token: string,
  withJsonContentType = true,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": mergeClaudeCodeBetas(),
    "user-agent": "claude-cli/2.1.2 (external, cli)",
  };

  if (withJsonContentType) {
    headers["content-type"] = "application/json";
  }

  return headers;
}

/**
 * Append ?beta=true to a /v1/messages URL if not already present.
 */
export function transformUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (
      parsed.pathname === "/v1/messages" &&
      !parsed.searchParams.has("beta")
    ) {
      parsed.searchParams.set("beta", "true");
      return parsed.toString();
    }
    return url;
  } catch {
    return url;
  }
}

// ── Outbound (request) transforms ──────────────────────────────────

/**
 * Prepend Claude Code system identifier to the system prompt.
 * Accepts string or structured system block array.
 */
export function transformSystemPrompt(
  system: string | undefined,
): string | undefined {
  if (!system) {
    return CLAUDE_CODE_SYSTEM_PREFIX;
  }

  // If it already starts with the prefix, don't double-add
  if (system.startsWith(CLAUDE_CODE_SYSTEM_PREFIX)) {
    return system;
  }

  return `${CLAUDE_CODE_SYSTEM_PREFIX}\n\n${system}`;
}

/**
 * Prefix tool definition names with "mcp_".
 * Operates on the Anthropic API tool format (name, description, input_schema).
 */
export function prefixToolDefinitions<
  T extends { name: string },
>(tools: T[] | undefined): T[] | undefined {
  if (!tools || tools.length === 0) {
    return tools;
  }

  return tools.map((tool) => ({
    ...tool,
    name: tool.name.startsWith(TOOL_PREFIX)
      ? tool.name
      : `${TOOL_PREFIX}${tool.name}`,
  }));
}

/**
 * Prefix tool_use block names in message history with "mcp_".
 * This ensures conversation history sent to the API matches the
 * prefixed tool definitions.
 *
 * Uses generic types so it works with any message shape (AnthropicMessage,
 * internal Message, etc.) as long as content blocks have type/name fields.
 */
export function prefixMessageToolNames<
  T extends { role: string; content: string | Array<{ type: string; name?: string }> },
>(messages: T[] | undefined): T[] | undefined {
  if (!messages || messages.length === 0) {
    return messages;
  }

  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) {
      return msg;
    }

    return {
      ...msg,
      content: msg.content.map((block) => {
        if (block.type === "tool_use" && block.name) {
          return {
            ...block,
            name: block.name.startsWith(TOOL_PREFIX)
              ? block.name
              : `${TOOL_PREFIX}${block.name}`,
          };
        }
        return block;
      }),
    };
  });
}

/**
 * Transform the full request body for Claude Code protocol compliance.
 * Returns a new JSON string with all outbound transforms applied.
 */
export function transformRequestBody(bodyJson: string): string {
  try {
    const parsed = JSON.parse(bodyJson);

    // 1. System prompt
    if (typeof parsed.system === "string" || parsed.system === undefined) {
      parsed.system = transformSystemPrompt(parsed.system);
    }

    // 2. Tool definitions
    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = prefixToolDefinitions(parsed.tools);
    }

    // 3. Message tool_use blocks
    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = prefixMessageToolNames(parsed.messages);
    }

    return JSON.stringify(parsed);
  } catch {
    // If parsing fails, return original body unchanged
    return bodyJson;
  }
}

// ── Inbound (response) transforms ──────────────────────────────────

/**
 * Strip "mcp_" prefix from tool names in a text chunk (SSE streaming).
 * Used to transparently reverse the outbound prefix so the rest of the
 * system sees clean tool names.
 */
export function stripToolPrefixFromChunk(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
}

/**
 * Strip "mcp_" prefix from tool names in a parsed response payload.
 * Used for non-streaming (chat) responses.
 */
export function stripToolPrefixFromPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(payload.content)) {
    return payload;
  }

  return {
    ...payload,
    content: (payload.content as Array<{ type: string; name?: string }>).map((block) => {
      if (block.type === "tool_use" && typeof block.name === "string") {
        return {
          ...block,
          name: block.name.startsWith(TOOL_PREFIX)
            ? block.name.slice(TOOL_PREFIX.length)
            : block.name,
        };
      }
      return block;
    }),
  };
}

/**
 * Create a transformed ReadableStream that strips mcp_ prefixes from
 * SSE chunks in real time. Used to wrap streaming responses.
 */
export function createStrippingStream(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      const text = decoder.decode(value, { stream: true });
      const stripped = stripToolPrefixFromChunk(text);
      controller.enqueue(encoder.encode(stripped));
    },
    cancel() {
      reader.cancel();
    },
  });
}

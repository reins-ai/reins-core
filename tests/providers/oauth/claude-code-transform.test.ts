import { describe, expect, it } from "bun:test";
import {
  mergeClaudeCodeBetas,
  claudeCodeHeaders,
  transformUrl,
  transformSystemPrompt,
  prefixToolDefinitions,
  prefixMessageToolNames,
  transformRequestBody,
  stripToolPrefixFromChunk,
  stripToolPrefixFromPayload,
  createStrippingStream,
} from "../../../src/providers/oauth/claude-code-transform";

describe("Claude Code Transform", () => {
  describe("mergeClaudeCodeBetas", () => {
    it("returns all required betas when no existing header", () => {
      const result = mergeClaudeCodeBetas();
      expect(result).toContain("claude-code-20250219");
      expect(result).toContain("interleaved-thinking-2025-05-14");
      expect(result).toContain("fine-grained-tool-streaming-2025-05-14");
    });

    it("merges with existing betas without duplicates", () => {
      const result = mergeClaudeCodeBetas(
        "interleaved-thinking-2025-05-14,custom-beta-123",
      );
      const betas = result.split(",");
      expect(betas).toContain("claude-code-20250219");
      expect(betas).toContain("interleaved-thinking-2025-05-14");
      expect(betas).toContain("fine-grained-tool-streaming-2025-05-14");
      expect(betas).toContain("custom-beta-123");
      // No duplicates
      const unique = [...new Set(betas)];
      expect(unique.length).toBe(betas.length);
    });

    it("handles empty string", () => {
      const result = mergeClaudeCodeBetas("");
      expect(result).toContain("claude-code-20250219");
    });
  });

  describe("claudeCodeHeaders", () => {
    it("includes Bearer token authorization", () => {
      const headers = claudeCodeHeaders("test-token");
      expect(headers.authorization).toBe("Bearer test-token");
    });

    it("includes anthropic-version header", () => {
      const headers = claudeCodeHeaders("test-token");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
    });

    it("includes claude-code beta header", () => {
      const headers = claudeCodeHeaders("test-token");
      expect(headers["anthropic-beta"]).toContain("claude-code-20250219");
    });

    it("includes claude-cli user-agent", () => {
      const headers = claudeCodeHeaders("test-token");
      expect(headers["user-agent"]).toBe("claude-cli/2.1.2 (external, cli)");
    });

    it("includes content-type by default", () => {
      const headers = claudeCodeHeaders("test-token");
      expect(headers["content-type"]).toBe("application/json");
    });

    it("omits content-type when withJsonContentType is false", () => {
      const headers = claudeCodeHeaders("test-token", false);
      expect(headers["content-type"]).toBeUndefined();
    });

    it("does not include x-api-key", () => {
      const headers = claudeCodeHeaders("test-token");
      expect(headers["x-api-key"]).toBeUndefined();
    });
  });

  describe("transformUrl", () => {
    it("appends beta=true to /v1/messages", () => {
      const url = transformUrl("https://api.anthropic.com/v1/messages");
      expect(url).toContain("beta=true");
    });

    it("does not modify non-messages URLs", () => {
      const url = transformUrl("https://api.anthropic.com/v1/models");
      expect(url).toBe("https://api.anthropic.com/v1/models");
    });

    it("does not double-add beta param", () => {
      const url = transformUrl(
        "https://api.anthropic.com/v1/messages?beta=true",
      );
      expect(url).toBe(
        "https://api.anthropic.com/v1/messages?beta=true",
      );
    });

    it("handles invalid URLs gracefully", () => {
      const url = transformUrl("not-a-url");
      expect(url).toBe("not-a-url");
    });
  });

  describe("transformSystemPrompt", () => {
    it("returns prefix when no system prompt provided", () => {
      const result = transformSystemPrompt(undefined);
      expect(result).toBe(
        "You are Claude Code, Anthropic's official CLI for Claude.",
      );
    });

    it("prepends prefix to existing system prompt", () => {
      const result = transformSystemPrompt("Be helpful.");
      expect(result).toStartWith(
        "You are Claude Code, Anthropic's official CLI for Claude.",
      );
      expect(result).toContain("Be helpful.");
    });

    it("does not double-prefix", () => {
      const prefixed = transformSystemPrompt("Be helpful.");
      const doublePrefixed = transformSystemPrompt(prefixed!);
      expect(doublePrefixed).toBe(prefixed);
    });
  });

  describe("prefixToolDefinitions", () => {
    it("prefixes tool names with mcp_", () => {
      const tools = [
        { name: "bash", description: "Run a command", input_schema: {} },
        { name: "read", description: "Read a file", input_schema: {} },
      ];
      const result = prefixToolDefinitions(tools)!;
      expect(result[0].name).toBe("mcp_bash");
      expect(result[1].name).toBe("mcp_read");
    });

    it("does not double-prefix", () => {
      const tools = [
        { name: "mcp_bash", description: "Run a command", input_schema: {} },
      ];
      const result = prefixToolDefinitions(tools)!;
      expect(result[0].name).toBe("mcp_bash");
    });

    it("returns undefined for undefined input", () => {
      expect(prefixToolDefinitions(undefined)).toBeUndefined();
    });

    it("returns undefined for empty array", () => {
      expect(prefixToolDefinitions([])).toEqual([]);
    });

    it("preserves all other tool properties", () => {
      const tools = [
        { name: "bash", description: "Run a command", input_schema: { type: "object" as const } },
      ];
      const result = prefixToolDefinitions(tools)!;
      expect(result[0].description).toBe("Run a command");
      expect(result[0].input_schema).toEqual({ type: "object" });
    });
  });

  describe("prefixMessageToolNames", () => {
    it("prefixes tool_use block names in messages", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "bash", id: "t1", input: {} },
          ],
        },
      ];
      const result = prefixMessageToolNames(messages)!;
      const content = result[0].content as Array<{ name?: string }>;
      expect(content[0].name).toBe("mcp_bash");
    });

    it("does not modify text messages", () => {
      const messages = [{ role: "user", content: "hello" }];
      const result = prefixMessageToolNames(messages)!;
      expect(result[0].content).toBe("hello");
    });

    it("does not modify text blocks", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "text", text: "I will read the file." }],
        },
      ];
      const result = prefixMessageToolNames(messages)!;
      const content = result[0].content as Array<{ type: string; text?: string }>;
      expect(content[0].text).toBe("I will read the file.");
    });

    it("does not modify tool_result blocks", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "output" },
          ],
        },
      ];
      const result = prefixMessageToolNames(messages)!;
      const content = result[0].content as Array<{ type: string }>;
      expect(content[0]).not.toHaveProperty("name");
    });

    it("returns undefined for undefined input", () => {
      expect(prefixMessageToolNames(undefined)).toBeUndefined();
    });
  });

  describe("transformRequestBody", () => {
    it("applies all transforms to a complete request body", () => {
      const body = JSON.stringify({
        system: "Be helpful.",
        tools: [{ name: "bash", description: "Run", input_schema: {} }],
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", name: "bash", id: "t1", input: {} },
            ],
          },
        ],
      });

      const result = JSON.parse(transformRequestBody(body));
      expect(result.system).toContain("You are Claude Code");
      expect(result.system).toContain("Be helpful.");
      expect(result.tools[0].name).toBe("mcp_bash");
      expect(result.messages[0].content[0].name).toBe("mcp_bash");
    });

    it("handles body with no tools or system prompt", () => {
      const body = JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      });
      const result = JSON.parse(transformRequestBody(body));
      expect(result.system).toBe(
        "You are Claude Code, Anthropic's official CLI for Claude.",
      );
    });

    it("returns original body on parse error", () => {
      const result = transformRequestBody("not json");
      expect(result).toBe("not json");
    });
  });

  describe("stripToolPrefixFromChunk", () => {
    it("strips mcp_ prefix from tool names in SSE chunk", () => {
      const chunk = 'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_bash"}}';
      const result = stripToolPrefixFromChunk(chunk);
      expect(result).toContain('"name": "bash"');
      expect(result).not.toContain("mcp_bash");
    });

    it("handles multiple tool names in one chunk", () => {
      const chunk = '"name": "mcp_bash" and "name": "mcp_read"';
      const result = stripToolPrefixFromChunk(chunk);
      expect(result).toContain('"name": "bash"');
      expect(result).toContain('"name": "read"');
    });

    it("does not modify text without mcp_ tool names", () => {
      const chunk = 'data: {"type":"text","text":"hello mcp_world"}';
      const result = stripToolPrefixFromChunk(chunk);
      // Only strips in "name": "mcp_..." pattern
      expect(result).toContain("mcp_world");
    });
  });

  describe("stripToolPrefixFromPayload", () => {
    it("strips mcp_ prefix from tool_use blocks", () => {
      const payload = {
        content: [
          { type: "tool_use", name: "mcp_bash", id: "t1", input: {} },
          { type: "text", text: "I ran the command." },
        ],
      };
      const result = stripToolPrefixFromPayload(payload);
      const content = result.content as Array<{ type: string; name?: string }>;
      expect(content[0].name).toBe("bash");
      expect(content[1]).not.toHaveProperty("name");
    });

    it("does not modify payload without content array", () => {
      const payload = { id: "msg_123" };
      const result = stripToolPrefixFromPayload(payload);
      expect(result).toEqual(payload);
    });

    it("handles tool names without mcp_ prefix", () => {
      const payload = {
        content: [{ type: "tool_use", name: "bash", id: "t1", input: {} }],
      };
      const result = stripToolPrefixFromPayload(payload);
      const content = result.content as Array<{ name?: string }>;
      expect(content[0].name).toBe("bash");
    });
  });

  describe("createStrippingStream", () => {
    it("strips mcp_ prefix from streamed chunks", async () => {
      const encoder = new TextEncoder();
      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
            ),
          );
          controller.close();
        },
      });

      const stripped = createStrippingStream(input);
      const reader = stripped.getReader();
      const decoder = new TextDecoder();

      const { value } = await reader.read();
      const text = decoder.decode(value);
      expect(text).toContain('"name": "bash"');
      expect(text).not.toContain("mcp_bash");
    });
  });
});

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import type { Tool, ToolDefinition } from "../../../src/types/tool";

export const PARALLEL_URL = "https://search.parallel.ai/mcp";
export const USER_AGENT = "reins-core-parallel-search-example/1.0";

const definitions: ToolDefinition[] = [
  {
    name: "parallel_web_search",
    description: "Search the web for current information and source excerpts.",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "Information to find." },
        search_queries: {
          type: "array",
          items: { type: "string" },
          description: "One or more related keyword queries, each 3–6 words.",
        },
      },
      required: ["objective", "search_queries"],
    },
  },
  {
    name: "parallel_web_fetch",
    description: "Fetch source excerpts from specific web pages.",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "HTTP or HTTPS URLs to read, at most 20.",
        },
        objective: { type: "string", description: "Optional extraction goal, at most 200 characters." },
        search_queries: {
          type: "array",
          items: { type: "string" },
          description: "Optional queries used to find these pages.",
        },
      },
      required: ["urls"],
    },
  },
];

export interface ParallelToolsOptions {
  timeoutMs?: number;
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** Connect once, register the returned tools, and close when the caller is done. */
export async function connectParallelTools(options: ParallelToolsOptions = {}) {
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("timeoutMs must be a positive finite number.");
  }

  const client = new Client({ name: "reins-parallel-search-example", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(PARALLEL_URL), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("User-Agent", USER_AGENT);
      return (options.fetchFn ?? fetch)(input, { ...init, headers, credentials: "omit" });
    },
  });

  try {
    await client.connect(transport, { timeout });
    const available = await client.listTools({}, { timeout });
    for (const name of ["web_search", "web_fetch"]) {
      if (!available.tools.some((tool) => tool.name === name)) {
        throw new Error(`Parallel MCP did not advertise ${name}.`);
      }
    }
  } catch (error) {
    await client.close();
    throw error;
  }

  const tools: Tool[] = definitions.map((definition) => ({
    definition,
    async execute(args, context) {
      // Keep a stable session per conversation without sending its raw identifier.
      const sessionId = createHash("sha256").update(context.conversationId).digest("hex");
      const parameters = Object.fromEntries(
        Object.keys(definition.parameters.properties)
          .filter((key) => args[key] !== undefined)
          .map((key) => [key, args[key]]),
      );
      const response = CallToolResultSchema.parse(await client.callTool({
        name: definition.name.replace("parallel_", ""),
        arguments: { ...parameters, session_id: sessionId },
      }, undefined, { signal: context.abortSignal, timeout }));

      if (response.isError) {
        const message = response.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        return {
          callId: "",
          name: definition.name,
          result: null,
          error: message || "Parallel MCP tool failed.",
        };
      }

      // Preserve MCP content (including source URLs) for the consuming application.
      return { callId: "", name: definition.name, result: response };
    },
  }));

  return { tools, close: () => client.close() };
}

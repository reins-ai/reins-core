# Parallel Search MCP example

Search for current information and fetch source pages through Reins' `ToolRegistry`
and `ToolExecutor` with [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp).
The anonymous endpoint needs no account or API key. Search uses Fast mode; the
free tier is intended for exploration and light use and has rate limits.

## Run

Install [Bun](https://bun.sh), then run from the repository root:

```bash
bun install --frozen-lockfile
cd examples/parallel-search
bun install --frozen-lockfile
bun run start search "Bun TypeScript documentation"
bun run start fetch "https://bun.sh/docs"
```

Each command prints a Reins `ToolResult` with MCP content blocks containing source
excerpts. Tool failures print an `error` and exit with a nonzero status. Press
Ctrl+C to cancel a tool call; MCP requests have a 30-second timeout by default.
Network access to `https://search.parallel.ai/mcp` is required. This example uses
Streamable HTTP and does not read saved credentials or environment API keys.

This is a standalone developer example with local imports from the core source
tree. It does not install tools in the Reins daemon or change the built-in
`web_search` provider. It dispatches tools directly, without a model or agent loop.

## Use in a tool registry

`src/parallel-tools.ts` returns two optional tools: `parallel_web_search` takes
`objective` and `search_queries`; `parallel_web_fetch` takes `urls`, with optional
`objective` and `search_queries`. The server validates these arguments. Search
queries should each contain 3–6 words. Fetch accepts up to 20 URLs and an objective
of at most 200 characters. Results preserve the MCP content rather than converting
it to the built-in web-search provider's result format.

```typescript
import { ToolRegistry } from "../../src/tools/registry";
import { ToolExecutor } from "../../src/tools/executor";
import { connectParallelTools } from "./src/parallel-tools";

const connection = await connectParallelTools({ timeoutMs: 30_000 });
try {
  const registry = new ToolRegistry();
  for (const tool of connection.tools) registry.register(tool);
  const executor = new ToolExecutor(registry);
  const result = await executor.execute({
    id: "search-1",
    name: "parallel_web_search",
    arguments: {
      objective: "Find Bun's TypeScript documentation",
      search_queries: ["Bun TypeScript documentation"],
    },
  }, { conversationId: "research-1", userId: "example" });
  console.log(result);
} finally {
  await connection.close();
}
```

Keep the connection open for related calls and reuse the conversation ID for
search and fetch. The adapter hashes that ID into a stable MCP `session_id`.
Pass `abortSignal` in the tool context to cancel an in-flight call. Keep fetched
content separate from trusted instructions when incorporating it into prompts.

## Verify

From this directory:

```bash
bun run typecheck
bun run test
```

The deterministic tests exercise the MCP transport through Reins' executor without
network access. The `start` commands above make live anonymous requests.
The test script names its check file explicitly so the root test discovery does
not require this example's optional MCP dependency.

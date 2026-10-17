import { ToolExecutor } from "../../../src/tools/executor";
import { ToolRegistry } from "../../../src/tools/registry";
import { connectParallelTools } from "./parallel-tools";

const [action, ...words] = process.argv.slice(2);
const input = words.join(" ").trim();
if ((action !== "search" && action !== "fetch") || !input) {
  console.error('Usage: bun run start search "Bun TypeScript documentation"');
  console.error('       bun run start fetch "https://bun.sh/docs"');
  process.exit(1);
}

const connection = await connectParallelTools();
try {
  const registry = new ToolRegistry();
  for (const tool of connection.tools) registry.register(tool);
  const executor = new ToolExecutor(registry);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);

  try {
    const result = await executor.execute({
      id: crypto.randomUUID(),
      name: `parallel_web_${action}`,
      arguments: action === "search"
        ? { objective: input, search_queries: [input] }
        : { urls: [input] },
    }, {
      conversationId: crypto.randomUUID(),
      userId: "parallel-search-example",
      abortSignal: controller.signal,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.error) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
} finally {
  await connection.close();
}

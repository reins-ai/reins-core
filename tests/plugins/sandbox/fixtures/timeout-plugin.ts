import type { PluginContext } from "../../../../src/types";

export default async function setupPlugin(context: PluginContext): Promise<void> {
  context.on("message", async () => {
    const start = Date.now();
    while (Date.now() - start < 250) {
      // busy loop to simulate CPU-heavy work
    }
  });
}

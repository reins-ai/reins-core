import type { PluginContext } from "../../../../src/types";

export default async function setupPlugin(context: PluginContext): Promise<void> {
  context.on("message", async () => {
    throw new Error("plugin-crash");
  });
}

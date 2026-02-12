import type { PluginContext } from "../../../../src/types";

export default async function setupPlugin(context: PluginContext): Promise<void> {
  context.on("message", async () => {
    await context.data.notes.list({ limit: 1 });
    context.log.info("notes-list-called");
  });
}

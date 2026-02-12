import type { PluginContext } from "../../../../src/types";

export default async function setupPlugin(context: PluginContext): Promise<void> {
  context.registerTool({
    definition: {
      name: "echo",
      description: "Echoes input text",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to echo" },
        },
        required: ["text"],
      },
    },
    async execute(args, executionContext) {
      return {
        callId: executionContext.conversationId,
        name: "echo",
        result: {
          text: args.text,
          userId: executionContext.userId,
        },
      };
    },
  });

  context.on("message", async () => {
    context.log.info("message-received");
  });
}

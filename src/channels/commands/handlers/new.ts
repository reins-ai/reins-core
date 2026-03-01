import type { CommandContext, CommandHandler, CommandResult } from "../types";

/**
 * `/new` command handler.
 *
 * Creates a fresh conversation via the conversation manager and updates
 * the context binding. An optional title can be provided as arguments;
 * when omitted the conversation is created with a default title.
 */
export const newHandler: CommandHandler = async (
  context: CommandContext,
  args: string[],
): Promise<CommandResult> => {
  const title = args.length > 0 ? args.join(" ").trim() : undefined;

  try {
    const conversation = await context.conversationManager.create({
      title: title ?? "New conversation",
      model: context.currentModel,
      provider: context.currentProvider,
    });

    context.setConversationId(conversation.id);

    const titleDisplay = title ? ` — "${title}"` : "";
    return {
      kind: "text",
      text: `Started new conversation${titleDisplay}\nID: \`${conversation.id}\``,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      kind: "text",
      text: `Failed to create conversation: ${message}`,
      success: false,
      error: "CREATE_FAILED",
    };
  }
};

import type { CommandContext, CommandHandler, CommandResult } from "../types";

/**
 * `/clear` command handler.
 *
 * Clears the current conversation by deleting it and creating a fresh one.
 * The new conversation inherits the current model and provider settings.
 * If no conversation is active, returns an informational message.
 */
export const clearHandler: CommandHandler = async (
  context: CommandContext,
  _args: string[],
): Promise<CommandResult> => {
  if (!context.conversationId) {
    return {
      kind: "text",
      text: "No active conversation to clear. Use `/new` to start one.",
      success: true,
    };
  }

  const oldId = context.conversationId;

  try {
    await context.conversationManager.delete(oldId);
  } catch (_error) {
    // Delete may fail if conversation was already removed — continue to create new one
  }

  try {
    const newConversation = await context.conversationManager.create({
      model: context.currentModel,
      provider: context.currentProvider,
    });
    context.setConversationId(newConversation.id);

    return {
      kind: "text",
      text: `Conversation cleared. Started fresh.\nNew ID: \`${newConversation.id}\``,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      kind: "text",
      text: `Cleared old conversation but failed to create new one: ${message}`,
      success: false,
      error: "CREATE_FAILED",
    };
  }
};

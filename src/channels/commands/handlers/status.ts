import type { CommandContext, CommandHandler, CommandResult } from "../types";

/**
 * `/status` command handler.
 *
 * Returns the current session status including the active model, provider,
 * conversation ID, platform, and user identity.
 */
export const statusHandler: CommandHandler = async (
  context: CommandContext,
  _args: string[],
): Promise<CommandResult> => {
  const model = context.currentModel ?? "not set";
  const provider = context.currentProvider ?? "not set";
  const conversationId =
    context.conversationId ?? "none (no active conversation)";
  const platform = context.platform;
  const senderDisplay = context.senderName ?? context.senderId;

  const lines = [
    "**Reins Status**",
    "",
    `User: ${senderDisplay}`,
    `Model: ${model}`,
    `Provider: ${provider}`,
    `Conversation: ${conversationId}`,
    `Platform: ${platform}`,
  ];

  return {
    kind: "text",
    text: lines.join("\n"),
    success: true,
  };
};

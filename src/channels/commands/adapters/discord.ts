import type { CommandMenuItem, CommandResult, PendingCommandState } from "../types";
import { PENDING_COMMAND_TTL_MS } from "../types";

/**
 * Injectable send function for dispatching messages to a Discord channel.
 */
export type DiscordSendFn = (channelId: string, text: string) => Promise<void>;

/**
 * Render a platform-agnostic CommandResult as Discord text.
 *
 * - Text results → plain message
 * - Menu results → numbered list ("1. Option\n2. Option\nReply with a number to select.")
 * - Confirmation results → yes/no prompt
 */
export async function renderCommandResult(
  result: CommandResult,
  channelId: string,
  sendFn: DiscordSendFn,
): Promise<void> {
  if (result.kind === "text") {
    await sendFn(channelId, result.text);
    return;
  }

  if (result.kind === "menu") {
    const numberedItems = result.items.map((item, i) => {
      const desc = item.description ? ` — ${item.description}` : "";
      return `${i + 1}. **${item.label}**${desc}`;
    });
    const text = `${result.text}\n\n${numberedItems.join("\n")}\n\nReply with a number to select.`;
    await sendFn(channelId, text);
    return;
  }

  if (result.kind === "confirmation") {
    await sendFn(channelId, `${result.text}\n\nReply with **yes** or **no**.`);
  }
}

/**
 * Handle a numeric reply from a Discord user selecting from a numbered menu.
 *
 * Checks TTL on the pending state, validates the number, and dispatches the
 * selected item ID to `onSelect`. Renders the resulting CommandResult.
 *
 * @param replyText    The user's reply text (expected to be a number).
 * @param pendingState The active pending command state.
 * @param menuItems    The menu items that were shown to the user.
 * @param onSelect     Callback that processes the selected item ID.
 * @param channelId    Discord channel ID to send responses to.
 * @param sendFn       Injectable Discord send function.
 */
export async function handleNumberReply(
  replyText: string,
  pendingState: PendingCommandState,
  menuItems: CommandMenuItem[],
  onSelect: (selectedId: string, pendingState: PendingCommandState) => Promise<CommandResult>,
  channelId: string,
  sendFn: DiscordSendFn,
): Promise<void> {
  if (Date.now() - pendingState.createdAt > PENDING_COMMAND_TTL_MS) {
    await sendFn(channelId, "Session expired. Please run the command again.");
    return;
  }

  const num = parseInt(replyText.trim(), 10);
  if (isNaN(num) || num < 1 || num > menuItems.length) {
    await sendFn(channelId, `Please reply with a number between 1 and ${menuItems.length}.`);
    return;
  }

  const selectedItem = menuItems[num - 1];
  if (!selectedItem) {
    await sendFn(channelId, "Invalid selection. Please try again.");
    return;
  }

  let result: CommandResult;
  try {
    result = await onSelect(selectedItem.id, pendingState);
  } catch (error) {
    const message = error instanceof Error ? error.message : "An error occurred";
    await sendFn(channelId, `Error: ${message}`);
    return;
  }

  await renderCommandResult(result, channelId, sendFn);
}

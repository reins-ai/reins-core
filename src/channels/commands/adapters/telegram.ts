import { TelegramClient } from "../../telegram/client";
import type {
  TelegramCallbackQuery,
  TelegramInlineKeyboardMarkup,
} from "../../telegram/types";
import type { CommandResult, PendingCommandState } from "../types";
import { PENDING_COMMAND_TTL_MS } from "../types";

/**
 * Render a platform-agnostic command result into Telegram message output.
 */
export async function renderCommandResult(
  result: CommandResult,
  chatId: string | number,
  client: TelegramClient,
): Promise<void> {
  if (result.kind === "text") {
    await client.sendMessage(chatId, result.text);
    return;
  }

  if (result.kind === "menu") {
    const keyboard: TelegramInlineKeyboardMarkup = {
      inline_keyboard: result.items.map((item) => [{
        text: item.label,
        callback_data: item.id,
      }]),
    };
    await client.sendMessage(chatId, result.text, { replyMarkup: keyboard });
    return;
  }

  const keyboard: TelegramInlineKeyboardMarkup = {
    inline_keyboard: [[
      { text: "Yes", callback_data: result.confirmId },
      { text: "No", callback_data: result.cancelId },
    ]],
  };
  await client.sendMessage(chatId, result.text, { replyMarkup: keyboard });
}

/**
 * Handle a Telegram callback query and dispatch it into command processing.
 */
export async function handleCallbackQuery(
  query: TelegramCallbackQuery,
  pendingState: PendingCommandState | undefined,
  onDispatch: (
    callbackId: string,
    pendingState: PendingCommandState | undefined,
  ) => Promise<CommandResult>,
  client: TelegramClient,
): Promise<void> {
  const chatId = query.message?.chat.id ?? query.from.id;
  const callbackData = query.data ?? "";
  const messageId = query.message?.message_id;

  try {
    await client.answerCallbackQuery(query.id);
  } catch (_error) {
    // Ignore callback answer failures to avoid interrupting command flow.
  }

  if (pendingState && Date.now() - pendingState.createdAt > PENDING_COMMAND_TTL_MS) {
    await client.sendMessage(chatId, "Session expired. Please run the command again.");
    return;
  }

  let result: CommandResult;
  try {
    result = await onDispatch(callbackData, pendingState);
  } catch (error) {
    const message = error instanceof Error ? error.message : "An error occurred";
    await client.sendMessage(chatId, `Error: ${message}`);
    return;
  }

  await renderCommandResult(result, chatId, client);

  if (result.flags?.includes("deleteUserMessage") && messageId !== undefined) {
    try {
      await client.deleteMessage(chatId, messageId);
    } catch (_error) {
      // Best-effort deletion to avoid leaking failures to end users.
    }
  }
}

/**
 * Handle a plain text user reply while a multi-step command is pending.
 */
export async function handleUserMessageForPending(
  text: string,
  chatId: string | number,
  messageId: number,
  pendingState: PendingCommandState,
  onReply: (
    replyText: string,
    pendingState: PendingCommandState,
  ) => Promise<CommandResult>,
  client: TelegramClient,
): Promise<void> {
  let result: CommandResult;
  try {
    result = await onReply(text, pendingState);
  } catch (error) {
    const message = error instanceof Error ? error.message : "An error occurred";
    await client.sendMessage(chatId, `Error: ${message}`);
    return;
  }

  if (result.flags?.includes("deleteUserMessage")) {
    try {
      await client.deleteMessage(chatId, messageId);
    } catch (_error) {
      // Best-effort deletion to avoid leaking failures to end users.
    }
  }

  await renderCommandResult(result, chatId, client);
}

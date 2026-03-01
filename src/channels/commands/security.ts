import { ChannelAuthService } from "../auth-service";
import type { CommandResult } from "./types";

/**
 * Result of a command authorization check.
 *
 * When `authorized` is `true`, the command may proceed.
 * When `authorized` is `false`, `result` contains a user-friendly
 * rejection `CommandResult` that the caller can render to the channel.
 */
export type CommandAuthResult =
  | { authorized: true }
  | { authorized: false; result: CommandResult };

/**
 * Check whether a sender is authorized to execute commands on a channel.
 *
 * Delegates to {@link ChannelAuthService.isAuthorized} — no additional
 * auth logic is introduced. Unauthorized senders receive a rejection
 * `CommandResult` (not a thrown error), so the caller can render it to
 * the channel like any other command response.
 *
 * @param channelId   - Channel to check authorization for.
 * @param senderId    - Sender's platform user ID.
 * @param authService - The channel auth service instance.
 * @returns Authorization result indicating success or rejection with a renderable result.
 */
export async function checkCommandAuthorization(
  channelId: string,
  senderId: string,
  authService: ChannelAuthService,
): Promise<CommandAuthResult> {
  const isAuthorized = await authService.isAuthorized(channelId, senderId);

  if (isAuthorized) {
    return { authorized: true };
  }

  return {
    authorized: false,
    result: {
      kind: "text",
      text: "You are not authorized to use commands on this channel.",
      success: false,
      error: "UNAUTHORIZED",
    },
  };
}

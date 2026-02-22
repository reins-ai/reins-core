import type { ChannelAuthStorage } from "./auth-storage";

/**
 * Service layer for per-channel user authentication.
 *
 * Wraps a {@link ChannelAuthStorage} implementation with auth-check
 * logic and sender ID validation. Enforces **strict-default semantics**:
 * a channel with no configured users rejects every sender. There is no
 * configuration toggle to disable auth — it is always on.
 *
 * Sender IDs that are empty, whitespace-only, or the literal `"0"` are
 * always treated as unauthorized, regardless of the allow-list contents.
 */
export class ChannelAuthService {
  constructor(private readonly storage: ChannelAuthStorage) {}

  /**
   * Check whether `senderId` is authorized to send messages on
   * `channelId`.
   *
   * **Strict-default semantics:**
   * - Empty, whitespace-only, or `"0"` sender IDs → always `false`.
   * - No users configured for the channel → always `false`.
   * - Returns `true` only when `senderId` is explicitly present in
   *   the channel's allow-list.
   *
   * @param channelId - Plain string channel identifier (platform-agnostic).
   * @param senderId  - Platform-native user ID of the message sender.
   * @returns `true` if the sender is explicitly authorized; `false` otherwise.
   */
  async isAuthorized(
    channelId: string,
    senderId: string,
  ): Promise<boolean> {
    if (!senderId || senderId.trim() === "" || senderId === "0") {
      return false;
    }

    const users = await this.storage.getAuthorizedUsers(channelId);
    if (users.length === 0) {
      return false;
    }

    return users.includes(senderId);
  }

  /**
   * Add a user to the channel's allow-list.
   *
   * @param channelId - Plain string channel identifier.
   * @param userId    - Platform-native user ID to authorize.
   */
  async addUser(channelId: string, userId: string): Promise<void> {
    await this.storage.addUser(channelId, userId);
  }

  /**
   * Remove a user from the channel's allow-list.
   *
   * @param channelId - Plain string channel identifier.
   * @param userId    - Platform-native user ID to remove.
   * @returns `true` if the user was present and removed; `false` if
   *          not found.
   */
  async removeUser(
    channelId: string,
    userId: string,
  ): Promise<boolean> {
    return this.storage.removeUser(channelId, userId);
  }

  /**
   * List all authorized user IDs for a channel.
   *
   * @param channelId - Plain string channel identifier.
   * @returns Array of authorized user ID strings (empty if none).
   */
  async listUsers(channelId: string): Promise<string[]> {
    return this.storage.listUsers(channelId);
  }
}

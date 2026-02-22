import { ChannelError } from "./errors";

/**
 * Channel authentication domain error for allow-list operations.
 */
export class ChannelAuthError extends ChannelError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.code = "CHANNEL_AUTH_ERROR";
    this.name = "ChannelAuthError";
  }
}

/**
 * Persisted JSON shape for the channel allow-list file.
 *
 * Each key is a `channelId` string mapping to an array of authorized
 * user ID strings.
 *
 * @example
 * ```json
 * {
 *   "telegram:123456": ["user1", "user2"],
 *   "discord:789012": ["user3"]
 * }
 * ```
 */
export type ChannelAuthData = Record<string, string[]>;

/**
 * Storage interface for per-channel user allow-lists.
 *
 * All methods are keyed by a plain `channelId` string — no platform
 * enum dependency. Implementations may persist to disk, memory, or
 * any other backing store.
 */
export interface ChannelAuthStorage {
  /**
   * Return the list of authorized user IDs for a channel.
   *
   * Used by the auth service to check whether a sender is allowed.
   * Returns an empty array when no users have been added.
   */
  getAuthorizedUsers(channelId: string): Promise<string[]>;

  /**
   * Add a user to the channel's allow-list.
   *
   * @returns `true` if the user was newly added, `false` if already
   *          present.
   */
  addUser(channelId: string, userId: string): Promise<boolean>;

  /**
   * Remove a user from the channel's allow-list.
   *
   * @returns `true` if the user was present and removed, `false` if
   *          not found.
   */
  removeUser(channelId: string, userId: string): Promise<boolean>;

  /**
   * List all authorized user IDs for a channel.
   *
   * Semantically identical to {@link getAuthorizedUsers}; provided
   * separately so the service layer can use `getAuthorizedUsers` for
   * auth checks and `listUsers` for display purposes.
   */
  listUsers(channelId: string): Promise<string[]>;

  /**
   * Return the complete allow-list data for all channels.
   *
   * Used for admin listing of all authorized users across channels.
   */
  getAllData(): Promise<ChannelAuthData>;
}

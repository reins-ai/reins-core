import type { ChannelAuthData, ChannelAuthStorage } from "./auth-storage";

/**
 * In-memory implementation of `ChannelAuthStorage` backed by a
 * `Map<string, Set<string>>`. Intended for use in unit tests — no
 * file I/O or external dependencies.
 */
export class InMemoryChannelAuthStorage implements ChannelAuthStorage {
  private readonly data: Map<string, Set<string>>;

  constructor(initial?: ChannelAuthData) {
    this.data = new Map();
    if (initial) {
      for (const [channelId, users] of Object.entries(initial)) {
        this.data.set(channelId, new Set(users));
      }
    }
  }

  getAuthorizedUsers(channelId: string): Promise<string[]> {
    return Promise.resolve([...this.data.get(channelId) ?? []]);
  }

  addUser(channelId: string, userId: string): Promise<boolean> {
    let set = this.data.get(channelId);
    if (set === undefined) {
      set = new Set();
      this.data.set(channelId, set);
    }
    if (set.has(userId)) {
      return Promise.resolve(false);
    }
    set.add(userId);
    return Promise.resolve(true);
  }

  removeUser(channelId: string, userId: string): Promise<boolean> {
    const set = this.data.get(channelId);
    if (set === undefined || !set.has(userId)) {
      return Promise.resolve(false);
    }
    set.delete(userId);
    if (set.size === 0) {
      this.data.delete(channelId);
    }
    return Promise.resolve(true);
  }

  listUsers(channelId: string): Promise<string[]> {
    return Promise.resolve([...this.data.get(channelId) ?? []]);
  }
}

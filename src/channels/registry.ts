import { ChannelError } from "./errors";
import type { Channel } from "./types";

function normalizeChannelId(channelId: string): string {
  return channelId.trim().toLowerCase();
}

export class ChannelRegistry {
  private readonly channels = new Map<string, Channel>();

  register(channel: Channel): void {
    const channelId = normalizeChannelId(channel.config.id);

    if (this.channels.has(channelId)) {
      throw new ChannelError(`Channel already registered: ${channelId}`);
    }

    this.channels.set(channelId, channel);
  }

  get(id: string): Channel | undefined {
    return this.channels.get(normalizeChannelId(id));
  }

  list(): Channel[] {
    return Array.from(this.channels.values());
  }

  remove(id: string): boolean {
    return this.channels.delete(normalizeChannelId(id));
  }

  has(id: string): boolean {
    return this.channels.has(normalizeChannelId(id));
  }

  clear(): void {
    this.channels.clear();
  }

  enable(id: string): boolean {
    const channel = this.get(id);
    if (!channel) {
      return false;
    }

    channel.config.enabled = true;
    return true;
  }

  disable(id: string): boolean {
    const channel = this.get(id);
    if (!channel) {
      return false;
    }

    channel.config.enabled = false;
    return true;
  }
}

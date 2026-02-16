import { describe, expect, it } from "bun:test";

import { ChannelError } from "../../src/channels/errors";
import { ChannelRegistry } from "../../src/channels/registry";
import type { Channel, ChannelConfig, ChannelMessage, ChannelMessageHandler, ChannelStatus } from "../../src/channels/types";

function createChannel(config: Partial<ChannelConfig> = {}): Channel {
  const channelConfig: ChannelConfig = {
    id: config.id ?? "telegram-main",
    platform: config.platform ?? "telegram",
    tokenReference: config.tokenReference ?? "token-ref",
    enabled: config.enabled ?? true,
  };

  const status: ChannelStatus = {
    state: "disconnected",
    uptimeMs: 0,
  };

  return {
    config: channelConfig,
    status,
    async connect(): Promise<void> {
      return;
    },
    async disconnect(): Promise<void> {
      return;
    },
    async send(_message: ChannelMessage): Promise<void> {
      return;
    },
    onMessage(_handler: ChannelMessageHandler): () => void {
      return () => {
        return;
      };
    },
  };
}

describe("ChannelRegistry", () => {
  it("registers and gets a channel by id", () => {
    const registry = new ChannelRegistry();
    const channel = createChannel({ id: "telegram" });

    registry.register(channel);

    expect(registry.get("telegram")).toBe(channel);
    expect(registry.has("telegram")).toBe(true);
  });

  it("normalizes channel ids for register, get, has, and remove", () => {
    const registry = new ChannelRegistry();
    const channel = createChannel({ id: "  TeLeGrAm  " });

    registry.register(channel);

    expect(registry.get("telegram")).toBe(channel);
    expect(registry.get("  TELEGRAM ")).toBe(channel);
    expect(registry.has(" TELEGRAM")).toBe(true);
    expect(registry.remove(" telegram ")).toBe(true);
    expect(registry.has("telegram")).toBe(false);
  });

  it("throws on duplicate channel id", () => {
    const registry = new ChannelRegistry();

    registry.register(createChannel({ id: "discord" }));

    expect(() => registry.register(createChannel({ id: " DISCORD " }))).toThrow(ChannelError);
  });

  it("returns all channels in registration order", () => {
    const registry = new ChannelRegistry();
    const first = createChannel({ id: "telegram" });
    const second = createChannel({ id: "discord", platform: "discord" });

    registry.register(first);
    registry.register(second);

    expect(registry.list()).toEqual([first, second]);
  });

  it("removes channels and returns whether channel existed", () => {
    const registry = new ChannelRegistry();
    registry.register(createChannel({ id: "temporary" }));

    expect(registry.remove("temporary")).toBe(true);
    expect(registry.remove("temporary")).toBe(false);
    expect(registry.has("temporary")).toBe(false);
  });

  it("clears all channels", () => {
    const registry = new ChannelRegistry();
    registry.register(createChannel({ id: "telegram" }));
    registry.register(createChannel({ id: "discord", platform: "discord" }));

    registry.clear();

    expect(registry.list()).toHaveLength(0);
    expect(registry.has("telegram")).toBe(false);
    expect(registry.has("discord")).toBe(false);
  });

  it("enables a channel", () => {
    const registry = new ChannelRegistry();
    const channel = createChannel({ id: "telegram", enabled: false });
    registry.register(channel);

    expect(registry.enable("  TELEGRAM ")).toBe(true);
    expect(channel.config.enabled).toBe(true);
  });

  it("disables a channel", () => {
    const registry = new ChannelRegistry();
    const channel = createChannel({ id: "discord", platform: "discord", enabled: true });
    registry.register(channel);

    expect(registry.disable("discord")).toBe(true);
    expect(channel.config.enabled).toBe(false);
  });

  it("returns false when toggling a missing channel", () => {
    const registry = new ChannelRegistry();

    expect(registry.enable("missing")).toBe(false);
    expect(registry.disable("missing")).toBe(false);
  });
});

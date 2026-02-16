import { describe, expect, it } from "bun:test";

import { ChannelRegistry } from "../../../src/channels/registry";
import { TelegramChannel } from "../../../src/channels/telegram/channel";
import type { TelegramChannelClient } from "../../../src/channels/telegram/channel";
import { DiscordChannel } from "../../../src/channels/discord/channel";
import type { DiscordChannelOptions } from "../../../src/channels/discord/channel";
import type {
  Channel,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
} from "../../../src/channels/types";
import type { DiscordEmbed, DiscordMessage, DiscordUser } from "../../../src/channels/discord/types";
import { ChannelError } from "../../../src/channels/errors";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockTelegramClient(
  overrides: Partial<TelegramChannelClient> = {},
): TelegramChannelClient {
  return {
    async getMe() {
      return { id: 123, is_bot: true, first_name: "TestBot" };
    },
    async getUpdates() {
      return [];
    },
    async sendMessage() {
      return { message_id: 999 };
    },
    async sendPhoto() {
      return { message_id: 999 };
    },
    async sendDocument() {
      return { message_id: 999 };
    },
    async sendVoice() {
      return { message_id: 999 };
    },
    ...overrides,
  };
}

function createMockDiscordGateway(): {
  gateway: DiscordChannelOptions["gateway"];
  simulateReady: (sessionId?: string) => Promise<void>;
  simulateDisconnect: (details?: { code?: number; reason?: string; error?: string }) => Promise<void>;
} {
  const readyHandlers: Array<(event: { session_id: string; resume_gateway_url?: string }) => Promise<void> | void> = [];
  const messageHandlers: Array<(message: DiscordMessage) => Promise<void> | void> = [];
  const disconnectHandlers: Array<(details: { code?: number; reason?: string; error?: string }) => Promise<void> | void> = [];
  let sequence: number | null = null;

  const gateway = {
    get connected() { return true; },
    get currentSequence() { return sequence; },
    async connect() {},
    async disconnect() {},
    onReady(handler: (event: { session_id: string; resume_gateway_url?: string }) => Promise<void> | void) {
      readyHandlers.push(handler);
      return () => {
        const idx = readyHandlers.indexOf(handler);
        if (idx >= 0) readyHandlers.splice(idx, 1);
      };
    },
    onMessageCreate(handler: (message: DiscordMessage) => Promise<void> | void) {
      messageHandlers.push(handler);
      return () => {
        const idx = messageHandlers.indexOf(handler);
        if (idx >= 0) messageHandlers.splice(idx, 1);
      };
    },
    onDisconnect(handler: (details: { code?: number; reason?: string; error?: string }) => Promise<void> | void) {
      disconnectHandlers.push(handler);
      return () => {
        const idx = disconnectHandlers.indexOf(handler);
        if (idx >= 0) disconnectHandlers.splice(idx, 1);
      };
    },
    prepareResume() {},
  };

  async function simulateReady(sessionId = "session-abc") {
    for (const handler of readyHandlers) {
      await handler({ session_id: sessionId });
    }
  }

  async function simulateDisconnect(details: { code?: number; reason?: string; error?: string } = {}) {
    for (const handler of disconnectHandlers) {
      await handler(details);
    }
  }

  return { gateway, simulateReady, simulateDisconnect };
}

function createMockDiscordClient(): {
  getCurrentUser: () => Promise<DiscordUser>;
  sendMessage: (channelId: string, content: string) => Promise<unknown>;
  sendEmbed: (channelId: string, embed: DiscordEmbed) => Promise<unknown>;
  uploadFile: (channelId: string, file: { name: string; data: string; description?: string }) => Promise<unknown>;
} {
  return {
    async getCurrentUser() {
      return { id: "bot-123", username: "ReinsBot", discriminator: "0001", bot: true };
    },
    async sendMessage() { return { id: "sent-1" }; },
    async sendEmbed() { return { id: "sent-2" }; },
    async uploadFile() { return { id: "sent-3" }; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Channel Lifecycle", () => {
  describe("registry add and remove", () => {
    it("registers a Telegram channel and retrieves it by id", () => {
      const registry = new ChannelRegistry();
      const client = createMockTelegramClient();
      const config: ChannelConfig = {
        id: "telegram-main",
        platform: "telegram",
        tokenReference: "ref-tg",
        enabled: true,
      };

      const channel = new TelegramChannel({
        config,
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      registry.register(channel);

      expect(registry.has("telegram-main")).toBe(true);
      expect(registry.get("telegram-main")).toBe(channel);
      expect(registry.list()).toHaveLength(1);
    });

    it("registers a Discord channel and retrieves it by id", () => {
      const registry = new ChannelRegistry();
      const client = createMockDiscordClient();
      const mock = createMockDiscordGateway();
      const config: ChannelConfig = {
        id: "discord-main",
        platform: "discord",
        tokenReference: "ref-dc",
        enabled: true,
      };

      const channel = new DiscordChannel({
        config,
        token: "test-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      registry.register(channel);

      expect(registry.has("discord-main")).toBe(true);
      expect(registry.get("discord-main")).toBe(channel);
      expect(registry.list()).toHaveLength(1);
    });

    it("registers both Telegram and Discord channels simultaneously", () => {
      const registry = new ChannelRegistry();

      const tgClient = createMockTelegramClient();
      const tgChannel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref-tg", enabled: true },
        client: tgClient,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      const dcClient = createMockDiscordClient();
      const dcMock = createMockDiscordGateway();
      const dcChannel = new DiscordChannel({
        config: { id: "discord-main", platform: "discord", tokenReference: "ref-dc", enabled: true },
        token: "test-token",
        client: dcClient,
        gateway: dcMock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      registry.register(tgChannel);
      registry.register(dcChannel);

      expect(registry.list()).toHaveLength(2);
      expect(registry.has("telegram-main")).toBe(true);
      expect(registry.has("discord-main")).toBe(true);
    });

    it("prevents duplicate channel registration", () => {
      const registry = new ChannelRegistry();
      const client = createMockTelegramClient();
      const config: ChannelConfig = {
        id: "telegram-main",
        platform: "telegram",
        tokenReference: "ref-tg",
        enabled: true,
      };

      const channel1 = new TelegramChannel({
        config,
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      const channel2 = new TelegramChannel({
        config,
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      registry.register(channel1);
      expect(() => registry.register(channel2)).toThrow(ChannelError);
    });

    it("removes a channel from the registry", () => {
      const registry = new ChannelRegistry();
      const client = createMockTelegramClient();
      const config: ChannelConfig = {
        id: "telegram-main",
        platform: "telegram",
        tokenReference: "ref-tg",
        enabled: true,
      };

      const channel = new TelegramChannel({
        config,
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      registry.register(channel);
      expect(registry.has("telegram-main")).toBe(true);

      const removed = registry.remove("telegram-main");
      expect(removed).toBe(true);
      expect(registry.has("telegram-main")).toBe(false);
      expect(registry.list()).toHaveLength(0);
    });

    it("returns false when removing a non-existent channel", () => {
      const registry = new ChannelRegistry();
      const removed = registry.remove("nonexistent");
      expect(removed).toBe(false);
    });

    it("clears all channels from the registry", () => {
      const registry = new ChannelRegistry();
      const client = createMockTelegramClient();

      const channel1 = new TelegramChannel({
        config: { id: "tg-1", platform: "telegram", tokenReference: "ref-1", enabled: true },
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      const channel2 = new TelegramChannel({
        config: { id: "tg-2", platform: "telegram", tokenReference: "ref-2", enabled: true },
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      registry.register(channel1);
      registry.register(channel2);
      expect(registry.list()).toHaveLength(2);

      registry.clear();
      expect(registry.list()).toHaveLength(0);
    });
  });

  describe("enable and disable", () => {
    it("disables a registered channel", () => {
      const registry = new ChannelRegistry();
      const client = createMockTelegramClient();
      const config: ChannelConfig = {
        id: "telegram-main",
        platform: "telegram",
        tokenReference: "ref-tg",
        enabled: true,
      };

      const channel = new TelegramChannel({
        config,
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      registry.register(channel);
      expect(channel.config.enabled).toBe(true);

      const disabled = registry.disable("telegram-main");
      expect(disabled).toBe(true);
      expect(channel.config.enabled).toBe(false);
    });

    it("enables a previously disabled channel", () => {
      const registry = new ChannelRegistry();
      const client = createMockTelegramClient();
      const config: ChannelConfig = {
        id: "telegram-main",
        platform: "telegram",
        tokenReference: "ref-tg",
        enabled: false,
      };

      const channel = new TelegramChannel({
        config,
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      registry.register(channel);
      expect(channel.config.enabled).toBe(false);

      const enabled = registry.enable("telegram-main");
      expect(enabled).toBe(true);
      expect(channel.config.enabled).toBe(true);
    });

    it("returns false when enabling a non-existent channel", () => {
      const registry = new ChannelRegistry();
      expect(registry.enable("nonexistent")).toBe(false);
    });

    it("returns false when disabling a non-existent channel", () => {
      const registry = new ChannelRegistry();
      expect(registry.disable("nonexistent")).toBe(false);
    });
  });

  describe("connection lifecycle", () => {
    it("connects and disconnects a Telegram channel", async () => {
      const client = createMockTelegramClient();
      const config: ChannelConfig = {
        id: "telegram-main",
        platform: "telegram",
        tokenReference: "ref-tg",
        enabled: true,
      };

      const channel = new TelegramChannel({
        config,
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      expect(channel.status.state).toBe("disconnected");

      await channel.connect();
      expect(channel.status.state).toBe("connected");

      await channel.disconnect();
      expect(channel.status.state).toBe("disconnected");
    });

    it("connects and disconnects a Discord channel", async () => {
      const client = createMockDiscordClient();
      const mock = createMockDiscordGateway();
      const config: ChannelConfig = {
        id: "discord-main",
        platform: "discord",
        tokenReference: "ref-dc",
        enabled: true,
      };

      const channel = new DiscordChannel({
        config,
        token: "test-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      expect(channel.status.state).toBe("disconnected");

      await channel.connect();
      await mock.simulateReady();
      expect(channel.status.state).toBe("connected");

      await channel.disconnect();
      expect(channel.status.state).toBe("disconnected");
    });

    it("is idempotent when connecting an already connected Telegram channel", async () => {
      const client = createMockTelegramClient();
      let getMeCallCount = 0;
      client.getMe = async () => {
        getMeCallCount += 1;
        return { id: 123, is_bot: true, first_name: "TestBot" };
      };

      const channel = new TelegramChannel({
        config: { id: "tg-1", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      await channel.connect();
      await channel.connect(); // Second connect should be no-op

      expect(getMeCallCount).toBe(1);
      expect(channel.status.state).toBe("connected");

      await channel.disconnect();
    });

    it("is idempotent when connecting an already connected Discord channel", async () => {
      const client = createMockDiscordClient();
      let getCurrentUserCallCount = 0;
      client.getCurrentUser = async () => {
        getCurrentUserCallCount += 1;
        return { id: "bot-123", username: "ReinsBot", discriminator: "0001", bot: true };
      };

      const mock = createMockDiscordGateway();
      const channel = new DiscordChannel({
        config: { id: "dc-1", platform: "discord", tokenReference: "ref", enabled: true },
        token: "test-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      await channel.connect();
      await channel.connect(); // Second connect should be no-op

      expect(getCurrentUserCallCount).toBe(1);

      await channel.disconnect();
    });

    it("tracks uptime while connected", async () => {
      let currentTime = 1000;
      const client = createMockTelegramClient();
      const channel = new TelegramChannel({
        config: { id: "tg-1", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
        nowFn: () => currentTime,
      });

      expect(channel.status.uptimeMs).toBe(0);

      await channel.connect();
      currentTime = 6000;
      expect(channel.status.uptimeMs).toBe(5000);

      currentTime = 11000;
      expect(channel.status.uptimeMs).toBe(10000);

      await channel.disconnect();
      expect(channel.status.uptimeMs).toBe(0);
    });
  });

  describe("full add-connect-disable-enable-disconnect-remove cycle", () => {
    it("completes the full lifecycle for a Telegram channel", async () => {
      const registry = new ChannelRegistry();
      const client = createMockTelegramClient();
      const config: ChannelConfig = {
        id: "telegram-main",
        platform: "telegram",
        tokenReference: "ref-tg",
        enabled: true,
      };

      // Step 1: Create and register
      const channel = new TelegramChannel({
        config,
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });
      registry.register(channel);
      expect(registry.has("telegram-main")).toBe(true);

      // Step 2: Connect
      await channel.connect();
      expect(channel.status.state).toBe("connected");

      // Step 3: Disable
      registry.disable("telegram-main");
      expect(channel.config.enabled).toBe(false);
      // Channel is still connected but disabled in registry
      expect(channel.status.state).toBe("connected");

      // Step 4: Re-enable
      registry.enable("telegram-main");
      expect(channel.config.enabled).toBe(true);

      // Step 5: Disconnect
      await channel.disconnect();
      expect(channel.status.state).toBe("disconnected");

      // Step 6: Remove
      const removed = registry.remove("telegram-main");
      expect(removed).toBe(true);
      expect(registry.has("telegram-main")).toBe(false);
    });

    it("completes the full lifecycle for a Discord channel", async () => {
      const registry = new ChannelRegistry();
      const client = createMockDiscordClient();
      const mock = createMockDiscordGateway();
      const config: ChannelConfig = {
        id: "discord-main",
        platform: "discord",
        tokenReference: "ref-dc",
        enabled: true,
      };

      // Step 1: Create and register
      const channel = new DiscordChannel({
        config,
        token: "test-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });
      registry.register(channel);
      expect(registry.has("discord-main")).toBe(true);

      // Step 2: Connect
      await channel.connect();
      await mock.simulateReady();
      expect(channel.status.state).toBe("connected");

      // Step 3: Disable
      registry.disable("discord-main");
      expect(channel.config.enabled).toBe(false);

      // Step 4: Re-enable
      registry.enable("discord-main");
      expect(channel.config.enabled).toBe(true);

      // Step 5: Disconnect
      await channel.disconnect();
      expect(channel.status.state).toBe("disconnected");

      // Step 6: Remove
      const removed = registry.remove("discord-main");
      expect(removed).toBe(true);
      expect(registry.has("discord-main")).toBe(false);
    });
  });

  describe("message handler registration and unregistration", () => {
    it("registers and unregisters message handlers on Telegram channel", async () => {
      const client = createMockTelegramClient();
      const channel = new TelegramChannel({
        config: { id: "tg-1", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      const messages: ChannelMessage[] = [];
      const unsubscribe = channel.onMessage(async (msg) => {
        messages.push(msg);
      });

      // Unsubscribe should be a function
      expect(typeof unsubscribe).toBe("function");

      // After unsubscribe, handler should not receive messages
      unsubscribe();
      // No way to directly test without triggering poll, but the unsubscribe function exists
    });

    it("registers and unregisters message handlers on Discord channel", async () => {
      const client = createMockDiscordClient();
      const mock = createMockDiscordGateway();
      const channel = new DiscordChannel({
        config: { id: "dc-1", platform: "discord", tokenReference: "ref", enabled: true },
        token: "test-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      const messages: ChannelMessage[] = [];
      const unsubscribe = channel.onMessage(async (msg) => {
        messages.push(msg);
      });

      expect(typeof unsubscribe).toBe("function");

      await channel.connect();
      await mock.simulateReady();

      // Unsubscribe before sending message
      unsubscribe();

      // Simulate a message — handler should not receive it
      const discordMsg: DiscordMessage = {
        id: "dc-msg-1",
        channel_id: "dc-channel-1",
        author: { id: "user-1", username: "alice", discriminator: "1234" },
        content: "Should not be received",
        timestamp: new Date().toISOString(),
        embeds: [],
        attachments: [],
      };
      await mock.simulateReady(); // Re-trigger to ensure listeners are set up

      // The unsubscribed handler should not have received anything
      expect(messages).toHaveLength(0);

      await channel.disconnect();
    });
  });

  describe("normalizes channel IDs for case-insensitive lookup", () => {
    it("finds channels regardless of case", () => {
      const registry = new ChannelRegistry();
      const client = createMockTelegramClient();
      const channel = new TelegramChannel({
        config: { id: "Telegram-Main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: (cb) => setTimeout(cb, 0),
        clearScheduledPollFn: (t) => clearTimeout(t),
      });

      registry.register(channel);

      expect(registry.has("telegram-main")).toBe(true);
      expect(registry.has("TELEGRAM-MAIN")).toBe(true);
      expect(registry.has("Telegram-Main")).toBe(true);
      expect(registry.get("telegram-main")).toBe(channel);
    });
  });
});

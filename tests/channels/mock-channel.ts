import type {
  Channel,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
} from "../../src/channels/types";

export interface MockChannelOptions {
  config?: Partial<ChannelConfig>;
}

/**
 * Minimal Channel mock for testing auth enforcement and message routing.
 * Tracks sent messages and supports simulating inbound messages.
 */
export class MockChannel implements Channel {
  readonly config: ChannelConfig;
  status: ChannelStatus = {
    state: "disconnected",
    uptimeMs: 0,
  };

  readonly sentMessages: ChannelMessage[] = [];
  readonly typingIndicatorCalls: string[] = [];
  private handlers = new Set<ChannelMessageHandler>();

  constructor(options: MockChannelOptions = {}) {
    this.config = {
      id: options.config?.id ?? "test-channel",
      platform: options.config?.platform ?? "telegram",
      tokenReference: options.config?.tokenReference ?? "test-token",
      enabled: options.config?.enabled ?? true,
    };
  }

  async connect(): Promise<void> {
    this.status = { state: "connected", uptimeMs: 100 };
  }

  async disconnect(): Promise<void> {
    this.status = { state: "disconnected", uptimeMs: 0 };
  }

  async send(message: ChannelMessage): Promise<void> {
    this.sentMessages.push(message);
  }

  async sendTypingIndicator(destinationChannelId: string): Promise<void> {
    this.typingIndicatorCalls.push(destinationChannelId);
  }

  onMessage(handler: ChannelMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Simulate an inbound message from a user.
   * Invokes all registered onMessage handlers.
   */
  async simulateInbound(message: ChannelMessage): Promise<void> {
    for (const handler of this.handlers) {
      await handler(message);
    }
  }
}

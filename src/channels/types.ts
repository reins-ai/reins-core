/**
 * Supported chat channel platforms.
 */
export type ChannelPlatform = "telegram" | "discord";

/**
 * JSON-safe value shape for platform-specific metadata.
 */
export type ChannelMetadataValue =
  | string
  | number
  | boolean
  | null
  | ChannelMetadataValue[]
  | { [key: string]: ChannelMetadataValue };

/**
 * Platform-specific metadata attached to normalized channel entities.
 */
export type ChannelPlatformData = Record<string, ChannelMetadataValue>;

/**
 * Persisted channel configuration for adapter initialization.
 */
export interface ChannelConfig {
  id: string;
  platform: ChannelPlatform;
  tokenReference: string;
  enabled: boolean;
}

/**
 * Current channel connection state.
 */
export type ChannelConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/**
 * Runtime status for a channel connection.
 */
export interface ChannelStatus {
  state: ChannelConnectionState;
  lastError?: string;
  uptimeMs: number;
}

/**
 * Normalized message sender identity.
 */
export interface ChannelSender {
  id: string;
  username?: string;
  displayName?: string;
  isBot?: boolean;
}

/**
 * Normalized attachment payload used across channel adapters.
 */
export interface ChannelAttachment {
  id?: string;
  type: "image" | "video" | "audio" | "file";
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  fileName?: string;
  platformData?: ChannelPlatformData;
}

/**
 * Normalized formatting metadata for rich text rendering.
 */
export interface ChannelFormatting {
  mode: "plain_text" | "markdown" | "markdown_v2" | "html" | "discord_markdown";
  entities?: ChannelFormatEntity[];
}

/**
 * Normalized rich-format token span.
 */
export interface ChannelFormatEntity {
  type: "bold" | "italic" | "underline" | "strikethrough" | "code" | "link";
  offset: number;
  length: number;
  url?: string;
}

/**
 * Normalized voice message payload.
 */
export interface ChannelVoice {
  url?: string;
  mimeType?: string;
  durationMs?: number;
  transcript?: string;
  platformData?: ChannelPlatformData;
}

/**
 * Platform-agnostic message model used by channel adapters.
 */
export interface ChannelMessage {
  id: string;
  platform: ChannelPlatform;
  channelId: string;
  conversationId?: string;
  sender: ChannelSender;
  timestamp: Date;
  text?: string;
  attachments?: ChannelAttachment[];
  formatting?: ChannelFormatting;
  voice?: ChannelVoice;
  replyToMessageId?: string;
  platformData?: ChannelPlatformData;
}

/**
 * Message callback invoked for inbound channel messages.
 */
export type ChannelMessageHandler = (message: ChannelMessage) => Promise<void> | void;

/**
 * Channel adapter contract for Telegram and Discord integrations.
 */
export interface Channel {
  readonly config: ChannelConfig;
  readonly status: ChannelStatus;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendTypingIndicator?(destinationChannelId: string): Promise<void>;
  send(message: ChannelMessage): Promise<void>;
  onMessage(handler: ChannelMessageHandler): () => void;
}

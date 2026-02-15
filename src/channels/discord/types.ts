export const DISCORD_GATEWAY_INTENTS = {
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
} as const;

export const DEFAULT_DISCORD_GATEWAY_INTENTS =
  DISCORD_GATEWAY_INTENTS.GUILD_MESSAGES
  | DISCORD_GATEWAY_INTENTS.DIRECT_MESSAGES
  | DISCORD_GATEWAY_INTENTS.MESSAGE_CONTENT;

export const DISCORD_GATEWAY_OPCODES = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export interface DiscordApiError {
  message: string;
  code: number;
  retry_after?: number;
  global?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  type?: "rich";
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: {
    text: string;
    icon_url?: string;
  };
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  proxy_url: string;
  content_type?: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  embeds: DiscordEmbed[];
  attachments: DiscordAttachment[];
}

export interface DiscordGatewayHelloData {
  heartbeat_interval: number;
}

export interface DiscordGatewayReadyEvent {
  v: number;
  session_id: string;
  user: DiscordUser;
}

export interface DiscordGatewayIdentifyProperties {
  os: string;
  browser: string;
  device: string;
}

export interface DiscordGatewayIdentifyData {
  token: string;
  intents: number;
  properties: DiscordGatewayIdentifyProperties;
}

export interface DiscordGatewayPayload<T = unknown> {
  op: number;
  d: T;
  s: number | null;
  t: string | null;
}

export interface DiscordUploadFileInput {
  name: string;
  data: string | ArrayBuffer | Uint8Array | Blob;
  contentType?: string;
  description?: string;
}

export interface DiscordClientOptions {
  token: string;
  baseUrl?: string;
  gatewayUrl?: string;
  intents?: number;
  fetchFn?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
  sleepFn?: (delayMs: number) => Promise<void>;
  nowFn?: () => number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  gatewayIdentifyProperties?: DiscordGatewayIdentifyProperties;
}

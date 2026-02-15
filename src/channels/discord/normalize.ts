import type {
  ChannelAttachment,
  ChannelFormatting,
  ChannelMessage,
  ChannelPlatformData,
  ChannelSender,
  ChannelVoice,
} from "../types";
import type {
  DiscordAttachment,
  DiscordEmbed,
  DiscordMessage,
} from "./types";

/**
 * Maximum character length for a single Discord message.
 */
const DISCORD_MAX_MESSAGE_LENGTH = 2_000;

/**
 * Default embed color (Reins brand blue).
 */
const DEFAULT_EMBED_COLOR = 0x5865f2;

/**
 * Result of converting a ChannelMessage to Discord send parameters.
 *
 * Exactly one of `content`, `embed`, or `file` is set,
 * indicating which Discord REST method payload to use.
 * When a message exceeds 2000 characters it is split into
 * multiple `chunks` instead of a single `content` field.
 */
export interface DiscordOutbound {
  channelId: string;
  content?: string;
  chunks?: string[];
  embed?: DiscordEmbed;
  file?: DiscordOutboundFile;
}

export interface DiscordOutboundFile {
  url: string;
  fileName?: string;
  description?: string;
}

function extractSender(msg: DiscordMessage): ChannelSender {
  return {
    id: msg.author.id,
    username: msg.author.username,
    displayName: msg.author.global_name ?? msg.author.username,
    isBot: msg.author.bot === true,
  };
}

function extractAttachments(attachments: DiscordAttachment[]): ChannelAttachment[] | undefined {
  if (attachments.length === 0) {
    return undefined;
  }

  const result: ChannelAttachment[] = [];
  for (const att of attachments) {
    const type = inferAttachmentType(att.content_type);
    result.push({
      id: att.id,
      type,
      url: att.url,
      mimeType: att.content_type,
      sizeBytes: att.size,
      fileName: att.filename,
      platformData: {
        attachment_id: att.id,
        proxy_url: att.proxy_url,
      },
    });
  }

  return result.length > 0 ? result : undefined;
}

function inferAttachmentType(contentType: string | undefined): ChannelAttachment["type"] {
  if (contentType === undefined) {
    return "file";
  }

  if (contentType.startsWith("image/")) {
    return "image";
  }

  if (contentType.startsWith("video/")) {
    return "video";
  }

  if (contentType.startsWith("audio/")) {
    return "audio";
  }

  return "file";
}

function extractVoice(attachments: DiscordAttachment[]): ChannelVoice | undefined {
  const voiceAttachment = attachments.find(
    (att) => att.content_type !== undefined && att.content_type.startsWith("audio/"),
  );

  if (voiceAttachment === undefined) {
    return undefined;
  }

  return {
    url: voiceAttachment.url,
    mimeType: voiceAttachment.content_type,
    platformData: {
      attachment_id: voiceAttachment.id,
      filename: voiceAttachment.filename,
      proxy_url: voiceAttachment.proxy_url,
      size: voiceAttachment.size,
    },
  };
}

function extractFormatting(content: string): ChannelFormatting | undefined {
  if (content.length === 0) {
    return undefined;
  }

  const hasMarkdown =
    content.includes("**") ||
    content.includes("__") ||
    content.includes("~~") ||
    content.includes("`") ||
    content.includes("||") ||
    content.includes("[");

  if (!hasMarkdown) {
    return undefined;
  }

  return { mode: "discord_markdown" };
}

function extractEmbedText(embeds: DiscordEmbed[]): string | undefined {
  if (embeds.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const embed of embeds) {
    if (embed.title !== undefined) {
      parts.push(embed.title);
    }
    if (embed.description !== undefined) {
      parts.push(embed.description);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function buildPlatformData(msg: DiscordMessage): ChannelPlatformData {
  const data: ChannelPlatformData = {
    message_id: msg.id,
    channel_id: msg.channel_id,
  };

  if (msg.guild_id !== undefined) {
    data.guild_id = msg.guild_id;
  }

  if (msg.edited_timestamp !== undefined && msg.edited_timestamp !== null) {
    data.edited_timestamp = msg.edited_timestamp;
  }

  if (msg.embeds.length > 0) {
    data.embeds = msg.embeds as unknown as ChannelPlatformData[];
  }

  return data;
}

/**
 * Discord message type constants for detecting non-default messages.
 */
const DISCORD_DEFAULT_MESSAGE_TYPE = 0;

/**
 * Human-readable labels for Discord message types that are not
 * standard user messages.
 */
const DISCORD_SYSTEM_MESSAGE_TYPES: Record<number, string> = {
  6: "pin notification",
  7: "member join",
  8: "server boost",
  9: "server boost tier 1",
  10: "server boost tier 2",
  11: "server boost tier 3",
  14: "channel follow",
  19: "reply",
  20: "application command",
  21: "thread starter",
  22: "invite reminder",
};

/**
 * Detect the type of an unsupported Discord message.
 *
 * Returns a human-readable label for the unsupported content type,
 * or `undefined` when no unsupported payload is detected.
 */
function detectUnsupportedType(msg: DiscordMessage): string | undefined {
  if (msg.sticker_items !== undefined && msg.sticker_items.length > 0) return "sticker";
  if (msg.poll !== undefined) return "poll";
  if (msg.activity !== undefined) return "activity";

  if (msg.type !== undefined && msg.type !== DISCORD_DEFAULT_MESSAGE_TYPE) {
    return DISCORD_SYSTEM_MESSAGE_TYPES[msg.type] ?? "system message";
  }

  return undefined;
}

/**
 * Convert a Discord MESSAGE_CREATE event payload into a platform-agnostic ChannelMessage.
 *
 * Returns `null` only when the message has no detectable content and no
 * recognizable unsupported type.
 *
 * When the message contains an unsupported content type (sticker, poll,
 * activity, etc.), a notification ChannelMessage is returned with text
 * explaining the limitation.
 */
export function normalizeDiscordMessage(msg: DiscordMessage): ChannelMessage | null {
  const text = msg.content.length > 0 ? msg.content : undefined;
  const attachments = extractAttachments(msg.attachments);
  const voice = extractVoice(msg.attachments);
  const embedText = extractEmbedText(msg.embeds);

  const combinedText = text ?? embedText;

  if (combinedText === undefined && attachments === undefined && voice === undefined) {
    const unsupportedType = detectUnsupportedType(msg);
    if (unsupportedType !== undefined) {
      return {
        id: msg.id,
        platform: "discord",
        channelId: msg.channel_id,
        sender: extractSender(msg),
        timestamp: new Date(msg.timestamp),
        text: `Unsupported message type: ${unsupportedType}. Only text, images, documents, and voice are supported.`,
        platformData: buildPlatformData(msg),
      };
    }

    return null;
  }

  return {
    id: msg.id,
    platform: "discord",
    channelId: msg.channel_id,
    sender: extractSender(msg),
    timestamp: new Date(msg.timestamp),
    text: combinedText,
    attachments,
    formatting: combinedText !== undefined ? extractFormatting(combinedText) : undefined,
    voice,
    platformData: buildPlatformData(msg),
  };
}

/**
 * Split text into chunks that respect the Discord 2000-character limit.
 *
 * Splits prefer line boundaries when possible to avoid breaking
 * mid-sentence. Falls back to hard split at the limit.
 */
function splitIntoChunks(text: string, maxLength: number = DISCORD_MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex <= 0 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex <= 0 || splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/, "");
  }

  return chunks;
}

/**
 * Build a Discord embed from a ChannelMessage for rich agent responses.
 *
 * Returns `undefined` when the message has no text content suitable
 * for embed rendering.
 */
function buildEmbed(msg: ChannelMessage): DiscordEmbed | undefined {
  if (msg.text === undefined || msg.text.length === 0) {
    return undefined;
  }

  const embed: DiscordEmbed = {
    description: msg.text.length > DISCORD_MAX_MESSAGE_LENGTH
      ? msg.text.slice(0, DISCORD_MAX_MESSAGE_LENGTH - 3) + "..."
      : msg.text,
    color: DEFAULT_EMBED_COLOR,
  };

  return embed;
}

/**
 * Convert a platform-agnostic ChannelMessage into Discord send parameters.
 *
 * The returned `DiscordOutbound` indicates which Discord REST payload
 * to use (plain content, embed, or file upload) based on the message content.
 *
 * Returns `null` when the message has no sendable content.
 */
export function toDiscordMessage(msg: ChannelMessage): DiscordOutbound | null {
  const channelId = msg.platformData?.channel_id;
  if (channelId === undefined || channelId === null) {
    return null;
  }

  const resolvedChannelId = String(channelId);

  if (msg.voice !== undefined && msg.voice.url !== undefined) {
    return {
      channelId: resolvedChannelId,
      file: {
        url: msg.voice.url,
        fileName: (msg.voice.platformData?.filename as string | undefined) ?? "voice.ogg",
        description: msg.text,
      },
    };
  }

  if (msg.attachments !== undefined && msg.attachments.length > 0) {
    const attachment = msg.attachments[0]!;
    const fileUrl = attachment.url ?? (attachment.platformData?.proxy_url as string | undefined);

    if (fileUrl === undefined) {
      return null;
    }

    return {
      channelId: resolvedChannelId,
      file: {
        url: fileUrl,
        fileName: attachment.fileName,
        description: msg.text,
      },
    };
  }

  const text = msg.text;
  if (text === undefined || text.length === 0) {
    return null;
  }

  if (text.length > DISCORD_MAX_MESSAGE_LENGTH) {
    return {
      channelId: resolvedChannelId,
      chunks: splitIntoChunks(text),
    };
  }

  return {
    channelId: resolvedChannelId,
    content: text,
  };
}

/**
 * Convert a ChannelMessage into a Discord embed payload for rich rendering.
 *
 * Useful for agent responses that benefit from embed formatting.
 * Returns `null` when the message has no embeddable content.
 */
export function toDiscordEmbed(msg: ChannelMessage): { channelId: string; embed: DiscordEmbed } | null {
  const channelId = msg.platformData?.channel_id;
  if (channelId === undefined || channelId === null) {
    return null;
  }

  const embed = buildEmbed(msg);
  if (embed === undefined) {
    return null;
  }

  return {
    channelId: String(channelId),
    embed,
  };
}

export { splitIntoChunks };

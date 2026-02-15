import type {
  ChannelAttachment,
  ChannelFormatEntity,
  ChannelFormatting,
  ChannelMessage,
  ChannelPlatformData,
  ChannelSender,
  ChannelVoice,
} from "../types";
import type {
  TelegramMessage,
  TelegramMessageEntity,
  TelegramSendMediaOptions,
  TelegramSendMessageOptions,
  TelegramUpdate,
} from "./types";

/**
 * Result of converting a ChannelMessage to Telegram send parameters.
 *
 * Exactly one of `text`, `photo`, `document`, or `voice` is set,
 * indicating which Telegram Bot API method to call.
 */
export interface TelegramOutbound {
  chatId: number | string;
  text?: string;
  textOptions?: TelegramSendMessageOptions;
  photo?: string;
  photoOptions?: TelegramSendMediaOptions;
  document?: string;
  documentOptions?: TelegramSendMediaOptions;
  voice?: string;
  voiceOptions?: TelegramSendMediaOptions;
}

const ENTITY_TYPE_MAP: Record<string, ChannelFormatEntity["type"] | undefined> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strikethrough: "strikethrough",
  code: "code",
  pre: "code",
  text_link: "link",
};

function extractSender(msg: TelegramMessage): ChannelSender {
  const from = msg.from;
  if (from === undefined) {
    return {
      id: String(msg.chat.id),
      displayName: msg.chat.title ?? msg.chat.first_name,
      isBot: false,
    };
  }

  const parts = [from.first_name, from.last_name].filter(Boolean);
  return {
    id: String(from.id),
    username: from.username,
    displayName: parts.length > 0 ? parts.join(" ") : undefined,
    isBot: from.is_bot,
  };
}

function mapEntities(entities: TelegramMessageEntity[] | undefined): ChannelFormatEntity[] | undefined {
  if (entities === undefined || entities.length === 0) {
    return undefined;
  }

  const mapped: ChannelFormatEntity[] = [];
  for (const entity of entities) {
    const type = ENTITY_TYPE_MAP[entity.type];
    if (type === undefined) {
      continue;
    }

    const entry: ChannelFormatEntity = {
      type,
      offset: entity.offset,
      length: entity.length,
    };

    if (type === "link" && entity.url !== undefined) {
      entry.url = entity.url;
    }

    mapped.push(entry);
  }

  return mapped.length > 0 ? mapped : undefined;
}

function extractFormatting(msg: TelegramMessage): ChannelFormatting | undefined {
  const entities = msg.entities ?? msg.caption_entities;
  const mapped = mapEntities(entities);
  if (mapped === undefined) {
    return undefined;
  }

  return { mode: "html", entities: mapped };
}

function extractAttachments(msg: TelegramMessage): ChannelAttachment[] | undefined {
  const attachments: ChannelAttachment[] = [];

  if (msg.photo !== undefined && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!;
    attachments.push({
      id: largest.file_id,
      type: "image",
      sizeBytes: largest.file_size,
      platformData: {
        file_id: largest.file_id,
        file_unique_id: largest.file_unique_id,
        width: largest.width,
        height: largest.height,
      },
    });
  }

  if (msg.document !== undefined) {
    attachments.push({
      id: msg.document.file_id,
      type: "file",
      mimeType: msg.document.mime_type,
      sizeBytes: msg.document.file_size,
      fileName: msg.document.file_name,
      platformData: {
        file_id: msg.document.file_id,
        file_unique_id: msg.document.file_unique_id,
      },
    });
  }

  return attachments.length > 0 ? attachments : undefined;
}

function extractVoice(msg: TelegramMessage): ChannelVoice | undefined {
  if (msg.voice === undefined) {
    return undefined;
  }

  return {
    mimeType: msg.voice.mime_type,
    durationMs: msg.voice.duration * 1_000,
    platformData: {
      file_id: msg.voice.file_id,
      file_unique_id: msg.voice.file_unique_id,
      file_size: msg.voice.file_size ?? null,
    },
  };
}

function extractText(msg: TelegramMessage): string | undefined {
  return msg.text ?? msg.caption ?? undefined;
}

function buildPlatformData(msg: TelegramMessage): ChannelPlatformData {
  return {
    message_id: msg.message_id,
    chat_id: msg.chat.id,
    chat_type: msg.chat.type,
    date: msg.date,
  };
}

function extractMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
}

/**
 * Convert a Telegram update into a platform-agnostic ChannelMessage.
 *
 * Returns `null` when the update contains no recognizable message
 * (e.g. callback queries, inline results, or other non-message updates).
 */
export function normalizeTelegramMessage(update: TelegramUpdate): ChannelMessage | null {
  const msg = extractMessage(update);
  if (msg === undefined) {
    return null;
  }

  const text = extractText(msg);
  const attachments = extractAttachments(msg);
  const voice = extractVoice(msg);

  if (text === undefined && attachments === undefined && voice === undefined) {
    return null;
  }

  const replyToMessageId =
    msg.reply_to_message !== undefined ? String(msg.reply_to_message.message_id) : undefined;

  return {
    id: String(msg.message_id),
    platform: "telegram",
    channelId: String(msg.chat.id),
    sender: extractSender(msg),
    timestamp: new Date(msg.date * 1_000),
    text,
    attachments,
    formatting: extractFormatting(msg),
    voice,
    replyToMessageId,
    platformData: buildPlatformData(msg),
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Apply ChannelFormatEntity spans to plain text, producing Telegram HTML.
 *
 * Entities are sorted by offset and applied from right-to-left so that
 * inserting tags does not shift earlier offsets.
 */
function applyHtmlEntities(text: string, entities: ChannelFormatEntity[]): string {
  const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);

  let result = escapeHtml(text);

  const tagMap: Record<ChannelFormatEntity["type"], { open: string; close: string } | null> = {
    bold: { open: "<b>", close: "</b>" },
    italic: { open: "<i>", close: "</i>" },
    underline: { open: "<u>", close: "</u>" },
    strikethrough: { open: "<s>", close: "</s>" },
    code: { open: "<code>", close: "</code>" },
    link: null,
  };

  const insertions: Array<{ index: number; tag: string; isClose: boolean }> = [];

  for (const entity of sorted) {
    if (entity.type === "link") {
      const href = entity.url ?? "";
      insertions.push({ index: entity.offset, tag: `<a href="${escapeHtml(href)}">`, isClose: false });
      insertions.push({ index: entity.offset + entity.length, tag: "</a>", isClose: true });
    } else {
      const tags = tagMap[entity.type];
      if (tags !== null) {
        insertions.push({ index: entity.offset, tag: tags.open, isClose: false });
        insertions.push({ index: entity.offset + entity.length, tag: tags.close, isClose: true });
      }
    }
  }

  insertions.sort((a, b) => {
    if (a.index !== b.index) {
      return b.index - a.index;
    }
    return a.isClose ? -1 : 1;
  });

  for (const ins of insertions) {
    result = result.slice(0, ins.index) + ins.tag + result.slice(ins.index);
  }

  return result;
}

function buildMediaOptions(
  msg: ChannelMessage,
): TelegramSendMediaOptions {
  const options: TelegramSendMediaOptions = {};

  const caption = msg.text;
  if (caption !== undefined && caption.length > 0) {
    if (msg.formatting !== undefined && msg.formatting.entities !== undefined && msg.formatting.entities.length > 0) {
      options.caption = applyHtmlEntities(caption, msg.formatting.entities);
      options.parseMode = "HTML";
    } else {
      options.caption = caption;
    }
  }

  if (msg.replyToMessageId !== undefined) {
    const parsed = Number(msg.replyToMessageId);
    if (Number.isFinite(parsed)) {
      options.replyToMessageId = parsed;
    }
  }

  return options;
}

/**
 * Convert a platform-agnostic ChannelMessage into Telegram send parameters.
 *
 * The returned `TelegramOutbound` indicates which Telegram Bot API method
 * to call (sendMessage, sendPhoto, sendDocument, or sendVoice) based on
 * the message content.
 *
 * Returns `null` when the message has no sendable content.
 */
export function toTelegramMessage(msg: ChannelMessage): TelegramOutbound | null {
  const chatId = msg.platformData?.chat_id;
  if (chatId === undefined || chatId === null) {
    return null;
  }

  const resolvedChatId = chatId as number | string;

  if (msg.voice !== undefined && msg.voice.platformData?.file_id !== undefined) {
    return {
      chatId: resolvedChatId,
      voice: msg.voice.platformData.file_id as string,
      voiceOptions: buildMediaOptions(msg),
    };
  }

  if (msg.attachments !== undefined && msg.attachments.length > 0) {
    const attachment = msg.attachments[0]!;
    const fileId = attachment.platformData?.file_id as string | undefined;
    const fileRef = fileId ?? attachment.url;

    if (fileRef === undefined) {
      return null;
    }

    if (attachment.type === "image") {
      return {
        chatId: resolvedChatId,
        photo: fileRef,
        photoOptions: buildMediaOptions(msg),
      };
    }

    return {
      chatId: resolvedChatId,
      document: fileRef,
      documentOptions: buildMediaOptions(msg),
    };
  }

  const text = msg.text;
  if (text === undefined || text.length === 0) {
    return null;
  }

  const options: TelegramSendMessageOptions = {};

  if (msg.formatting !== undefined && msg.formatting.entities !== undefined && msg.formatting.entities.length > 0) {
    const htmlText = applyHtmlEntities(text, msg.formatting.entities);
    options.parseMode = "HTML";

    if (msg.replyToMessageId !== undefined) {
      const parsed = Number(msg.replyToMessageId);
      if (Number.isFinite(parsed)) {
        options.replyToMessageId = parsed;
      }
    }

    return {
      chatId: resolvedChatId,
      text: htmlText,
      textOptions: options,
    };
  }

  if (msg.replyToMessageId !== undefined) {
    const parsed = Number(msg.replyToMessageId);
    if (Number.isFinite(parsed)) {
      options.replyToMessageId = parsed;
    }
  }

  return {
    chatId: resolvedChatId,
    text,
    textOptions: Object.keys(options).length > 0 ? options : undefined,
  };
}

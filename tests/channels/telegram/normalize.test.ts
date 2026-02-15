import { describe, expect, it } from "bun:test";

import type {
  ChannelAttachment,
  ChannelFormatEntity,
  ChannelMessage,
  ChannelVoice,
} from "../../../src/channels/types";
import type {
  TelegramDocument,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUpdate,
  TelegramVoice,
} from "../../../src/channels/telegram/types";
import {
  normalizeTelegramMessage,
  toTelegramMessage,
} from "../../../src/channels/telegram/normalize";
import type { TelegramOutbound } from "../../../src/channels/telegram/normalize";

function createChat(id = 42) {
  return { id, type: "private" as const };
}

function createFrom(id = 101) {
  return {
    id,
    is_bot: false,
    first_name: "Alice",
    last_name: "Smith",
    username: "alice",
  };
}

function createTextMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    date: 1_735_689_600,
    chat: createChat(),
    from: createFrom(),
    text: "Hello world",
    ...overrides,
  };
}

function createUpdate(message: TelegramMessage, updateId = 100): TelegramUpdate {
  return { update_id: updateId, message };
}

function createPhoto(fileId = "photo-file-id"): TelegramPhotoSize[] {
  return [
    { file_id: "thumb-id", file_unique_id: "thumb-uid", width: 90, height: 90, file_size: 1_000 },
    { file_id: fileId, file_unique_id: "photo-uid", width: 800, height: 600, file_size: 50_000 },
  ];
}

function createDocument(overrides: Partial<TelegramDocument> = {}): TelegramDocument {
  return {
    file_id: "doc-file-id",
    file_unique_id: "doc-uid",
    file_name: "report.pdf",
    mime_type: "application/pdf",
    file_size: 120_000,
    ...overrides,
  };
}

function createVoice(overrides: Partial<TelegramVoice> = {}): TelegramVoice {
  return {
    file_id: "voice-file-id",
    file_unique_id: "voice-uid",
    duration: 5,
    mime_type: "audio/ogg",
    file_size: 8_000,
    ...overrides,
  };
}

describe("normalizeTelegramMessage", () => {
  it("normalizes a plain text message", () => {
    const update = createUpdate(createTextMessage());
    const result = normalizeTelegramMessage(update);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("1");
    expect(result!.platform).toBe("telegram");
    expect(result!.channelId).toBe("42");
    expect(result!.text).toBe("Hello world");
    expect(result!.timestamp).toEqual(new Date(1_735_689_600 * 1_000));
    expect(result!.attachments).toBeUndefined();
    expect(result!.voice).toBeUndefined();
  });

  it("extracts sender information from the from field", () => {
    const update = createUpdate(createTextMessage());
    const result = normalizeTelegramMessage(update);

    expect(result!.sender.id).toBe("101");
    expect(result!.sender.username).toBe("alice");
    expect(result!.sender.displayName).toBe("Alice Smith");
    expect(result!.sender.isBot).toBe(false);
  });

  it("falls back to chat info when from is missing", () => {
    const msg = createTextMessage({ from: undefined });
    msg.chat = { id: 42, type: "group", title: "My Group" };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result!.sender.id).toBe("42");
    expect(result!.sender.displayName).toBe("My Group");
    expect(result!.sender.isBot).toBe(false);
  });

  it("stores Telegram metadata in platformData", () => {
    const update = createUpdate(createTextMessage());
    const result = normalizeTelegramMessage(update);

    expect(result!.platformData).toEqual({
      message_id: 1,
      chat_id: 42,
      chat_type: "private",
      date: 1_735_689_600,
    });
  });

  it("normalizes a photo message with caption", () => {
    const msg = createTextMessage({
      text: undefined,
      photo: createPhoto(),
      caption: "Check this out",
    });
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.text).toBe("Check this out");
    expect(result!.attachments).toHaveLength(1);

    const attachment = result!.attachments![0]!;
    expect(attachment.type).toBe("image");
    expect(attachment.id).toBe("photo-file-id");
    expect(attachment.sizeBytes).toBe(50_000);
    expect(attachment.platformData!.file_id).toBe("photo-file-id");
    expect(attachment.platformData!.width).toBe(800);
    expect(attachment.platformData!.height).toBe(600);
  });

  it("selects the largest photo size", () => {
    const photo: TelegramPhotoSize[] = [
      { file_id: "small", file_unique_id: "s", width: 100, height: 100 },
      { file_id: "medium", file_unique_id: "m", width: 400, height: 300 },
      { file_id: "large", file_unique_id: "l", width: 1200, height: 900 },
    ];
    const msg = createTextMessage({ text: undefined, photo, caption: "pic" });
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result!.attachments![0]!.id).toBe("large");
  });

  it("normalizes a document message", () => {
    const msg = createTextMessage({
      text: undefined,
      document: createDocument(),
      caption: "Here is the report",
    });
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.text).toBe("Here is the report");
    expect(result!.attachments).toHaveLength(1);

    const attachment = result!.attachments![0]!;
    expect(attachment.type).toBe("file");
    expect(attachment.id).toBe("doc-file-id");
    expect(attachment.fileName).toBe("report.pdf");
    expect(attachment.mimeType).toBe("application/pdf");
    expect(attachment.sizeBytes).toBe(120_000);
    expect(attachment.platformData!.file_id).toBe("doc-file-id");
  });

  it("normalizes a voice message", () => {
    const msg = createTextMessage({
      text: undefined,
      voice: createVoice(),
    });
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.voice).toBeDefined();
    expect(result!.voice!.mimeType).toBe("audio/ogg");
    expect(result!.voice!.durationMs).toBe(5_000);
    expect(result!.voice!.platformData!.file_id).toBe("voice-file-id");
    expect(result!.voice!.platformData!.file_size).toBe(8_000);
  });

  it("normalizes formatting entities", () => {
    const msg = createTextMessage({
      text: "Hello bold world",
      entities: [
        { type: "bold", offset: 6, length: 4 },
      ],
    });
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result!.formatting).toBeDefined();
    expect(result!.formatting!.mode).toBe("html");
    expect(result!.formatting!.entities).toHaveLength(1);
    expect(result!.formatting!.entities![0]).toEqual({
      type: "bold",
      offset: 6,
      length: 4,
    });
  });

  it("maps multiple entity types including links", () => {
    const msg = createTextMessage({
      text: "Visit example.com now",
      entities: [
        { type: "text_link", offset: 6, length: 11, url: "https://example.com" },
        { type: "italic", offset: 18, length: 3 },
        { type: "hashtag", offset: 0, length: 5 },
      ],
    });
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result!.formatting!.entities).toHaveLength(2);
    expect(result!.formatting!.entities![0]).toEqual({
      type: "link",
      offset: 6,
      length: 11,
      url: "https://example.com",
    });
    expect(result!.formatting!.entities![1]).toEqual({
      type: "italic",
      offset: 18,
      length: 3,
    });
  });

  it("handles caption entities on photo messages", () => {
    const msg = createTextMessage({
      text: undefined,
      photo: createPhoto(),
      caption: "Bold caption",
      caption_entities: [
        { type: "bold", offset: 0, length: 4 },
      ],
    });
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result!.formatting).toBeDefined();
    expect(result!.formatting!.entities).toHaveLength(1);
    expect(result!.formatting!.entities![0]!.type).toBe("bold");
  });

  it("extracts reply_to_message reference", () => {
    const msg = createTextMessage({
      reply_to_message: createTextMessage({ message_id: 99 }),
    });
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result!.replyToMessageId).toBe("99");
  });

  it("handles edited_message updates", () => {
    const update: TelegramUpdate = {
      update_id: 200,
      edited_message: createTextMessage({ text: "Edited text" }),
    };
    const result = normalizeTelegramMessage(update);

    expect(result).not.toBeNull();
    expect(result!.text).toBe("Edited text");
  });

  it("handles channel_post updates", () => {
    const update: TelegramUpdate = {
      update_id: 300,
      channel_post: createTextMessage({ text: "Channel post" }),
    };
    const result = normalizeTelegramMessage(update);

    expect(result).not.toBeNull();
    expect(result!.text).toBe("Channel post");
  });

  it("returns null for updates with no message", () => {
    const update: TelegramUpdate = { update_id: 400 };
    const result = normalizeTelegramMessage(update);

    expect(result).toBeNull();
  });

  it("returns null for messages with no recognizable content and no unsupported type", () => {
    const msg: TelegramMessage = {
      message_id: 5,
      date: 1_735_689_600,
      chat: createChat(),
    };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).toBeNull();
  });

  it("returns notification for sticker messages", () => {
    const msg: TelegramMessage = {
      message_id: 6,
      date: 1_735_689_600,
      chat: createChat(),
      from: createFrom(),
      sticker: { file_id: "sticker-id", type: "regular", emoji: "😀" },
    };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: sticker. Only text, images, documents, and voice are supported.",
    );
    expect(result!.platform).toBe("telegram");
    expect(result!.channelId).toBe("42");
    expect(result!.sender.id).toBe("101");
  });

  it("returns notification for poll messages", () => {
    const msg: TelegramMessage = {
      message_id: 7,
      date: 1_735_689_600,
      chat: createChat(),
      from: createFrom(),
      poll: { id: "poll-1", question: "Favorite color?" },
    };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: poll. Only text, images, documents, and voice are supported.",
    );
  });

  it("returns notification for location messages", () => {
    const msg: TelegramMessage = {
      message_id: 8,
      date: 1_735_689_600,
      chat: createChat(),
      from: createFrom(),
      location: { latitude: 51.5074, longitude: -0.1278 },
    };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: location. Only text, images, documents, and voice are supported.",
    );
  });

  it("returns notification for contact messages", () => {
    const msg: TelegramMessage = {
      message_id: 9,
      date: 1_735_689_600,
      chat: createChat(),
      from: createFrom(),
      contact: { phone_number: "+1234567890", first_name: "Bob" },
    };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: contact. Only text, images, documents, and voice are supported.",
    );
  });

  it("returns notification for animation messages", () => {
    const msg: TelegramMessage = {
      message_id: 10,
      date: 1_735_689_600,
      chat: createChat(),
      from: createFrom(),
      animation: { file_id: "anim-id" },
    };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: animation. Only text, images, documents, and voice are supported.",
    );
  });

  it("returns notification for video messages", () => {
    const msg: TelegramMessage = {
      message_id: 11,
      date: 1_735_689_600,
      chat: createChat(),
      from: createFrom(),
      video: { file_id: "video-id" },
    };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: video. Only text, images, documents, and voice are supported.",
    );
  });

  it("returns notification for dice messages", () => {
    const msg: TelegramMessage = {
      message_id: 12,
      date: 1_735_689_600,
      chat: createChat(),
      from: createFrom(),
      dice: { emoji: "🎲", value: 4 },
    };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: dice. Only text, images, documents, and voice are supported.",
    );
  });

  it("returns notification for venue messages", () => {
    const msg: TelegramMessage = {
      message_id: 13,
      date: 1_735_689_600,
      chat: createChat(),
      from: createFrom(),
      venue: { location: { latitude: 51.5074, longitude: -0.1278 }, title: "Big Ben" },
    };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: venue. Only text, images, documents, and voice are supported.",
    );
  });

  it("returns notification for game messages", () => {
    const msg: TelegramMessage = {
      message_id: 14,
      date: 1_735_689_600,
      chat: createChat(),
      from: createFrom(),
      game: { title: "My Game" },
    };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: game. Only text, images, documents, and voice are supported.",
    );
  });

  it("returns notification for video_note messages", () => {
    const msg: TelegramMessage = {
      message_id: 15,
      date: 1_735_689_600,
      chat: createChat(),
      from: createFrom(),
      video_note: { file_id: "vnote-id" },
    };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: video note. Only text, images, documents, and voice are supported.",
    );
  });

  it("includes platformData in unsupported type notifications", () => {
    const msg: TelegramMessage = {
      message_id: 16,
      date: 1_735_689_600,
      chat: createChat(),
      from: createFrom(),
      sticker: { file_id: "sticker-id" },
    };
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result).not.toBeNull();
    expect(result!.platformData).toEqual({
      message_id: 16,
      chat_id: 42,
      chat_type: "private",
      date: 1_735_689_600,
    });
  });

  it("handles a message with both photo and document", () => {
    const msg = createTextMessage({
      text: undefined,
      photo: createPhoto(),
      document: createDocument(),
      caption: "Mixed media",
    });
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result!.attachments).toHaveLength(2);
    expect(result!.attachments![0]!.type).toBe("image");
    expect(result!.attachments![1]!.type).toBe("file");
  });

  it("handles sender with first name only", () => {
    const msg = createTextMessage({
      from: {
        id: 200,
        is_bot: true,
        first_name: "Bot",
      },
    });
    const result = normalizeTelegramMessage(createUpdate(msg));

    expect(result!.sender.displayName).toBe("Bot");
    expect(result!.sender.username).toBeUndefined();
    expect(result!.sender.isBot).toBe(true);
  });
});

describe("toTelegramMessage", () => {
  function createChannelMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
    return {
      id: "1",
      platform: "telegram",
      channelId: "42",
      sender: { id: "101", username: "alice", displayName: "Alice" },
      timestamp: new Date(1_735_689_600_000),
      text: "Hello world",
      platformData: { chat_id: 42, message_id: 1, chat_type: "private", date: 1_735_689_600 },
      ...overrides,
    };
  }

  it("converts a plain text message", () => {
    const msg = createChannelMessage();
    const result = toTelegramMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.chatId).toBe(42);
    expect(result!.text).toBe("Hello world");
    expect(result!.photo).toBeUndefined();
    expect(result!.document).toBeUndefined();
    expect(result!.voice).toBeUndefined();
  });

  it("applies HTML formatting to text messages", () => {
    const msg = createChannelMessage({
      text: "Hello bold world",
      formatting: {
        mode: "html",
        entities: [{ type: "bold", offset: 6, length: 4 }],
      },
    });
    const result = toTelegramMessage(msg);

    expect(result!.text).toBe("Hello <b>bold</b> world");
    expect(result!.textOptions!.parseMode).toBe("HTML");
  });

  it("escapes HTML special characters in text", () => {
    const msg = createChannelMessage({
      text: "a < b & c > d",
    });
    const result = toTelegramMessage(msg);

    expect(result!.text).toBe("a < b & c > d");
  });

  it("escapes HTML special characters when formatting is applied", () => {
    const msg = createChannelMessage({
      text: "a < b & c > d",
      formatting: {
        mode: "html",
        entities: [{ type: "bold", offset: 0, length: 1 }],
      },
    });
    const result = toTelegramMessage(msg);

    expect(result!.text).toBe("<b>a</b> &lt; b &amp; c &gt; d");
    expect(result!.textOptions!.parseMode).toBe("HTML");
  });

  it("converts link entities to anchor tags", () => {
    const msg = createChannelMessage({
      text: "Visit example.com now",
      formatting: {
        mode: "html",
        entities: [{ type: "link", offset: 6, length: 11, url: "https://example.com" }],
      },
    });
    const result = toTelegramMessage(msg);

    expect(result!.text).toBe('Visit <a href="https://example.com">example.com</a> now');
  });

  it("converts an image attachment to photo send params", () => {
    const attachment: ChannelAttachment = {
      id: "photo-file-id",
      type: "image",
      platformData: { file_id: "photo-file-id", file_unique_id: "uid" },
    };
    const msg = createChannelMessage({
      text: "Check this out",
      attachments: [attachment],
    });
    const result = toTelegramMessage(msg);

    expect(result!.photo).toBe("photo-file-id");
    expect(result!.photoOptions!.caption).toBe("Check this out");
    expect(result!.text).toBeUndefined();
  });

  it("converts a file attachment to document send params", () => {
    const attachment: ChannelAttachment = {
      id: "doc-file-id",
      type: "file",
      fileName: "report.pdf",
      platformData: { file_id: "doc-file-id", file_unique_id: "uid" },
    };
    const msg = createChannelMessage({
      text: "Here is the report",
      attachments: [attachment],
    });
    const result = toTelegramMessage(msg);

    expect(result!.document).toBe("doc-file-id");
    expect(result!.documentOptions!.caption).toBe("Here is the report");
  });

  it("falls back to attachment url when platformData file_id is missing", () => {
    const attachment: ChannelAttachment = {
      type: "image",
      url: "https://example.com/image.png",
    };
    const msg = createChannelMessage({
      text: undefined,
      attachments: [attachment],
    });
    const result = toTelegramMessage(msg);

    expect(result!.photo).toBe("https://example.com/image.png");
  });

  it("converts a voice message to voice send params", () => {
    const voice: ChannelVoice = {
      mimeType: "audio/ogg",
      durationMs: 5_000,
      platformData: { file_id: "voice-file-id", file_unique_id: "uid" },
    };
    const msg = createChannelMessage({
      text: undefined,
      voice,
    });
    const result = toTelegramMessage(msg);

    expect(result!.voice).toBe("voice-file-id");
    expect(result!.text).toBeUndefined();
    expect(result!.photo).toBeUndefined();
  });

  it("includes replyToMessageId in text options", () => {
    const msg = createChannelMessage({
      replyToMessageId: "99",
    });
    const result = toTelegramMessage(msg);

    expect(result!.textOptions!.replyToMessageId).toBe(99);
  });

  it("includes replyToMessageId in media options", () => {
    const attachment: ChannelAttachment = {
      type: "image",
      platformData: { file_id: "photo-id" },
    };
    const msg = createChannelMessage({
      text: "caption",
      attachments: [attachment],
      replyToMessageId: "50",
    });
    const result = toTelegramMessage(msg);

    expect(result!.photoOptions!.replyToMessageId).toBe(50);
  });

  it("returns null when platformData has no chat_id", () => {
    const msg = createChannelMessage({
      platformData: { message_id: 1 },
    });
    const result = toTelegramMessage(msg);

    expect(result).toBeNull();
  });

  it("returns null when platformData is missing", () => {
    const msg = createChannelMessage({
      platformData: undefined,
    });
    const result = toTelegramMessage(msg);

    expect(result).toBeNull();
  });

  it("returns null for empty text with no attachments or voice", () => {
    const msg = createChannelMessage({
      text: "",
      attachments: undefined,
      voice: undefined,
    });
    const result = toTelegramMessage(msg);

    expect(result).toBeNull();
  });

  it("returns null when attachment has no file reference", () => {
    const attachment: ChannelAttachment = {
      type: "image",
    };
    const msg = createChannelMessage({
      text: undefined,
      attachments: [attachment],
    });
    const result = toTelegramMessage(msg);

    expect(result).toBeNull();
  });

  it("prioritizes voice over attachments", () => {
    const voice: ChannelVoice = {
      platformData: { file_id: "voice-id" },
    };
    const attachment: ChannelAttachment = {
      type: "image",
      platformData: { file_id: "photo-id" },
    };
    const msg = createChannelMessage({
      text: undefined,
      voice,
      attachments: [attachment],
    });
    const result = toTelegramMessage(msg);

    expect(result!.voice).toBe("voice-id");
    expect(result!.photo).toBeUndefined();
  });

  it("applies HTML formatting to media captions", () => {
    const attachment: ChannelAttachment = {
      type: "image",
      platformData: { file_id: "photo-id" },
    };
    const msg = createChannelMessage({
      text: "Bold caption",
      attachments: [attachment],
      formatting: {
        mode: "html",
        entities: [{ type: "bold", offset: 0, length: 4 }],
      },
    });
    const result = toTelegramMessage(msg);

    expect(result!.photoOptions!.caption).toBe("<b>Bold</b> caption");
    expect(result!.photoOptions!.parseMode).toBe("HTML");
  });
});

describe("round-trip conversion", () => {
  it("preserves text message data through normalize → toTelegram", () => {
    const update = createUpdate(createTextMessage());
    const normalized = normalizeTelegramMessage(update)!;
    const outbound = toTelegramMessage(normalized)!;

    expect(outbound.chatId).toBe(42);
    expect(outbound.text).toBe("Hello world");
  });

  it("preserves photo message data through normalize → toTelegram", () => {
    const msg = createTextMessage({
      text: undefined,
      photo: createPhoto("round-trip-photo"),
      caption: "Photo caption",
    });
    const normalized = normalizeTelegramMessage(createUpdate(msg))!;
    const outbound = toTelegramMessage(normalized)!;

    expect(outbound.photo).toBe("round-trip-photo");
    expect(outbound.photoOptions!.caption).toBe("Photo caption");
  });

  it("preserves document message data through normalize → toTelegram", () => {
    const msg = createTextMessage({
      text: undefined,
      document: createDocument({ file_id: "round-trip-doc" }),
      caption: "Doc caption",
    });
    const normalized = normalizeTelegramMessage(createUpdate(msg))!;
    const outbound = toTelegramMessage(normalized)!;

    expect(outbound.document).toBe("round-trip-doc");
    expect(outbound.documentOptions!.caption).toBe("Doc caption");
  });

  it("preserves voice message data through normalize → toTelegram", () => {
    const msg = createTextMessage({
      text: undefined,
      voice: createVoice({ file_id: "round-trip-voice" }),
    });
    const normalized = normalizeTelegramMessage(createUpdate(msg))!;
    const outbound = toTelegramMessage(normalized)!;

    expect(outbound.voice).toBe("round-trip-voice");
  });

  it("preserves reply reference through normalize → toTelegram", () => {
    const msg = createTextMessage({
      reply_to_message: createTextMessage({ message_id: 77 }),
    });
    const normalized = normalizeTelegramMessage(createUpdate(msg))!;
    const outbound = toTelegramMessage(normalized)!;

    expect(outbound.textOptions!.replyToMessageId).toBe(77);
  });

  it("preserves formatting through normalize → toTelegram", () => {
    const msg = createTextMessage({
      text: "Hello bold world",
      entities: [{ type: "bold", offset: 6, length: 4 }],
    });
    const normalized = normalizeTelegramMessage(createUpdate(msg))!;
    const outbound = toTelegramMessage(normalized)!;

    expect(outbound.text).toBe("Hello <b>bold</b> world");
    expect(outbound.textOptions!.parseMode).toBe("HTML");
  });
});

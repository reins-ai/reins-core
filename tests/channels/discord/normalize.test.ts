import { describe, expect, it } from "bun:test";

import type {
  ChannelAttachment,
  ChannelMessage,
  ChannelVoice,
} from "../../../src/channels/types";
import type {
  DiscordAttachment,
  DiscordEmbed,
  DiscordMessage,
  DiscordUser,
} from "../../../src/channels/discord/types";
import {
  normalizeDiscordMessage,
  splitIntoChunks,
  toDiscordEmbed,
  toDiscordMessage,
} from "../../../src/channels/discord/normalize";
import type { DiscordOutbound } from "../../../src/channels/discord/normalize";

function createAuthor(overrides: Partial<DiscordUser> = {}): DiscordUser {
  return {
    id: "101",
    username: "alice",
    discriminator: "0001",
    global_name: "Alice Smith",
    bot: false,
    ...overrides,
  };
}

function createDiscordMessage(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "msg-1",
    channel_id: "ch-42",
    author: createAuthor(),
    content: "Hello world",
    timestamp: "2026-01-01T00:00:00.000Z",
    embeds: [],
    attachments: [],
    ...overrides,
  };
}

function createDiscordAttachment(overrides: Partial<DiscordAttachment> = {}): DiscordAttachment {
  return {
    id: "att-1",
    filename: "image.png",
    size: 50_000,
    url: "https://cdn.discord.com/attachments/ch-42/att-1/image.png",
    proxy_url: "https://media.discord.com/attachments/ch-42/att-1/image.png",
    content_type: "image/png",
    ...overrides,
  };
}

function createDiscordEmbed(overrides: Partial<DiscordEmbed> = {}): DiscordEmbed {
  return {
    title: "Test Embed",
    description: "Embed description",
    color: 0x5865f2,
    ...overrides,
  };
}

function createChannelMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "msg-1",
    platform: "discord",
    channelId: "ch-42",
    sender: { id: "101", username: "alice", displayName: "Alice Smith" },
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    text: "Hello world",
    platformData: {
      message_id: "msg-1",
      channel_id: "ch-42",
    },
    ...overrides,
  };
}

describe("normalizeDiscordMessage", () => {
  it("normalizes a plain text message", () => {
    const msg = createDiscordMessage();
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("msg-1");
    expect(result!.platform).toBe("discord");
    expect(result!.channelId).toBe("ch-42");
    expect(result!.text).toBe("Hello world");
    expect(result!.timestamp).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(result!.attachments).toBeUndefined();
    expect(result!.voice).toBeUndefined();
  });

  it("extracts sender information from the author field", () => {
    const msg = createDiscordMessage();
    const result = normalizeDiscordMessage(msg);

    expect(result!.sender.id).toBe("101");
    expect(result!.sender.username).toBe("alice");
    expect(result!.sender.displayName).toBe("Alice Smith");
    expect(result!.sender.isBot).toBe(false);
  });

  it("falls back to username when global_name is null", () => {
    const msg = createDiscordMessage({
      author: createAuthor({ global_name: null }),
    });
    const result = normalizeDiscordMessage(msg);

    expect(result!.sender.displayName).toBe("alice");
  });

  it("falls back to username when global_name is undefined", () => {
    const msg = createDiscordMessage({
      author: createAuthor({ global_name: undefined }),
    });
    const result = normalizeDiscordMessage(msg);

    expect(result!.sender.displayName).toBe("alice");
  });

  it("identifies bot authors", () => {
    const msg = createDiscordMessage({
      author: createAuthor({ bot: true, username: "reins-bot" }),
    });
    const result = normalizeDiscordMessage(msg);

    expect(result!.sender.isBot).toBe(true);
  });

  it("stores Discord metadata in platformData", () => {
    const msg = createDiscordMessage({ guild_id: "guild-1" });
    const result = normalizeDiscordMessage(msg);

    expect(result!.platformData).toBeDefined();
    expect(result!.platformData!.message_id).toBe("msg-1");
    expect(result!.platformData!.channel_id).toBe("ch-42");
    expect(result!.platformData!.guild_id).toBe("guild-1");
  });

  it("omits guild_id from platformData for DMs", () => {
    const msg = createDiscordMessage({ guild_id: undefined });
    const result = normalizeDiscordMessage(msg);

    expect(result!.platformData!.guild_id).toBeUndefined();
  });

  it("stores edited_timestamp in platformData when present", () => {
    const msg = createDiscordMessage({ edited_timestamp: "2026-01-01T01:00:00.000Z" });
    const result = normalizeDiscordMessage(msg);

    expect(result!.platformData!.edited_timestamp).toBe("2026-01-01T01:00:00.000Z");
  });

  it("normalizes an image attachment", () => {
    const attachment = createDiscordAttachment();
    const msg = createDiscordMessage({
      content: "Check this out",
      attachments: [attachment],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.text).toBe("Check this out");
    expect(result!.attachments).toHaveLength(1);

    const att = result!.attachments![0]!;
    expect(att.type).toBe("image");
    expect(att.id).toBe("att-1");
    expect(att.url).toBe("https://cdn.discord.com/attachments/ch-42/att-1/image.png");
    expect(att.mimeType).toBe("image/png");
    expect(att.sizeBytes).toBe(50_000);
    expect(att.fileName).toBe("image.png");
    expect(att.platformData!.attachment_id).toBe("att-1");
    expect(att.platformData!.proxy_url).toBe("https://media.discord.com/attachments/ch-42/att-1/image.png");
  });

  it("normalizes a video attachment", () => {
    const attachment = createDiscordAttachment({
      id: "vid-1",
      filename: "clip.mp4",
      content_type: "video/mp4",
      size: 500_000,
    });
    const msg = createDiscordMessage({ attachments: [attachment] });
    const result = normalizeDiscordMessage(msg);

    expect(result!.attachments![0]!.type).toBe("video");
  });

  it("normalizes a file attachment with unknown content type", () => {
    const attachment = createDiscordAttachment({
      id: "file-1",
      filename: "report.pdf",
      content_type: "application/pdf",
      size: 120_000,
    });
    const msg = createDiscordMessage({ attachments: [attachment] });
    const result = normalizeDiscordMessage(msg);

    expect(result!.attachments![0]!.type).toBe("file");
    expect(result!.attachments![0]!.fileName).toBe("report.pdf");
  });

  it("normalizes an attachment with no content type as file", () => {
    const attachment = createDiscordAttachment({
      content_type: undefined,
    });
    const msg = createDiscordMessage({ attachments: [attachment] });
    const result = normalizeDiscordMessage(msg);

    expect(result!.attachments![0]!.type).toBe("file");
  });

  it("normalizes multiple attachments", () => {
    const attachments = [
      createDiscordAttachment({ id: "att-1", content_type: "image/png" }),
      createDiscordAttachment({ id: "att-2", filename: "doc.pdf", content_type: "application/pdf" }),
    ];
    const msg = createDiscordMessage({ attachments });
    const result = normalizeDiscordMessage(msg);

    expect(result!.attachments).toHaveLength(2);
    expect(result!.attachments![0]!.type).toBe("image");
    expect(result!.attachments![1]!.type).toBe("file");
  });

  it("extracts voice from audio attachment", () => {
    const attachment = createDiscordAttachment({
      id: "voice-1",
      filename: "voice-message.ogg",
      content_type: "audio/ogg",
      size: 8_000,
    });
    const msg = createDiscordMessage({
      content: "",
      attachments: [attachment],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result!.voice).toBeDefined();
    expect(result!.voice!.mimeType).toBe("audio/ogg");
    expect(result!.voice!.url).toBe(attachment.url);
    expect(result!.voice!.platformData!.attachment_id).toBe("voice-1");
    expect(result!.voice!.platformData!.filename).toBe("voice-message.ogg");
    expect(result!.voice!.platformData!.size).toBe(8_000);
  });

  it("extracts embed text when content is empty", () => {
    const embed = createDiscordEmbed({
      title: "Embed Title",
      description: "Embed body text",
    });
    const msg = createDiscordMessage({
      content: "",
      embeds: [embed],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.text).toBe("Embed Title\n\nEmbed body text");
  });

  it("extracts embed description only when title is missing", () => {
    const embed = createDiscordEmbed({
      title: undefined,
      description: "Just a description",
    });
    const msg = createDiscordMessage({
      content: "",
      embeds: [embed],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result!.text).toBe("Just a description");
  });

  it("prefers content text over embed text", () => {
    const embed = createDiscordEmbed({ description: "Embed text" });
    const msg = createDiscordMessage({
      content: "Main content",
      embeds: [embed],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result!.text).toBe("Main content");
  });

  it("stores embeds in platformData", () => {
    const embed = createDiscordEmbed();
    const msg = createDiscordMessage({ embeds: [embed] });
    const result = normalizeDiscordMessage(msg);

    expect(result!.platformData!.embeds).toBeDefined();
  });

  it("detects Discord markdown formatting", () => {
    const msg = createDiscordMessage({ content: "Hello **bold** world" });
    const result = normalizeDiscordMessage(msg);

    expect(result!.formatting).toBeDefined();
    expect(result!.formatting!.mode).toBe("discord_markdown");
  });

  it("detects code block formatting", () => {
    const msg = createDiscordMessage({ content: "Use `code` here" });
    const result = normalizeDiscordMessage(msg);

    expect(result!.formatting).toBeDefined();
    expect(result!.formatting!.mode).toBe("discord_markdown");
  });

  it("detects strikethrough formatting", () => {
    const msg = createDiscordMessage({ content: "~~deleted~~" });
    const result = normalizeDiscordMessage(msg);

    expect(result!.formatting).toBeDefined();
    expect(result!.formatting!.mode).toBe("discord_markdown");
  });

  it("detects spoiler formatting", () => {
    const msg = createDiscordMessage({ content: "||spoiler||" });
    const result = normalizeDiscordMessage(msg);

    expect(result!.formatting).toBeDefined();
    expect(result!.formatting!.mode).toBe("discord_markdown");
  });

  it("detects link formatting", () => {
    const msg = createDiscordMessage({ content: "[click here](https://example.com)" });
    const result = normalizeDiscordMessage(msg);

    expect(result!.formatting).toBeDefined();
    expect(result!.formatting!.mode).toBe("discord_markdown");
  });

  it("does not set formatting for plain text", () => {
    const msg = createDiscordMessage({ content: "Just plain text" });
    const result = normalizeDiscordMessage(msg);

    expect(result!.formatting).toBeUndefined();
  });

  it("returns null for messages with no content, attachments, embeds, or unsupported type", () => {
    const msg = createDiscordMessage({
      content: "",
      attachments: [],
      embeds: [],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).toBeNull();
  });

  it("returns null for embeds with no title or description", () => {
    const embed: DiscordEmbed = { color: 0xff0000 };
    const msg = createDiscordMessage({
      content: "",
      embeds: [embed],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).toBeNull();
  });

  it("returns notification for sticker messages", () => {
    const msg = createDiscordMessage({
      content: "",
      attachments: [],
      embeds: [],
      sticker_items: [{ id: "sticker-1", name: "cool_sticker", format_type: 1 }],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: sticker. Only text, images, documents, and voice are supported.",
    );
    expect(result!.platform).toBe("discord");
    expect(result!.channelId).toBe("ch-42");
    expect(result!.sender.id).toBe("101");
  });

  it("returns notification for poll messages", () => {
    const msg = createDiscordMessage({
      content: "",
      attachments: [],
      embeds: [],
      poll: { question: { text: "Favorite color?" } },
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: poll. Only text, images, documents, and voice are supported.",
    );
  });

  it("returns notification for activity messages", () => {
    const msg = createDiscordMessage({
      content: "",
      attachments: [],
      embeds: [],
      activity: { type: 1 },
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: activity. Only text, images, documents, and voice are supported.",
    );
  });

  it("returns notification for system message types", () => {
    const msg = createDiscordMessage({
      type: 7,
      content: "",
      attachments: [],
      embeds: [],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: member join. Only text, images, documents, and voice are supported.",
    );
  });

  it("returns notification for unknown system message types", () => {
    const msg = createDiscordMessage({
      type: 99,
      content: "",
      attachments: [],
      embeds: [],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: system message. Only text, images, documents, and voice are supported.",
    );
  });

  it("returns notification for pin notification messages", () => {
    const msg = createDiscordMessage({
      type: 6,
      content: "",
      attachments: [],
      embeds: [],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.text).toBe(
      "Unsupported message type: pin notification. Only text, images, documents, and voice are supported.",
    );
  });

  it("includes platformData in unsupported type notifications", () => {
    const msg = createDiscordMessage({
      content: "",
      attachments: [],
      embeds: [],
      sticker_items: [{ id: "sticker-1", name: "cool_sticker", format_type: 1 }],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.platformData).toBeDefined();
    expect(result!.platformData!.message_id).toBe("msg-1");
    expect(result!.platformData!.channel_id).toBe("ch-42");
  });

  it("does not return notification for default message type with no content", () => {
    const msg = createDiscordMessage({
      type: 0,
      content: "",
      attachments: [],
      embeds: [],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).toBeNull();
  });

  it("normalizes content normally even when sticker_items are present", () => {
    const msg = createDiscordMessage({
      content: "Hello with sticker",
      sticker_items: [{ id: "sticker-1", name: "cool_sticker", format_type: 1 }],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello with sticker");
  });

  it("handles message with only attachments and no text", () => {
    const attachment = createDiscordAttachment();
    const msg = createDiscordMessage({
      content: "",
      attachments: [attachment],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.text).toBeUndefined();
    expect(result!.attachments).toHaveLength(1);
  });

  it("handles message with only voice and no text", () => {
    const attachment = createDiscordAttachment({
      content_type: "audio/webm",
      filename: "voice.webm",
    });
    const msg = createDiscordMessage({
      content: "",
      attachments: [attachment],
    });
    const result = normalizeDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.voice).toBeDefined();
    expect(result!.voice!.mimeType).toBe("audio/webm");
  });

  it("handles multiple embeds by concatenating text", () => {
    const embeds = [
      createDiscordEmbed({ title: "First", description: "One" }),
      createDiscordEmbed({ title: "Second", description: "Two" }),
    ];
    const msg = createDiscordMessage({
      content: "",
      embeds,
    });
    const result = normalizeDiscordMessage(msg);

    expect(result!.text).toBe("First\n\nOne\n\nSecond\n\nTwo");
  });
});

describe("toDiscordMessage", () => {
  it("converts a plain text message", () => {
    const msg = createChannelMessage();
    const result = toDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.channelId).toBe("ch-42");
    expect(result!.content).toBe("Hello world");
    expect(result!.embed).toBeUndefined();
    expect(result!.file).toBeUndefined();
    expect(result!.chunks).toBeUndefined();
  });

  it("converts a voice message to file upload", () => {
    const voice: ChannelVoice = {
      url: "https://cdn.discord.com/voice.ogg",
      mimeType: "audio/ogg",
      durationMs: 5_000,
      platformData: { filename: "voice-message.ogg" },
    };
    const msg = createChannelMessage({
      text: undefined,
      voice,
    });
    const result = toDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.file).toBeDefined();
    expect(result!.file!.url).toBe("https://cdn.discord.com/voice.ogg");
    expect(result!.file!.fileName).toBe("voice-message.ogg");
    expect(result!.content).toBeUndefined();
  });

  it("uses default filename for voice when platformData has no filename", () => {
    const voice: ChannelVoice = {
      url: "https://cdn.discord.com/voice.ogg",
      mimeType: "audio/ogg",
    };
    const msg = createChannelMessage({
      text: undefined,
      voice,
    });
    const result = toDiscordMessage(msg);

    expect(result!.file!.fileName).toBe("voice.ogg");
  });

  it("includes text as description when sending voice with caption", () => {
    const voice: ChannelVoice = {
      url: "https://cdn.discord.com/voice.ogg",
      mimeType: "audio/ogg",
    };
    const msg = createChannelMessage({
      text: "Listen to this",
      voice,
    });
    const result = toDiscordMessage(msg);

    expect(result!.file!.description).toBe("Listen to this");
  });

  it("converts an image attachment to file upload", () => {
    const attachment: ChannelAttachment = {
      id: "att-1",
      type: "image",
      url: "https://cdn.discord.com/image.png",
      fileName: "image.png",
    };
    const msg = createChannelMessage({
      text: "Check this out",
      attachments: [attachment],
    });
    const result = toDiscordMessage(msg);

    expect(result!.file).toBeDefined();
    expect(result!.file!.url).toBe("https://cdn.discord.com/image.png");
    expect(result!.file!.fileName).toBe("image.png");
    expect(result!.file!.description).toBe("Check this out");
    expect(result!.content).toBeUndefined();
  });

  it("falls back to proxy_url when attachment url is missing", () => {
    const attachment: ChannelAttachment = {
      type: "file",
      fileName: "report.pdf",
      platformData: { proxy_url: "https://media.discord.com/report.pdf" },
    };
    const msg = createChannelMessage({
      text: undefined,
      attachments: [attachment],
    });
    const result = toDiscordMessage(msg);

    expect(result!.file!.url).toBe("https://media.discord.com/report.pdf");
  });

  it("returns null when attachment has no url or proxy_url", () => {
    const attachment: ChannelAttachment = {
      type: "image",
    };
    const msg = createChannelMessage({
      text: undefined,
      attachments: [attachment],
    });
    const result = toDiscordMessage(msg);

    expect(result).toBeNull();
  });

  it("prioritizes voice over attachments", () => {
    const voice: ChannelVoice = {
      url: "https://cdn.discord.com/voice.ogg",
    };
    const attachment: ChannelAttachment = {
      type: "image",
      url: "https://cdn.discord.com/image.png",
    };
    const msg = createChannelMessage({
      text: undefined,
      voice,
      attachments: [attachment],
    });
    const result = toDiscordMessage(msg);

    expect(result!.file!.url).toBe("https://cdn.discord.com/voice.ogg");
  });

  it("splits long messages into chunks", () => {
    const longText = "A".repeat(2_500);
    const msg = createChannelMessage({ text: longText });
    const result = toDiscordMessage(msg);

    expect(result).not.toBeNull();
    expect(result!.content).toBeUndefined();
    expect(result!.chunks).toBeDefined();
    expect(result!.chunks!.length).toBeGreaterThan(1);
    expect(result!.chunks!.join("")).toBe(longText);
    for (const chunk of result!.chunks!) {
      expect(chunk.length).toBeLessThanOrEqual(2_000);
    }
  });

  it("does not chunk messages at or under 2000 characters", () => {
    const text = "A".repeat(2_000);
    const msg = createChannelMessage({ text });
    const result = toDiscordMessage(msg);

    expect(result!.content).toBe(text);
    expect(result!.chunks).toBeUndefined();
  });

  it("returns null when platformData has no channel_id", () => {
    const msg = createChannelMessage({
      platformData: { message_id: "msg-1" },
    });
    const result = toDiscordMessage(msg);

    expect(result).toBeNull();
  });

  it("returns null when platformData is missing", () => {
    const msg = createChannelMessage({
      platformData: undefined,
    });
    const result = toDiscordMessage(msg);

    expect(result).toBeNull();
  });

  it("returns null for empty text with no attachments or voice", () => {
    const msg = createChannelMessage({
      text: "",
      attachments: undefined,
      voice: undefined,
    });
    const result = toDiscordMessage(msg);

    expect(result).toBeNull();
  });

  it("returns null for undefined text with no attachments or voice", () => {
    const msg = createChannelMessage({
      text: undefined,
      attachments: undefined,
      voice: undefined,
    });
    const result = toDiscordMessage(msg);

    expect(result).toBeNull();
  });
});

describe("toDiscordEmbed", () => {
  it("creates an embed from a text message", () => {
    const msg = createChannelMessage({ text: "Agent response text" });
    const result = toDiscordEmbed(msg);

    expect(result).not.toBeNull();
    expect(result!.channelId).toBe("ch-42");
    expect(result!.embed.description).toBe("Agent response text");
    expect(result!.embed.color).toBe(0x5865f2);
  });

  it("truncates long text in embed description", () => {
    const longText = "B".repeat(2_500);
    const msg = createChannelMessage({ text: longText });
    const result = toDiscordEmbed(msg);

    expect(result!.embed.description!.length).toBeLessThanOrEqual(2_000);
    expect(result!.embed.description!.endsWith("...")).toBe(true);
  });

  it("returns null when message has no text", () => {
    const msg = createChannelMessage({ text: undefined });
    const result = toDiscordEmbed(msg);

    expect(result).toBeNull();
  });

  it("returns null when message has empty text", () => {
    const msg = createChannelMessage({ text: "" });
    const result = toDiscordEmbed(msg);

    expect(result).toBeNull();
  });

  it("returns null when platformData has no channel_id", () => {
    const msg = createChannelMessage({
      platformData: { message_id: "msg-1" },
    });
    const result = toDiscordEmbed(msg);

    expect(result).toBeNull();
  });
});

describe("splitIntoChunks", () => {
  it("returns single chunk for short text", () => {
    const chunks = splitIntoChunks("Hello world");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Hello world");
  });

  it("splits at newline boundaries when possible", () => {
    const line = "A".repeat(1_500);
    const text = `${line}\n${"B".repeat(800)}`;
    const chunks = splitIntoChunks(text);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line);
    expect(chunks[1]).toBe("B".repeat(800));
  });

  it("splits at space boundaries when no newline is available", () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const chunks = splitIntoChunks(words);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2_000);
    }
    expect(chunks.join(" ").replace(/  /g, " ")).toBe(words);
  });

  it("hard splits when no suitable boundary exists", () => {
    const text = "A".repeat(5_000);
    const chunks = splitIntoChunks(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2_000);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("handles exact boundary length", () => {
    const text = "A".repeat(2_000);
    const chunks = splitIntoChunks(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("handles empty string", () => {
    const chunks = splitIntoChunks("");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("");
  });

  it("respects custom max length", () => {
    const text = "Hello world, this is a test";
    const chunks = splitIntoChunks(text, 10);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
  });
});

describe("round-trip conversion", () => {
  it("preserves text message data through normalize → toDiscord", () => {
    const discordMsg = createDiscordMessage();
    const normalized = normalizeDiscordMessage(discordMsg)!;
    const outbound = toDiscordMessage(normalized)!;

    expect(outbound.channelId).toBe("ch-42");
    expect(outbound.content).toBe("Hello world");
  });

  it("preserves attachment data through normalize → toDiscord", () => {
    const attachment = createDiscordAttachment({
      id: "round-trip-att",
      filename: "photo.jpg",
      content_type: "image/jpeg",
    });
    const discordMsg = createDiscordMessage({
      content: "Check this",
      attachments: [attachment],
    });
    const normalized = normalizeDiscordMessage(discordMsg)!;
    const outbound = toDiscordMessage(normalized)!;

    expect(outbound.file).toBeDefined();
    expect(outbound.file!.url).toBe(attachment.url);
    expect(outbound.file!.fileName).toBe("photo.jpg");
    expect(outbound.file!.description).toBe("Check this");
  });

  it("preserves voice data through normalize → toDiscord", () => {
    const voiceAttachment = createDiscordAttachment({
      id: "voice-rt",
      filename: "voice.ogg",
      content_type: "audio/ogg",
      size: 8_000,
    });
    const discordMsg = createDiscordMessage({
      content: "",
      attachments: [voiceAttachment],
    });
    const normalized = normalizeDiscordMessage(discordMsg)!;
    const outbound = toDiscordMessage(normalized)!;

    expect(outbound.file).toBeDefined();
    expect(outbound.file!.url).toBe(voiceAttachment.url);
    expect(outbound.file!.fileName).toBe("voice.ogg");
  });

  it("preserves channel_id through normalize → toDiscord", () => {
    const discordMsg = createDiscordMessage({ channel_id: "special-ch" });
    const normalized = normalizeDiscordMessage(discordMsg)!;
    const outbound = toDiscordMessage(normalized)!;

    expect(outbound.channelId).toBe("special-ch");
  });

  it("preserves guild message data through normalize → toDiscord", () => {
    const discordMsg = createDiscordMessage({ guild_id: "guild-123" });
    const normalized = normalizeDiscordMessage(discordMsg)!;

    expect(normalized.platformData!.guild_id).toBe("guild-123");

    const outbound = toDiscordMessage(normalized)!;
    expect(outbound.channelId).toBe("ch-42");
  });

  it("preserves embed data through normalize → toDiscordEmbed", () => {
    const discordMsg = createDiscordMessage({
      content: "Agent says hello",
    });
    const normalized = normalizeDiscordMessage(discordMsg)!;
    const embedResult = toDiscordEmbed(normalized);

    expect(embedResult).not.toBeNull();
    expect(embedResult!.embed.description).toBe("Agent says hello");
    expect(embedResult!.embed.color).toBe(0x5865f2);
  });
});

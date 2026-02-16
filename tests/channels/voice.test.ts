import { describe, expect, it } from "bun:test";
import {
  handleVoiceMessage,
  isSupportedAudioMimeType,
  type VoiceHandlerOptions,
} from "../../src/channels/voice";
import type { ChannelMessage, ChannelVoice } from "../../src/channels/types";
import { ChannelError } from "../../src/channels/errors";

function createTelegramVoiceMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "msg-1",
    platform: "telegram",
    channelId: "chat-123",
    sender: { id: "user-1", username: "alice", isBot: false },
    timestamp: new Date("2026-02-15T12:00:00Z"),
    voice: {
      mimeType: "audio/ogg",
      durationMs: 5_000,
      platformData: {
        file_id: "voice-file-abc",
        file_unique_id: "unique-abc",
        file_size: 12_000,
      },
    },
    platformData: {
      message_id: 42,
      chat_id: 123,
    },
    ...overrides,
  };
}

function createDiscordVoiceMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "msg-2",
    platform: "discord",
    channelId: "channel-456",
    sender: { id: "user-2", username: "bob", isBot: false },
    timestamp: new Date("2026-02-15T12:00:00Z"),
    voice: {
      url: "https://cdn.discordapp.com/attachments/456/789/voice.webm",
      mimeType: "audio/webm",
      durationMs: 3_000,
      platformData: {
        attachment_id: "att-789",
        filename: "voice-message.webm",
        proxy_url: "https://media.discordapp.net/attachments/456/789/voice.webm",
        size: 8_000,
      },
    },
    platformData: {
      message_id: "msg-discord-1",
      channel_id: "channel-456",
    },
    ...overrides,
  };
}

function createMockFetch(responses: Map<string, { status: number; body: unknown; headers?: Record<string, string> }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    for (const [pattern, config] of responses) {
      if (url.includes(pattern)) {
        const headers = new Headers(config.headers ?? {});
        if (!headers.has("content-type")) {
          if (config.body instanceof Uint8Array) {
            headers.set("content-type", "application/octet-stream");
          } else {
            headers.set("content-type", "application/json");
          }
        }

        let body: BodyInit;
        if (config.body instanceof Uint8Array) {
          body = new Uint8Array(config.body);
        } else {
          body = JSON.stringify(config.body);
        }

        return new Response(body, {
          status: config.status,
          headers,
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

function createAudioBuffer(sizeBytes: number): Uint8Array {
  const buffer = new Uint8Array(sizeBytes);
  buffer[0] = 0xff;
  return buffer;
}

describe("handleVoiceMessage", () => {
  describe("Telegram voice messages", () => {
    it("downloads a Telegram voice file via getFile API", async () => {
      const audioData = createAudioBuffer(64);
      const mockFetch = createMockFetch(new Map([
        ["getFile", {
          status: 200,
          body: { ok: true, result: { file_path: "voice/file_0.oga", file_size: 64 } },
        }],
        ["file/bot", {
          status: 200,
          body: audioData,
          headers: { "content-type": "audio/ogg", "content-length": "64" },
        }],
      ]));

      const message = createTelegramVoiceMessage();
      const options: VoiceHandlerOptions = {
        telegramBotToken: "123:ABC",
        fetchFn: mockFetch,
      };

      const result = await handleVoiceMessage(message, options);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.mimeType).toBe("audio/ogg");
        expect(result.value.sizeBytes).toBe(64);
        expect(result.value.durationMs).toBe(5_000);
        expect(result.value.platform).toBe("telegram");
        expect(result.value.fileName).toBe("voice.ogg");
      }
    });

    it("uses custom Telegram base URL", async () => {
      let capturedUrl = "";
      const audioData = createAudioBuffer(16);
      const mockFetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("getFile")) {
          capturedUrl = url;
          return new Response(
            JSON.stringify({ ok: true, result: { file_path: "voice/file.oga" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(audioData, {
          status: 200,
          headers: { "content-type": "audio/ogg" },
        });
      }) as typeof fetch;

      const message = createTelegramVoiceMessage();
      const options: VoiceHandlerOptions = {
        telegramBotToken: "123:ABC",
        telegramBaseUrl: "https://custom-tg.example.com",
        fetchFn: mockFetch,
      };

      await handleVoiceMessage(message, options);

      expect(capturedUrl).toContain("https://custom-tg.example.com/bot123:ABC/getFile");
    });

    it("returns error when Telegram bot token is missing", async () => {
      const message = createTelegramVoiceMessage();
      const result = await handleVoiceMessage(message, { fetchFn: createMockFetch(new Map()) });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ChannelError);
        expect(result.error.message).toContain("Telegram bot token required");
      }
    });

    it("returns error when Telegram bot token is empty string", async () => {
      const message = createTelegramVoiceMessage();
      const result = await handleVoiceMessage(message, {
        telegramBotToken: "",
        fetchFn: createMockFetch(new Map()),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Telegram bot token required");
      }
    });

    it("returns error when Telegram file_id is missing", async () => {
      const message = createTelegramVoiceMessage({
        voice: {
          mimeType: "audio/ogg",
          durationMs: 5_000,
          platformData: {},
        },
      });

      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        fetchFn: createMockFetch(new Map()),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("missing file_id");
      }
    });

    it("returns error when getFile API fails", async () => {
      const mockFetch = createMockFetch(new Map([
        ["getFile", { status: 400, body: { ok: false, error_code: 400, description: "Bad Request" } }],
      ]));

      const message = createTelegramVoiceMessage();
      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("getFile failed");
      }
    });

    it("returns error when getFile returns no file_path", async () => {
      const mockFetch = createMockFetch(new Map([
        ["getFile", { status: 200, body: { ok: true, result: {} } }],
      ]));

      const message = createTelegramVoiceMessage();
      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("no file_path");
      }
    });

    it("returns error when getFile returns invalid JSON", async () => {
      const mockFetch = (async () => {
        return new Response("not json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }) as typeof fetch;

      const message = createTelegramVoiceMessage();
      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("invalid JSON");
      }
    });

    it("returns error when getFile network request fails", async () => {
      const mockFetch = (async () => {
        throw new Error("Network error");
      }) as typeof fetch;

      const message = createTelegramVoiceMessage();
      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to resolve Telegram voice file URL");
      }
    });

    it("defaults MIME type to audio/ogg for Telegram when not specified", async () => {
      const audioData = createAudioBuffer(16);
      const mockFetch = createMockFetch(new Map([
        ["getFile", {
          status: 200,
          body: { ok: true, result: { file_path: "voice/file.oga" } },
        }],
        ["file/bot", {
          status: 200,
          body: audioData,
          headers: { "content-type": "audio/ogg" },
        }],
      ]));

      const message = createTelegramVoiceMessage({
        voice: {
          durationMs: 2_000,
          platformData: {
            file_id: "voice-file-abc",
            file_unique_id: "unique-abc",
          },
        },
      });

      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.mimeType).toBe("audio/ogg");
      }
    });
  });

  describe("Discord voice messages", () => {
    it("downloads a Discord voice file via direct URL", async () => {
      const audioData = createAudioBuffer(48);
      const mockFetch = createMockFetch(new Map([
        ["cdn.discordapp.com", {
          status: 200,
          body: audioData,
          headers: { "content-type": "audio/webm", "content-length": "48" },
        }],
      ]));

      const message = createDiscordVoiceMessage();
      const result = await handleVoiceMessage(message, { fetchFn: mockFetch });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.mimeType).toBe("audio/webm");
        expect(result.value.sizeBytes).toBe(48);
        expect(result.value.durationMs).toBe(3_000);
        expect(result.value.platform).toBe("discord");
        expect(result.value.fileName).toBe("voice-message.webm");
      }
    });

    it("falls back to proxy_url when direct URL is missing", async () => {
      const audioData = createAudioBuffer(16);
      let capturedUrl = "";
      const mockFetch = (async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return new Response(audioData, {
          status: 200,
          headers: { "content-type": "audio/webm" },
        });
      }) as typeof fetch;

      const message = createDiscordVoiceMessage({
        voice: {
          mimeType: "audio/webm",
          durationMs: 1_000,
          platformData: {
            attachment_id: "att-789",
            filename: "voice.webm",
            proxy_url: "https://media.discordapp.net/proxy/voice.webm",
            size: 500,
          },
        },
      });

      const result = await handleVoiceMessage(message, { fetchFn: mockFetch });

      expect(result.ok).toBe(true);
      expect(capturedUrl).toContain("media.discordapp.net/proxy/voice.webm");
    });

    it("returns error when Discord voice has no URL", async () => {
      const message = createDiscordVoiceMessage({
        voice: {
          mimeType: "audio/webm",
          durationMs: 1_000,
          platformData: {
            attachment_id: "att-789",
          },
        },
      });

      const result = await handleVoiceMessage(message, {
        fetchFn: createMockFetch(new Map()),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("no download URL");
      }
    });

    it("uses platform filename from Discord metadata", async () => {
      const audioData = createAudioBuffer(16);
      const mockFetch = createMockFetch(new Map([
        ["cdn.discordapp.com", {
          status: 200,
          body: audioData,
          headers: { "content-type": "audio/webm" },
        }],
      ]));

      const message = createDiscordVoiceMessage();
      const result = await handleVoiceMessage(message, { fetchFn: mockFetch });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fileName).toBe("voice-message.webm");
      }
    });

    it("defaults MIME type to audio/webm for Discord when not specified", async () => {
      const audioData = createAudioBuffer(16);
      const mockFetch = createMockFetch(new Map([
        ["cdn.discordapp.com", {
          status: 200,
          body: audioData,
          headers: { "content-type": "audio/webm" },
        }],
      ]));

      const message = createDiscordVoiceMessage({
        voice: {
          url: "https://cdn.discordapp.com/attachments/456/789/voice.webm",
          durationMs: 1_000,
          platformData: {
            attachment_id: "att-789",
            filename: "voice.webm",
          },
        },
      });

      const result = await handleVoiceMessage(message, { fetchFn: mockFetch });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.mimeType).toBe("audio/webm");
      }
    });
  });

  describe("common error handling", () => {
    it("returns error when message has no voice payload", async () => {
      const message: ChannelMessage = {
        id: "msg-3",
        platform: "telegram",
        channelId: "chat-123",
        sender: { id: "user-1" },
        timestamp: new Date(),
        text: "Hello",
      };

      const result = await handleVoiceMessage(message);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("does not contain a voice payload");
      }
    });

    it("returns error for unsupported MIME type", async () => {
      const message = createTelegramVoiceMessage({
        voice: {
          mimeType: "video/mp4",
          durationMs: 5_000,
          platformData: {
            file_id: "voice-file-abc",
            file_unique_id: "unique-abc",
          },
        },
      });

      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        fetchFn: createMockFetch(new Map()),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Unsupported voice format");
        expect(result.error.message).toContain("video/mp4");
      }
    });

    it("rejects files exceeding size limit from platform metadata", async () => {
      const message = createTelegramVoiceMessage({
        voice: {
          mimeType: "audio/ogg",
          durationMs: 300_000,
          platformData: {
            file_id: "voice-file-large",
            file_unique_id: "unique-large",
            file_size: 30 * 1024 * 1024,
          },
        },
      });

      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        fetchFn: createMockFetch(new Map()),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("too large");
      }
    });

    it("rejects files exceeding size limit from content-length header", async () => {
      const mockFetch = createMockFetch(new Map([
        ["getFile", {
          status: 200,
          body: { ok: true, result: { file_path: "voice/file.oga" } },
        }],
        ["file/bot", {
          status: 200,
          body: new Uint8Array(0),
          headers: {
            "content-type": "audio/ogg",
            "content-length": String(30 * 1024 * 1024),
          },
        }],
      ]));

      const message = createTelegramVoiceMessage({
        voice: {
          mimeType: "audio/ogg",
          durationMs: 300_000,
          platformData: {
            file_id: "voice-file-large",
            file_unique_id: "unique-large",
          },
        },
      });

      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("too large");
      }
    });

    it("rejects files exceeding size limit from actual buffer size", async () => {
      const overSizeBuffer = createAudioBuffer(64);
      const mockFetch = createMockFetch(new Map([
        ["getFile", {
          status: 200,
          body: { ok: true, result: { file_path: "voice/file.oga" } },
        }],
        ["file/bot", {
          status: 200,
          body: overSizeBuffer,
          headers: { "content-type": "audio/ogg" },
        }],
      ]));

      const message = createTelegramVoiceMessage({
        voice: {
          mimeType: "audio/ogg",
          durationMs: 300_000,
          platformData: {
            file_id: "voice-file-large",
            file_unique_id: "unique-large",
          },
        },
      });

      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        maxFileSizeBytes: 32,
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("too large");
      }
    });

    it("respects custom max file size", async () => {
      const message = createTelegramVoiceMessage({
        voice: {
          mimeType: "audio/ogg",
          durationMs: 5_000,
          platformData: {
            file_id: "voice-file-abc",
            file_unique_id: "unique-abc",
            file_size: 2_000,
          },
        },
      });

      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        maxFileSizeBytes: 1_000,
        fetchFn: createMockFetch(new Map()),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("too large");
      }
    });

    it("returns error when file download fails with HTTP error", async () => {
      const mockFetch = createMockFetch(new Map([
        ["getFile", {
          status: 200,
          body: { ok: true, result: { file_path: "voice/file.oga" } },
        }],
        ["file/bot", {
          status: 500,
          body: "Internal Server Error",
        }],
      ]));

      const message = createTelegramVoiceMessage();
      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("download failed");
      }
    });

    it("returns error when file download network request fails", async () => {
      let callCount = 0;
      const mockFetch = (async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({ ok: true, result: { file_path: "voice/file.oga" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error("Connection reset");
      }) as typeof fetch;

      const message = createTelegramVoiceMessage();
      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("download failed");
      }
    });

    it("preserves duration metadata in result", async () => {
      const audioData = createAudioBuffer(16);
      const mockFetch = createMockFetch(new Map([
        ["cdn.discordapp.com", {
          status: 200,
          body: audioData,
          headers: { "content-type": "audio/webm" },
        }],
      ]));

      const message = createDiscordVoiceMessage({
        voice: {
          url: "https://cdn.discordapp.com/attachments/456/789/voice.webm",
          mimeType: "audio/webm",
          durationMs: 42_500,
          platformData: {
            attachment_id: "att-789",
            filename: "voice.webm",
          },
        },
      });

      const result = await handleVoiceMessage(message, { fetchFn: mockFetch });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.durationMs).toBe(42_500);
      }
    });

    it("handles undefined duration gracefully", async () => {
      const audioData = createAudioBuffer(16);
      const mockFetch = createMockFetch(new Map([
        ["cdn.discordapp.com", {
          status: 200,
          body: audioData,
          headers: { "content-type": "audio/webm" },
        }],
      ]));

      const message = createDiscordVoiceMessage({
        voice: {
          url: "https://cdn.discordapp.com/attachments/456/789/voice.webm",
          mimeType: "audio/webm",
          platformData: {
            attachment_id: "att-789",
            filename: "voice.webm",
          },
        },
      });

      const result = await handleVoiceMessage(message, { fetchFn: mockFetch });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.durationMs).toBeUndefined();
      }
    });
  });

  describe("file name resolution", () => {
    it("generates voice.ogg for Telegram without platform filename", async () => {
      const audioData = createAudioBuffer(16);
      const mockFetch = createMockFetch(new Map([
        ["getFile", {
          status: 200,
          body: { ok: true, result: { file_path: "voice/file.oga" } },
        }],
        ["file/bot", {
          status: 200,
          body: audioData,
          headers: { "content-type": "audio/ogg" },
        }],
      ]));

      const message = createTelegramVoiceMessage();
      const result = await handleVoiceMessage(message, {
        telegramBotToken: "123:ABC",
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fileName).toBe("voice.ogg");
      }
    });

    it("generates voice.webm for Discord without platform filename", async () => {
      const audioData = createAudioBuffer(16);
      const mockFetch = createMockFetch(new Map([
        ["cdn.discordapp.com", {
          status: 200,
          body: audioData,
          headers: { "content-type": "audio/webm" },
        }],
      ]));

      const message = createDiscordVoiceMessage({
        voice: {
          url: "https://cdn.discordapp.com/attachments/456/789/voice.webm",
          mimeType: "audio/webm",
          platformData: {
            attachment_id: "att-789",
          },
        },
      });

      const result = await handleVoiceMessage(message, { fetchFn: mockFetch });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fileName).toBe("voice.webm");
      }
    });

    it("generates correct extension for audio/mpeg", async () => {
      const audioData = createAudioBuffer(16);
      const mockFetch = createMockFetch(new Map([
        ["cdn.discordapp.com", {
          status: 200,
          body: audioData,
          headers: { "content-type": "audio/mpeg" },
        }],
      ]));

      const message = createDiscordVoiceMessage({
        voice: {
          url: "https://cdn.discordapp.com/attachments/456/789/voice.mp3",
          mimeType: "audio/mpeg",
          platformData: {
            attachment_id: "att-789",
          },
        },
      });

      const result = await handleVoiceMessage(message, { fetchFn: mockFetch });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fileName).toBe("voice.mp3");
      }
    });
  });
});

describe("isSupportedAudioMimeType", () => {
  it("accepts audio/ogg", () => {
    expect(isSupportedAudioMimeType("audio/ogg")).toBe(true);
  });

  it("accepts audio/webm", () => {
    expect(isSupportedAudioMimeType("audio/webm")).toBe(true);
  });

  it("accepts audio/mpeg", () => {
    expect(isSupportedAudioMimeType("audio/mpeg")).toBe(true);
  });

  it("accepts audio/mp4", () => {
    expect(isSupportedAudioMimeType("audio/mp4")).toBe(true);
  });

  it("accepts audio/wav", () => {
    expect(isSupportedAudioMimeType("audio/wav")).toBe(true);
  });

  it("accepts audio/opus", () => {
    expect(isSupportedAudioMimeType("audio/opus")).toBe(true);
  });

  it("rejects video/mp4", () => {
    expect(isSupportedAudioMimeType("video/mp4")).toBe(false);
  });

  it("rejects text/plain", () => {
    expect(isSupportedAudioMimeType("text/plain")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSupportedAudioMimeType("")).toBe(false);
  });

  it("rejects application/octet-stream", () => {
    expect(isSupportedAudioMimeType("application/octet-stream")).toBe(false);
  });
});

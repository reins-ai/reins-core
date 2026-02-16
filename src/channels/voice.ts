import type { Result } from "../result";
import { ok, err } from "../result";
import { ChannelError } from "./errors";
import type {
  ChannelMessage,
  ChannelPlatform,
  ChannelVoice,
} from "./types";

/**
 * Maximum voice file size in bytes (25 MB — matches attachment limit).
 */
const MAX_VOICE_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * Default Telegram API base URL for file downloads.
 */
const DEFAULT_TELEGRAM_BASE_URL = "https://api.telegram.org";

/**
 * Known voice MIME types by platform.
 */
const PLATFORM_VOICE_MIME_TYPES: Record<ChannelPlatform, string> = {
  telegram: "audio/ogg",
  discord: "audio/webm",
};

/**
 * Supported audio MIME types for voice messages.
 */
const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  "audio/ogg",
  "audio/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/opus",
]);

/**
 * Downloaded voice file with metadata.
 */
export interface VoiceDownloadResult {
  buffer: ArrayBuffer;
  mimeType: string;
  sizeBytes: number;
  durationMs?: number;
  platform: ChannelPlatform;
  fileName: string;
}

/**
 * Options for the voice handler.
 */
export interface VoiceHandlerOptions {
  /**
   * Telegram bot token for file downloads via getFile API.
   * Required when processing Telegram voice messages.
   */
  telegramBotToken?: string;

  /**
   * Base URL for Telegram API (defaults to https://api.telegram.org).
   */
  telegramBaseUrl?: string;

  /**
   * Maximum allowed voice file size in bytes (defaults to 25 MB).
   */
  maxFileSizeBytes?: number;

  /**
   * Injectable fetch function for testing.
   */
  fetchFn?: typeof fetch;
}

/**
 * Resolve the download URL for a Telegram voice file.
 *
 * Telegram voice messages store a `file_id` in platform data.
 * We call `getFile` to obtain the `file_path`, then construct
 * the download URL.
 */
async function resolveTelegramFileUrl(
  fileId: string,
  botToken: string,
  baseUrl: string,
  fetchFn: typeof fetch,
): Promise<Result<string, ChannelError>> {
  const url = `${baseUrl}/bot${botToken}/getFile`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
  } catch (error) {
    return err(
      new ChannelError(
        "Failed to resolve Telegram voice file URL",
        error instanceof Error ? error : undefined,
      ),
    );
  }

  if (!response.ok) {
    return err(
      new ChannelError(
        `Telegram getFile failed with status ${response.status}`,
      ),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return err(new ChannelError("Telegram getFile returned invalid JSON"));
  }

  const data = body as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
  if (data.ok !== true || data.result?.file_path === undefined) {
    return err(new ChannelError("Telegram getFile returned no file_path"));
  }

  const downloadUrl = `${baseUrl}/file/bot${botToken}/${data.result.file_path}`;
  return ok(downloadUrl);
}

/**
 * Resolve the download URL for a Discord voice file.
 *
 * Discord voice messages are regular attachments with a direct URL.
 */
function resolveDiscordFileUrl(
  voice: ChannelVoice,
): Result<string, ChannelError> {
  if (voice.url !== undefined && voice.url.length > 0) {
    return ok(voice.url);
  }

  const proxyUrl = voice.platformData?.proxy_url;
  if (typeof proxyUrl === "string" && proxyUrl.length > 0) {
    return ok(proxyUrl);
  }

  return err(new ChannelError("Discord voice message has no download URL"));
}

/**
 * Download a file from a URL and return the raw buffer.
 */
async function downloadFile(
  url: string,
  maxSizeBytes: number,
  fetchFn: typeof fetch,
): Promise<Result<ArrayBuffer, ChannelError>> {
  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    return err(
      new ChannelError(
        "Voice file download failed",
        error instanceof Error ? error : undefined,
      ),
    );
  }

  if (!response.ok) {
    return err(
      new ChannelError(`Voice file download failed with status ${response.status}`),
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (Number.isFinite(size) && size > maxSizeBytes) {
      return err(
        new ChannelError(
          `Voice file too large: ${formatBytes(size)} exceeds ${formatBytes(maxSizeBytes)} limit`,
        ),
      );
    }
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (error) {
    return err(
      new ChannelError(
        "Failed to read voice file response body",
        error instanceof Error ? error : undefined,
      ),
    );
  }

  if (buffer.byteLength > maxSizeBytes) {
    return err(
      new ChannelError(
        `Voice file too large: ${formatBytes(buffer.byteLength)} exceeds ${formatBytes(maxSizeBytes)} limit`,
      ),
    );
  }

  return ok(buffer);
}

/**
 * Format byte count as a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Determine the MIME type for a voice message.
 */
function resolveVoiceMimeType(voice: ChannelVoice, platform: ChannelPlatform): string {
  if (voice.mimeType !== undefined && voice.mimeType.length > 0) {
    return voice.mimeType;
  }
  return PLATFORM_VOICE_MIME_TYPES[platform];
}

/**
 * Generate a file name for the downloaded voice file.
 */
function resolveVoiceFileName(voice: ChannelVoice, platform: ChannelPlatform): string {
  const discordFilename = voice.platformData?.filename;
  if (typeof discordFilename === "string" && discordFilename.length > 0) {
    return discordFilename;
  }

  const mimeType = resolveVoiceMimeType(voice, platform);
  const ext = mimeExtension(mimeType);
  return `voice.${ext}`;
}

/**
 * Map a MIME type to a file extension.
 */
function mimeExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/opus": "opus",
  };
  return map[mimeType] ?? "bin";
}

/**
 * Check whether a MIME type is a supported audio format.
 */
export function isSupportedAudioMimeType(mimeType: string): boolean {
  return SUPPORTED_AUDIO_MIME_TYPES.has(mimeType);
}

/**
 * Process an incoming voice message: validate, download, and return
 * the audio buffer with metadata.
 *
 * This function handles both Telegram and Discord voice messages.
 * Telegram voices require a `getFile` API call to resolve the download URL.
 * Discord voices have a direct attachment URL.
 *
 * The downloaded audio is returned as-is in its original format.
 * Transcription (if needed) is the agent's responsibility, not the
 * channel layer's.
 */
export async function handleVoiceMessage(
  message: ChannelMessage,
  options: VoiceHandlerOptions = {},
): Promise<Result<VoiceDownloadResult, ChannelError>> {
  const voice = message.voice;
  if (voice === undefined) {
    return err(new ChannelError("Message does not contain a voice payload"));
  }

  const maxSizeBytes = options.maxFileSizeBytes ?? MAX_VOICE_FILE_SIZE_BYTES;
  const fetchFn = options.fetchFn ?? fetch;

  const mimeType = resolveVoiceMimeType(voice, message.platform);
  if (!isSupportedAudioMimeType(mimeType)) {
    return err(
      new ChannelError(`Unsupported voice format: ${mimeType}`),
    );
  }

  const knownSize = voice.platformData?.file_size;
  if (typeof knownSize === "number" && knownSize > maxSizeBytes) {
    return err(
      new ChannelError(
        `Voice file too large: ${formatBytes(knownSize)} exceeds ${formatBytes(maxSizeBytes)} limit`,
      ),
    );
  }

  let downloadUrl: string;

  if (message.platform === "telegram") {
    const fileId = voice.platformData?.file_id;
    if (typeof fileId !== "string" || fileId.length === 0) {
      return err(new ChannelError("Telegram voice message missing file_id"));
    }

    if (options.telegramBotToken === undefined || options.telegramBotToken.length === 0) {
      return err(new ChannelError("Telegram bot token required to download voice files"));
    }

    const baseUrl = options.telegramBaseUrl ?? DEFAULT_TELEGRAM_BASE_URL;
    const urlResult = await resolveTelegramFileUrl(fileId, options.telegramBotToken, baseUrl, fetchFn);
    if (!urlResult.ok) {
      return err(urlResult.error);
    }
    downloadUrl = urlResult.value;
  } else if (message.platform === "discord") {
    const urlResult = resolveDiscordFileUrl(voice);
    if (!urlResult.ok) {
      return err(urlResult.error);
    }
    downloadUrl = urlResult.value;
  } else {
    return err(
      new ChannelError(`Unsupported platform for voice messages: ${message.platform as string}`),
    );
  }

  const bufferResult = await downloadFile(downloadUrl, maxSizeBytes, fetchFn);
  if (!bufferResult.ok) {
    return err(bufferResult.error);
  }

  const buffer = bufferResult.value;
  const fileName = resolveVoiceFileName(voice, message.platform);

  return ok({
    buffer,
    mimeType,
    sizeBytes: buffer.byteLength,
    durationMs: voice.durationMs,
    platform: message.platform,
    fileName,
  });
}

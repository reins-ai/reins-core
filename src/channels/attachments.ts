import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";

import { createLogger } from "../logger";
import { ChannelError } from "./errors";

const log = createLogger("channels:attachments");
import type { ChannelAttachment, ChannelPlatform } from "./types";

/**
 * Global attachment size limit in bytes (25 MB — strictest platform limit).
 * Discord non-boosted servers allow 25 MB; Telegram allows 50 MB.
 */
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * Default request timeout for attachment downloads (60 seconds).
 */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * MIME types considered safe for attachment handling.
 */
const ALLOWED_MIME_TYPES = new Set([
  // Images
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  // Documents
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/json",
  "application/xml",
  "text/plain",
  "text/csv",
  "text/html",
  "text/markdown",
  // Audio
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/aac",
  "audio/flac",
  // Video
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
]);

/**
 * Map file extensions to MIME types for detection.
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".md": "text/markdown",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

/**
 * Magic byte signatures for common file types.
 */
const MAGIC_BYTE_SIGNATURES: Array<{ bytes: number[]; offset: number; mimeType: string }> = [
  { bytes: [0xff, 0xd8, 0xff], offset: 0, mimeType: "image/jpeg" },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0, mimeType: "image/png" },
  { bytes: [0x47, 0x49, 0x46, 0x38], offset: 0, mimeType: "image/gif" },
  { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, mimeType: "image/webp" }, // RIFF header (check WEBP at offset 8)
  { bytes: [0x25, 0x50, 0x44, 0x46], offset: 0, mimeType: "application/pdf" },
  { bytes: [0x50, 0x4b, 0x03, 0x04], offset: 0, mimeType: "application/zip" },
  { bytes: [0x1f, 0x8b], offset: 0, mimeType: "application/gzip" },
  { bytes: [0x4f, 0x67, 0x67, 0x53], offset: 0, mimeType: "audio/ogg" },
  { bytes: [0x49, 0x44, 0x33], offset: 0, mimeType: "audio/mpeg" },
  { bytes: [0x66, 0x4c, 0x61, 0x43], offset: 0, mimeType: "audio/flac" },
];

/**
 * Result of downloading an attachment.
 */
export interface AttachmentDownloadResult {
  data: Uint8Array;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  tempPath: string | null;
}

/**
 * Result of uploading an attachment.
 */
export interface AttachmentUploadResult {
  platformId: string;
  url?: string;
  platform: ChannelPlatform;
}

/**
 * Options for downloading an attachment.
 */
export interface DownloadAttachmentOptions {
  url: string;
  platform: ChannelPlatform;
  fileName?: string;
  expectedMimeType?: string;
  authToken?: string;
  maxSizeBytes?: number;
  timeoutMs?: number;
}

/**
 * Options for uploading an attachment.
 */
export interface UploadAttachmentOptions {
  data: Uint8Array;
  fileName: string;
  mimeType: string;
  platform: ChannelPlatform;
  channelId: string;
}

/**
 * Injectable dependencies for the AttachmentHandler.
 */
export interface AttachmentHandlerOptions {
  fetchFn?: typeof fetch;
  tempDir?: string;
  maxSizeBytes?: number;
  mkdirFn?: typeof mkdir;
  writeFileFn?: typeof writeFile;
  readFileFn?: typeof readFile;
  rmFn?: typeof rm;
  randomIdFn?: () => string;
}

/**
 * Detect MIME type from file extension.
 */
export function detectMimeTypeFromExtension(fileName: string): string | null {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) {
    return null;
  }

  const extension = fileName.slice(dotIndex).toLowerCase();
  return EXTENSION_TO_MIME[extension] ?? null;
}

/**
 * Detect MIME type from magic bytes in file data.
 */
export function detectMimeTypeFromBytes(data: Uint8Array): string | null {
  if (data.length < 2) {
    return null;
  }

  for (const signature of MAGIC_BYTE_SIGNATURES) {
    if (data.length < signature.offset + signature.bytes.length) {
      continue;
    }

    let matches = true;
    for (let i = 0; i < signature.bytes.length; i += 1) {
      if (data[signature.offset + i] !== signature.bytes[i]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      // Special case: RIFF header could be WEBP or WAV
      if (signature.mimeType === "image/webp" && data.length >= 12) {
        const subtype = String.fromCharCode(data[8], data[9], data[10], data[11]);
        if (subtype === "WEBP") {
          return "image/webp";
        }
        if (subtype === "WAVE") {
          return "audio/wav";
        }
        return null;
      }

      return signature.mimeType;
    }
  }

  return null;
}

/**
 * Detect MIME type using extension first, then magic bytes as fallback.
 */
export function detectMimeType(fileName: string, data: Uint8Array): string {
  const fromExtension = detectMimeTypeFromExtension(fileName);
  if (fromExtension !== null) {
    return fromExtension;
  }

  const fromBytes = detectMimeTypeFromBytes(data);
  if (fromBytes !== null) {
    return fromBytes;
  }

  return "application/octet-stream";
}

/**
 * Validate that a MIME type is in the allowed set.
 */
export function isAllowedMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

/**
 * Validate attachment size against the global limit.
 */
export function validateAttachmentSize(
  sizeBytes: number,
  maxSizeBytes: number = MAX_ATTACHMENT_SIZE_BYTES,
): void {
  if (sizeBytes <= 0) {
    throw new ChannelError("Attachment size must be greater than zero");
  }

  if (sizeBytes > maxSizeBytes) {
    const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(0);
    const actualMb = (sizeBytes / (1024 * 1024)).toFixed(1);
    throw new ChannelError(
      `Attachment size ${actualMb} MB exceeds the ${maxMb} MB limit`,
    );
  }
}

/**
 * Extract a filename from a URL path, falling back to a generated name.
 */
export function extractFileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split("/").filter((s) => s.length > 0);
    const lastSegment = pathSegments[pathSegments.length - 1];
    if (lastSegment && lastSegment.includes(".")) {
      return decodeURIComponent(lastSegment);
    }
  } catch {
    // Expected: invalid URL — fall through to default filename
  }

  return "attachment";
}

/**
 * Convert a ChannelAttachment to download options.
 */
export function attachmentToDownloadOptions(
  attachment: ChannelAttachment,
  platform: ChannelPlatform,
  authToken?: string,
): DownloadAttachmentOptions | null {
  if (!attachment.url) {
    return null;
  }

  return {
    url: attachment.url,
    platform,
    fileName: attachment.fileName,
    expectedMimeType: attachment.mimeType,
    authToken,
  };
}

/**
 * Cross-platform attachment handler for downloading, validating,
 * and temporarily storing attachments in transit.
 */
export class AttachmentHandler {
  private readonly fetchFn: typeof fetch;
  private readonly tempBaseDir: string;
  private readonly maxSizeBytes: number;
  private readonly mkdirFn: typeof mkdir;
  private readonly writeFileFn: typeof writeFile;
  private readonly readFileFn: typeof readFile;
  private readonly rmFn: typeof rm;
  private readonly randomIdFn: () => string;

  private readonly activeTempPaths = new Set<string>();

  constructor(options: AttachmentHandlerOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.tempBaseDir = options.tempDir ?? join(tmpdir(), "reins-attachments");
    this.maxSizeBytes = options.maxSizeBytes ?? MAX_ATTACHMENT_SIZE_BYTES;
    this.mkdirFn = options.mkdirFn ?? mkdir;
    this.writeFileFn = options.writeFileFn ?? writeFile;
    this.readFileFn = options.readFileFn ?? readFile;
    this.rmFn = options.rmFn ?? rm;
    this.randomIdFn = options.randomIdFn ?? (() => crypto.randomUUID());
  }

  /**
   * Download an attachment from a platform URL, validate it,
   * and optionally store it in a temp file.
   */
  public async downloadAttachment(
    options: DownloadAttachmentOptions,
  ): Promise<AttachmentDownloadResult> {
    const { url, fileName: providedFileName, expectedMimeType, authToken } = options;
    const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    const maxSize = options.maxSizeBytes ?? this.maxSizeBytes;

    // Build request headers
    const headers: Record<string, string> = {};
    if (authToken) {
      headers["authorization"] = `Bearer ${authToken}`;
    }

    // Execute download with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new ChannelError(`Attachment download timed out after ${timeoutMs}ms`);
      }
      throw new ChannelError(
        "Attachment download failed",
        error instanceof Error ? error : undefined,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new ChannelError(
        `Attachment download failed with status ${response.status}`,
      );
    }

    // Check Content-Length header before downloading body
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const declaredSize = parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declaredSize) && declaredSize > maxSize) {
        // Consume body to avoid connection leak
        try { await response.body?.cancel(); } catch { /* Expected: body may already be consumed */ }
        const maxMb = (maxSize / (1024 * 1024)).toFixed(0);
        const actualMb = (declaredSize / (1024 * 1024)).toFixed(1);
        throw new ChannelError(
          `Attachment size ${actualMb} MB exceeds the ${maxMb} MB limit`,
        );
      }
    }

    // Read response body
    let data: Uint8Array;
    try {
      const arrayBuffer = await response.arrayBuffer();
      data = new Uint8Array(arrayBuffer);
    } catch (error) {
      throw new ChannelError(
        "Failed to read attachment data",
        error instanceof Error ? error : undefined,
      );
    }

    // Validate actual size
    validateAttachmentSize(data.length, maxSize);

    // Determine filename
    const fileName = providedFileName ?? extractFileNameFromUrl(url);

    // Detect MIME type
    const detectedMimeType = detectMimeType(fileName, data);
    const mimeType = expectedMimeType ?? detectedMimeType;

    // Validate MIME type
    if (!isAllowedMimeType(mimeType)) {
      throw new ChannelError(
        `Attachment MIME type "${mimeType}" is not allowed`,
      );
    }

    // Store in temp directory
    const tempPath = await this.writeTempFile(fileName, data);

    return {
      data,
      mimeType,
      fileName,
      sizeBytes: data.length,
      tempPath,
    };
  }

  /**
   * Prepare attachment data for upload to a target platform.
   * Returns the upload options with validated data.
   */
  public async prepareUpload(
    options: UploadAttachmentOptions,
  ): Promise<UploadAttachmentOptions> {
    validateAttachmentSize(options.data.length, this.maxSizeBytes);

    if (!isAllowedMimeType(options.mimeType)) {
      throw new ChannelError(
        `Attachment MIME type "${options.mimeType}" is not allowed`,
      );
    }

    return options;
  }

  /**
   * Read a previously downloaded attachment from its temp path.
   */
  public async readTempFile(tempPath: string): Promise<Uint8Array> {
    try {
      const buffer = await this.readFileFn(tempPath);
      return new Uint8Array(buffer);
    } catch (error) {
      throw new ChannelError(
        `Failed to read temp attachment at ${tempPath}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Clean up a specific temp file.
   */
  public async cleanupTempFile(tempPath: string): Promise<void> {
    try {
      await this.rmFn(tempPath, { force: true });
      this.activeTempPaths.delete(tempPath);
    } catch (e) {
      // Expected: file may already be gone
      log.debug("temp file cleanup failed", { tempPath, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Clean up all tracked temp files.
   */
  public async cleanupAll(): Promise<void> {
    const paths = [...this.activeTempPaths];
    this.activeTempPaths.clear();

    await Promise.allSettled(
      paths.map((p) => this.rmFn(p, { force: true })),
    );
  }

  /**
   * Get the number of active temp files being tracked.
   */
  public get activeTempFileCount(): number {
    return this.activeTempPaths.size;
  }

  private async writeTempFile(fileName: string, data: Uint8Array): Promise<string> {
    const uniqueId = this.randomIdFn();
    const safeFileName = sanitizeFileName(fileName);
    const tempDir = join(this.tempBaseDir, uniqueId);

    try {
      await this.mkdirFn(tempDir, { recursive: true });
    } catch (error) {
      throw new ChannelError(
        "Failed to create temp directory for attachment",
        error instanceof Error ? error : undefined,
      );
    }

    const tempPath = join(tempDir, safeFileName);

    try {
      await this.writeFileFn(tempPath, data);
    } catch (error) {
      throw new ChannelError(
        "Failed to write attachment to temp file",
        error instanceof Error ? error : undefined,
      );
    }

    this.activeTempPaths.add(tempPath);
    return tempPath;
  }
}

/**
 * Sanitize a filename to prevent path traversal and invalid characters.
 */
function sanitizeFileName(fileName: string): string {
  // Remove path separators and null bytes
  const sanitized = fileName
    .replace(/[/\\]/g, "_")
    .replace(/\0/g, "")
    .replace(/\.\./g, "_")
    .trim();

  if (sanitized.length === 0) {
    return "attachment";
  }

  // Limit length to 255 characters
  if (sanitized.length > 255) {
    const dotIndex = sanitized.lastIndexOf(".");
    if (dotIndex > 0) {
      const ext = sanitized.slice(dotIndex);
      const name = sanitized.slice(0, 255 - ext.length);
      return name + ext;
    }
    return sanitized.slice(0, 255);
  }

  return sanitized;
}

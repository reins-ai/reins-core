import { describe, expect, it } from "bun:test";

import { ChannelError } from "../../src/channels/errors";
import {
  AttachmentHandler,
  MAX_ATTACHMENT_SIZE_BYTES,
  detectMimeType,
  detectMimeTypeFromBytes,
  detectMimeTypeFromExtension,
  extractFileNameFromUrl,
  isAllowedMimeType,
  validateAttachmentSize,
  attachmentToDownloadOptions,
  type AttachmentHandlerOptions,
  type DownloadAttachmentOptions,
} from "../../src/channels/attachments";
import type { ChannelAttachment } from "../../src/channels/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFetch(
  options: {
    status?: number;
    body?: Uint8Array | string;
    headers?: Record<string, string>;
    throwError?: Error;
  } = {},
): typeof fetch {
  const {
    status = 200,
    body = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]),
    headers = {},
    throwError,
  } = options;

  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    if (throwError) {
      throw throwError;
    }

    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has("content-type")) {
      responseHeaders.set("content-type", "application/octet-stream");
    }

    const responseBody = typeof body === "string"
      ? new TextEncoder().encode(body)
      : body;

    return new Response(responseBody, {
      status,
      headers: responseHeaders,
    });
  }) as typeof fetch;
}

interface MockFs {
  dirs: string[];
  files: Map<string, Uint8Array>;
  removed: string[];
}

function createMockFs(): MockFs & {
  mkdirFn: typeof import("node:fs/promises").mkdir;
  writeFileFn: typeof import("node:fs/promises").writeFile;
  readFileFn: typeof import("node:fs/promises").readFile;
  rmFn: typeof import("node:fs/promises").rm;
} {
  const state: MockFs = {
    dirs: [],
    files: new Map(),
    removed: [],
  };

  const mkdirFn = (async (path: string) => {
    state.dirs.push(path);
    return undefined;
  }) as unknown as typeof import("node:fs/promises").mkdir;

  const writeFileFn = (async (path: string, data: Uint8Array) => {
    state.files.set(path, data);
  }) as unknown as typeof import("node:fs/promises").writeFile;

  const readFileFn = (async (path: string) => {
    const data = state.files.get(path);
    if (!data) {
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    return data;
  }) as unknown as typeof import("node:fs/promises").readFile;

  const rmFn = (async (path: string) => {
    state.removed.push(path);
    state.files.delete(path);
  }) as unknown as typeof import("node:fs/promises").rm;

  return { ...state, mkdirFn, writeFileFn, readFileFn, rmFn };
}

let idCounter = 0;

function createHandler(
  overrides: Partial<AttachmentHandlerOptions> = {},
): { handler: AttachmentHandler; fs: ReturnType<typeof createMockFs> } {
  const fs = createMockFs();
  idCounter = 0;

  const handler = new AttachmentHandler({
    fetchFn: overrides.fetchFn ?? createMockFetch(),
    tempDir: overrides.tempDir ?? "/tmp/reins-test-attachments",
    mkdirFn: fs.mkdirFn,
    writeFileFn: fs.writeFileFn,
    readFileFn: fs.readFileFn,
    rmFn: fs.rmFn,
    randomIdFn: overrides.randomIdFn ?? (() => {
      idCounter += 1;
      return `test-id-${idCounter}`;
    }),
    ...overrides,
  });

  return { handler, fs };
}

// ---------------------------------------------------------------------------
// MIME type detection from extension
// ---------------------------------------------------------------------------

describe("detectMimeTypeFromExtension", () => {
  it("detects common image types", () => {
    expect(detectMimeTypeFromExtension("photo.jpg")).toBe("image/jpeg");
    expect(detectMimeTypeFromExtension("photo.jpeg")).toBe("image/jpeg");
    expect(detectMimeTypeFromExtension("image.png")).toBe("image/png");
    expect(detectMimeTypeFromExtension("animation.gif")).toBe("image/gif");
    expect(detectMimeTypeFromExtension("modern.webp")).toBe("image/webp");
  });

  it("detects document types", () => {
    expect(detectMimeTypeFromExtension("report.pdf")).toBe("application/pdf");
    expect(detectMimeTypeFromExtension("archive.zip")).toBe("application/zip");
    expect(detectMimeTypeFromExtension("data.json")).toBe("application/json");
    expect(detectMimeTypeFromExtension("readme.txt")).toBe("text/plain");
    expect(detectMimeTypeFromExtension("notes.md")).toBe("text/markdown");
    expect(detectMimeTypeFromExtension("data.csv")).toBe("text/csv");
  });

  it("detects audio types", () => {
    expect(detectMimeTypeFromExtension("song.mp3")).toBe("audio/mpeg");
    expect(detectMimeTypeFromExtension("voice.ogg")).toBe("audio/ogg");
    expect(detectMimeTypeFromExtension("sound.wav")).toBe("audio/wav");
    expect(detectMimeTypeFromExtension("music.flac")).toBe("audio/flac");
  });

  it("detects video types", () => {
    expect(detectMimeTypeFromExtension("clip.mp4")).toBe("video/mp4");
    expect(detectMimeTypeFromExtension("stream.webm")).toBe("video/webm");
    expect(detectMimeTypeFromExtension("movie.mov")).toBe("video/quicktime");
  });

  it("is case-insensitive for extensions", () => {
    expect(detectMimeTypeFromExtension("PHOTO.JPG")).toBe("image/jpeg");
    expect(detectMimeTypeFromExtension("Image.PNG")).toBe("image/png");
    expect(detectMimeTypeFromExtension("doc.PDF")).toBe("application/pdf");
  });

  it("returns null for unknown extensions", () => {
    expect(detectMimeTypeFromExtension("file.xyz")).toBeNull();
    expect(detectMimeTypeFromExtension("data.custom")).toBeNull();
  });

  it("returns null for files without extensions", () => {
    expect(detectMimeTypeFromExtension("noextension")).toBeNull();
    expect(detectMimeTypeFromExtension("Makefile")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MIME type detection from magic bytes
// ---------------------------------------------------------------------------

describe("detectMimeTypeFromBytes", () => {
  it("detects JPEG from magic bytes", () => {
    const data = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectMimeTypeFromBytes(data)).toBe("image/jpeg");
  });

  it("detects PNG from magic bytes", () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(detectMimeTypeFromBytes(data)).toBe("image/png");
  });

  it("detects GIF from magic bytes", () => {
    const data = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectMimeTypeFromBytes(data)).toBe("image/gif");
  });

  it("detects WEBP from RIFF+WEBP magic bytes", () => {
    // RIFF....WEBP
    const data = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectMimeTypeFromBytes(data)).toBe("image/webp");
  });

  it("detects WAV from RIFF+WAVE magic bytes", () => {
    const data = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45,
    ]);
    expect(detectMimeTypeFromBytes(data)).toBe("audio/wav");
  });

  it("returns null for RIFF with unknown subtype", () => {
    const data = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x41, 0x56, 0x49, 0x20,
    ]);
    expect(detectMimeTypeFromBytes(data)).toBeNull();
  });

  it("detects PDF from magic bytes", () => {
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    expect(detectMimeTypeFromBytes(data)).toBe("application/pdf");
  });

  it("detects ZIP from magic bytes", () => {
    const data = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(detectMimeTypeFromBytes(data)).toBe("application/zip");
  });

  it("detects GZIP from magic bytes", () => {
    const data = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    expect(detectMimeTypeFromBytes(data)).toBe("application/gzip");
  });

  it("detects OGG from magic bytes", () => {
    const data = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00]);
    expect(detectMimeTypeFromBytes(data)).toBe("audio/ogg");
  });

  it("detects MP3 (ID3) from magic bytes", () => {
    const data = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
    expect(detectMimeTypeFromBytes(data)).toBe("audio/mpeg");
  });

  it("detects FLAC from magic bytes", () => {
    const data = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x00]);
    expect(detectMimeTypeFromBytes(data)).toBe("audio/flac");
  });

  it("returns null for empty data", () => {
    expect(detectMimeTypeFromBytes(new Uint8Array([]))).toBeNull();
  });

  it("returns null for single byte", () => {
    expect(detectMimeTypeFromBytes(new Uint8Array([0xff]))).toBeNull();
  });

  it("returns null for unrecognized bytes", () => {
    const data = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(detectMimeTypeFromBytes(data)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Combined MIME type detection
// ---------------------------------------------------------------------------

describe("detectMimeType", () => {
  it("prefers extension-based detection", () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Extension says JPEG, bytes say PNG — extension wins
    expect(detectMimeType("photo.jpg", pngBytes)).toBe("image/jpeg");
  });

  it("falls back to magic bytes when extension is unknown", () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectMimeType("file.unknown", pngBytes)).toBe("image/png");
  });

  it("falls back to octet-stream when nothing matches", () => {
    const unknownBytes = new Uint8Array([0x00, 0x01, 0x02]);
    expect(detectMimeType("noext", unknownBytes)).toBe("application/octet-stream");
  });
});

// ---------------------------------------------------------------------------
// MIME type validation
// ---------------------------------------------------------------------------

describe("isAllowedMimeType", () => {
  it("allows common image types", () => {
    expect(isAllowedMimeType("image/jpeg")).toBe(true);
    expect(isAllowedMimeType("image/png")).toBe(true);
    expect(isAllowedMimeType("image/gif")).toBe(true);
    expect(isAllowedMimeType("image/webp")).toBe(true);
  });

  it("allows common document types", () => {
    expect(isAllowedMimeType("application/pdf")).toBe(true);
    expect(isAllowedMimeType("application/zip")).toBe(true);
    expect(isAllowedMimeType("text/plain")).toBe(true);
  });

  it("allows audio types", () => {
    expect(isAllowedMimeType("audio/mpeg")).toBe(true);
    expect(isAllowedMimeType("audio/ogg")).toBe(true);
  });

  it("allows video types", () => {
    expect(isAllowedMimeType("video/mp4")).toBe(true);
    expect(isAllowedMimeType("video/webm")).toBe(true);
  });

  it("rejects unknown MIME types", () => {
    expect(isAllowedMimeType("application/x-executable")).toBe(false);
    expect(isAllowedMimeType("application/x-msdownload")).toBe(false);
    expect(isAllowedMimeType("text/x-shellscript")).toBe(false);
    expect(isAllowedMimeType("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Size validation
// ---------------------------------------------------------------------------

describe("validateAttachmentSize", () => {
  it("accepts sizes within the limit", () => {
    expect(() => validateAttachmentSize(1)).not.toThrow();
    expect(() => validateAttachmentSize(1024)).not.toThrow();
    expect(() => validateAttachmentSize(MAX_ATTACHMENT_SIZE_BYTES)).not.toThrow();
  });

  it("throws for zero-byte attachments", () => {
    expect(() => validateAttachmentSize(0)).toThrow(ChannelError);
    expect(() => validateAttachmentSize(0)).toThrow("greater than zero");
  });

  it("throws for negative sizes", () => {
    expect(() => validateAttachmentSize(-1)).toThrow(ChannelError);
  });

  it("throws for sizes exceeding the limit", () => {
    expect(() => validateAttachmentSize(MAX_ATTACHMENT_SIZE_BYTES + 1)).toThrow(ChannelError);
    expect(() => validateAttachmentSize(MAX_ATTACHMENT_SIZE_BYTES + 1)).toThrow("exceeds");
  });

  it("respects custom max size", () => {
    const customMax = 1024;
    expect(() => validateAttachmentSize(1024, customMax)).not.toThrow();
    expect(() => validateAttachmentSize(1025, customMax)).toThrow(ChannelError);
  });

  it("includes human-readable sizes in error message", () => {
    const thirtyMb = 30 * 1024 * 1024;
    try {
      validateAttachmentSize(thirtyMb);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelError);
      expect((error as ChannelError).message).toContain("30");
      expect((error as ChannelError).message).toContain("25");
    }
  });
});

// ---------------------------------------------------------------------------
// URL filename extraction
// ---------------------------------------------------------------------------

describe("extractFileNameFromUrl", () => {
  it("extracts filename from a simple URL", () => {
    expect(extractFileNameFromUrl("https://example.com/files/photo.jpg")).toBe("photo.jpg");
  });

  it("extracts filename from a URL with query params", () => {
    expect(extractFileNameFromUrl("https://cdn.example.com/doc.pdf?token=abc")).toBe("doc.pdf");
  });

  it("decodes URL-encoded filenames", () => {
    expect(extractFileNameFromUrl("https://example.com/my%20file.txt")).toBe("my file.txt");
  });

  it("returns default for URLs without a file extension", () => {
    expect(extractFileNameFromUrl("https://example.com/api/download")).toBe("attachment");
  });

  it("returns default for invalid URLs", () => {
    expect(extractFileNameFromUrl("not-a-url")).toBe("attachment");
  });

  it("returns default for empty string", () => {
    expect(extractFileNameFromUrl("")).toBe("attachment");
  });

  it("handles deeply nested paths", () => {
    expect(extractFileNameFromUrl("https://cdn.example.com/a/b/c/d/image.png")).toBe("image.png");
  });
});

// ---------------------------------------------------------------------------
// attachmentToDownloadOptions
// ---------------------------------------------------------------------------

describe("attachmentToDownloadOptions", () => {
  it("converts a ChannelAttachment with URL to download options", () => {
    const attachment: ChannelAttachment = {
      type: "image",
      url: "https://cdn.example.com/photo.jpg",
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
    };

    const result = attachmentToDownloadOptions(attachment, "telegram", "bot-token");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://cdn.example.com/photo.jpg");
    expect(result!.platform).toBe("telegram");
    expect(result!.fileName).toBe("photo.jpg");
    expect(result!.expectedMimeType).toBe("image/jpeg");
    expect(result!.authToken).toBe("bot-token");
  });

  it("returns null when attachment has no URL", () => {
    const attachment: ChannelAttachment = {
      type: "file",
      fileName: "doc.pdf",
    };

    expect(attachmentToDownloadOptions(attachment, "discord")).toBeNull();
  });

  it("works without optional fields", () => {
    const attachment: ChannelAttachment = {
      type: "image",
      url: "https://example.com/img.png",
    };

    const result = attachmentToDownloadOptions(attachment, "discord");
    expect(result).not.toBeNull();
    expect(result!.fileName).toBeUndefined();
    expect(result!.expectedMimeType).toBeUndefined();
    expect(result!.authToken).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MAX_ATTACHMENT_SIZE_BYTES constant
// ---------------------------------------------------------------------------

describe("MAX_ATTACHMENT_SIZE_BYTES", () => {
  it("is 25 MB", () => {
    expect(MAX_ATTACHMENT_SIZE_BYTES).toBe(25 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// AttachmentHandler — downloadAttachment
// ---------------------------------------------------------------------------

describe("AttachmentHandler", () => {
  describe("downloadAttachment", () => {
    it("downloads a file and stores it in temp directory", async () => {
      const fileData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      const { handler, fs } = createHandler({
        fetchFn: createMockFetch({ body: fileData }),
      });

      const result = await handler.downloadAttachment({
        url: "https://cdn.telegram.org/file/photo.png",
        platform: "telegram",
      });

      expect(result.data).toEqual(fileData);
      expect(result.mimeType).toBe("image/png");
      expect(result.fileName).toBe("photo.png");
      expect(result.sizeBytes).toBe(fileData.length);
      expect(result.tempPath).toContain("test-id-1");
      expect(result.tempPath).toContain("photo.png");
      expect(fs.files.size).toBe(1);
    });

    it("uses provided fileName over URL-extracted name", async () => {
      const { handler } = createHandler({
        fetchFn: createMockFetch({ body: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }),
      });

      const result = await handler.downloadAttachment({
        url: "https://example.com/api/download/12345",
        platform: "discord",
        fileName: "report.pdf",
      });

      expect(result.fileName).toBe("report.pdf");
      expect(result.mimeType).toBe("application/pdf");
    });

    it("uses expectedMimeType when provided", async () => {
      const { handler } = createHandler({
        fetchFn: createMockFetch({ body: new Uint8Array([0x00, 0x01, 0x02]) }),
      });

      const result = await handler.downloadAttachment({
        url: "https://example.com/file.txt",
        platform: "telegram",
        expectedMimeType: "text/plain",
      });

      expect(result.mimeType).toBe("text/plain");
    });

    it("sends authorization header when authToken is provided", async () => {
      let capturedHeaders: Headers | undefined;
      const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(new Uint8Array([0x48, 0x65]), { status: 200 });
      }) as typeof fetch;

      const { handler } = createHandler({ fetchFn: mockFetch });

      await handler.downloadAttachment({
        url: "https://api.telegram.org/file/bot123/photo.jpg",
        platform: "telegram",
        authToken: "my-secret-token",
      });

      expect(capturedHeaders?.get("authorization")).toBe("Bearer my-secret-token");
    });

    it("throws on HTTP error status", async () => {
      const { handler } = createHandler({
        fetchFn: createMockFetch({ status: 404 }),
      });

      await expect(
        handler.downloadAttachment({
          url: "https://example.com/missing.jpg",
          platform: "telegram",
        }),
      ).rejects.toThrow(ChannelError);
    });

    it("throws on HTTP 500 error", async () => {
      const { handler } = createHandler({
        fetchFn: createMockFetch({ status: 500 }),
      });

      await expect(
        handler.downloadAttachment({
          url: "https://example.com/error.jpg",
          platform: "discord",
        }),
      ).rejects.toThrow("status 500");
    });

    it("throws on network error", async () => {
      const { handler } = createHandler({
        fetchFn: createMockFetch({ throwError: new Error("ECONNREFUSED") }),
      });

      await expect(
        handler.downloadAttachment({
          url: "https://unreachable.example.com/file.jpg",
          platform: "telegram",
        }),
      ).rejects.toThrow(ChannelError);
    });

    it("throws on timeout (AbortError)", async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";

      const { handler } = createHandler({
        fetchFn: createMockFetch({ throwError: abortError }),
      });

      await expect(
        handler.downloadAttachment({
          url: "https://slow.example.com/large.zip",
          platform: "discord",
          timeoutMs: 100,
        }),
      ).rejects.toThrow("timed out");
    });

    it("rejects files exceeding size limit from Content-Length header", async () => {
      const oversizeLength = (MAX_ATTACHMENT_SIZE_BYTES + 1).toString();
      const { handler } = createHandler({
        fetchFn: createMockFetch({
          headers: { "content-length": oversizeLength },
          body: new Uint8Array(10), // Small body — header check should catch it first
        }),
      });

      await expect(
        handler.downloadAttachment({
          url: "https://example.com/huge.zip",
          platform: "telegram",
        }),
      ).rejects.toThrow("exceeds");
    });

    it("rejects files exceeding size limit from actual body size", async () => {
      // Create a body that's just over the custom limit
      const customMax = 100;
      const oversizeBody = new Uint8Array(101);
      const { handler } = createHandler({
        fetchFn: createMockFetch({ body: oversizeBody }),
        maxSizeBytes: customMax,
      });

      await expect(
        handler.downloadAttachment({
          url: "https://example.com/file.txt",
          platform: "discord",
        }),
      ).rejects.toThrow("exceeds");
    });

    it("rejects disallowed MIME types", async () => {
      const { handler } = createHandler({
        fetchFn: createMockFetch({ body: new Uint8Array([0x4d, 0x5a]) }), // MZ header (executable)
      });

      await expect(
        handler.downloadAttachment({
          url: "https://example.com/malware.exe",
          platform: "telegram",
          expectedMimeType: "application/x-executable",
        }),
      ).rejects.toThrow("not allowed");
    });

    it("creates unique temp directories per download", async () => {
      const fileData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
      const { handler, fs } = createHandler({
        fetchFn: createMockFetch({ body: fileData }),
      });

      const result1 = await handler.downloadAttachment({
        url: "https://example.com/file1.txt",
        platform: "telegram",
      });

      const result2 = await handler.downloadAttachment({
        url: "https://example.com/file2.txt",
        platform: "discord",
      });

      expect(result1.tempPath).not.toBe(result2.tempPath);
      expect(result1.tempPath).toContain("test-id-1");
      expect(result2.tempPath).toContain("test-id-2");
      expect(fs.files.size).toBe(2);
    });

    it("tracks active temp files", async () => {
      const { handler } = createHandler({
        fetchFn: createMockFetch({ body: new Uint8Array([0x48, 0x69]) }),
      });

      expect(handler.activeTempFileCount).toBe(0);

      await handler.downloadAttachment({
        url: "https://example.com/a.txt",
        platform: "telegram",
      });

      expect(handler.activeTempFileCount).toBe(1);

      await handler.downloadAttachment({
        url: "https://example.com/b.txt",
        platform: "discord",
      });

      expect(handler.activeTempFileCount).toBe(2);
    });

    it("respects per-request maxSizeBytes override", async () => {
      const body = new Uint8Array(200);
      const { handler } = createHandler({
        fetchFn: createMockFetch({ body }),
        maxSizeBytes: 1000, // Handler default is generous
      });

      await expect(
        handler.downloadAttachment({
          url: "https://example.com/file.txt",
          platform: "telegram",
          maxSizeBytes: 100, // Per-request override is strict
        }),
      ).rejects.toThrow("exceeds");
    });
  });

  // -------------------------------------------------------------------------
  // prepareUpload
  // -------------------------------------------------------------------------

  describe("prepareUpload", () => {
    it("returns validated upload options for valid input", async () => {
      const { handler } = createHandler();
      const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

      const result = await handler.prepareUpload({
        data,
        fileName: "image.png",
        mimeType: "image/png",
        platform: "telegram",
        channelId: "12345",
      });

      expect(result.data).toBe(data);
      expect(result.fileName).toBe("image.png");
      expect(result.mimeType).toBe("image/png");
      expect(result.platform).toBe("telegram");
      expect(result.channelId).toBe("12345");
    });

    it("throws for oversized upload data", async () => {
      const { handler } = createHandler({ maxSizeBytes: 100 });
      const data = new Uint8Array(101);

      await expect(
        handler.prepareUpload({
          data,
          fileName: "big.bin",
          mimeType: "text/plain",
          platform: "discord",
          channelId: "ch-1",
        }),
      ).rejects.toThrow("exceeds");
    });

    it("throws for disallowed MIME type on upload", async () => {
      const { handler } = createHandler();

      await expect(
        handler.prepareUpload({
          data: new Uint8Array([0x00]),
          fileName: "script.sh",
          mimeType: "application/x-shellscript",
          platform: "telegram",
          channelId: "12345",
        }),
      ).rejects.toThrow("not allowed");
    });
  });

  // -------------------------------------------------------------------------
  // readTempFile
  // -------------------------------------------------------------------------

  describe("readTempFile", () => {
    it("reads a previously written temp file", async () => {
      const fileData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
      const { handler } = createHandler({
        fetchFn: createMockFetch({ body: fileData }),
      });

      const downloadResult = await handler.downloadAttachment({
        url: "https://example.com/hello.txt",
        platform: "telegram",
      });

      const readData = await handler.readTempFile(downloadResult.tempPath!);
      expect(readData).toEqual(fileData);
    });

    it("throws for non-existent temp file", async () => {
      const { handler } = createHandler();

      await expect(
        handler.readTempFile("/tmp/nonexistent/file.txt"),
      ).rejects.toThrow(ChannelError);
    });
  });

  // -------------------------------------------------------------------------
  // cleanupTempFile
  // -------------------------------------------------------------------------

  describe("cleanupTempFile", () => {
    it("removes a specific temp file and decrements count", async () => {
      const { handler, fs } = createHandler({
        fetchFn: createMockFetch({ body: new Uint8Array([0x48, 0x69]) }),
      });

      const result = await handler.downloadAttachment({
        url: "https://example.com/file.txt",
        platform: "telegram",
      });

      expect(handler.activeTempFileCount).toBe(1);

      await handler.cleanupTempFile(result.tempPath!);

      expect(handler.activeTempFileCount).toBe(0);
      expect(fs.removed).toContain(result.tempPath);
    });

    it("does not throw for already-removed files", async () => {
      const { handler } = createHandler();

      // Should not throw even for non-existent paths
      await expect(
        handler.cleanupTempFile("/tmp/already-gone/file.txt"),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // cleanupAll
  // -------------------------------------------------------------------------

  describe("cleanupAll", () => {
    it("removes all tracked temp files", async () => {
      const { handler, fs } = createHandler({
        fetchFn: createMockFetch({ body: new Uint8Array([0x48, 0x69]) }),
      });

      await handler.downloadAttachment({
        url: "https://example.com/a.txt",
        platform: "telegram",
      });

      await handler.downloadAttachment({
        url: "https://example.com/b.txt",
        platform: "discord",
      });

      expect(handler.activeTempFileCount).toBe(2);

      await handler.cleanupAll();

      expect(handler.activeTempFileCount).toBe(0);
      expect(fs.removed.length).toBe(2);
    });

    it("handles empty state gracefully", async () => {
      const { handler } = createHandler();

      expect(handler.activeTempFileCount).toBe(0);
      await expect(handler.cleanupAll()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Filename sanitization (via downloadAttachment)
  // -------------------------------------------------------------------------

  describe("filename sanitization", () => {
    it("sanitizes path traversal attempts in filenames", async () => {
      const { handler } = createHandler({
        fetchFn: createMockFetch({ body: new Uint8Array([0x48, 0x69]) }),
      });

      const result = await handler.downloadAttachment({
        url: "https://example.com/file.txt",
        platform: "telegram",
        fileName: "../../../etc/passwd.txt",
        expectedMimeType: "text/plain",
      });

      expect(result.fileName).toBe("../../../etc/passwd.txt");
      // The temp path should have sanitized separators (no ../)
      expect(result.tempPath).not.toContain("../");
    });

    it("handles filenames with null bytes", async () => {
      const { handler } = createHandler({
        fetchFn: createMockFetch({ body: new Uint8Array([0x48, 0x69]) }),
      });

      const result = await handler.downloadAttachment({
        url: "https://example.com/file.txt",
        platform: "telegram",
        fileName: "file\0.txt",
        expectedMimeType: "text/plain",
      });

      // The temp path should not contain null bytes
      expect(result.tempPath).not.toContain("\0");
    });
  });
});

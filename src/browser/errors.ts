import { ReinsError } from "../errors";

export class BrowserError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "BROWSER_ERROR", cause);
    this.name = "BrowserError";
  }
}

export class CdpError extends ReinsError {
  readonly cdpCode?: number;

  constructor(message: string, options?: { cdpCode?: number; cause?: Error }) {
    super(message, "CDP_ERROR", options?.cause);
    this.name = "CdpError";
    this.cdpCode = options?.cdpCode;
  }
}

export class ChromeNotFoundError extends ReinsError {
  constructor(message?: string, cause?: Error) {
    super(
      message ?? `Chrome or Chromium binary not found. Install instructions: ${ChromeNotFoundError.installUrl()}`,
      "CHROME_NOT_FOUND",
      cause,
    );
    this.name = "ChromeNotFoundError";
  }

  static installUrl(platform: NodeJS.Platform = process.platform): string {
    if (platform === "darwin") {
      return "https://www.google.com/chrome/";
    }

    if (platform === "win32") {
      return "https://www.google.com/chrome/";
    }

    if (platform === "linux") {
      return "https://www.google.com/chrome/";
    }

    return "https://www.chromium.org/getting-involved/download-chromium/";
  }
}

export class BrowserNotRunningError extends ReinsError {
  constructor(message = "Browser is not running", cause?: Error) {
    super(message, "BROWSER_NOT_RUNNING", cause);
    this.name = "BrowserNotRunningError";
  }
}

export class ElementNotFoundError extends ReinsError {
  readonly ref: string;

  constructor(ref: string, message?: string, cause?: Error) {
    super(message ?? `Element not found for ref: ${ref}`, "ELEMENT_NOT_FOUND", cause);
    this.name = "ElementNotFoundError";
    this.ref = ref;
  }
}

export class WatcherError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "WATCHER_ERROR", cause);
    this.name = "WatcherError";
  }
}

export class WatcherLimitError extends ReinsError {
  constructor(message = "Watcher limit exceeded", cause?: Error) {
    super(message, "WATCHER_LIMIT_EXCEEDED", cause);
    this.name = "WatcherLimitError";
  }
}

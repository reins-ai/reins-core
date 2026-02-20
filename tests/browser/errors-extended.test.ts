import { describe, expect, it } from "bun:test";

import {
  BrowserError,
  CdpError,
  ElementNotFoundError,
  WatcherError,
  WatcherLimitError,
} from "../../src/browser/errors";

describe("WatcherError", () => {
  it("creates with message and correct code", () => {
    const error = new WatcherError("watcher failed");

    expect(error.message).toBe("watcher failed");
    expect(error.code).toBe("WATCHER_ERROR");
    expect(error.name).toBe("WatcherError");
    expect(error).toBeInstanceOf(Error);
  });

  it("creates with cause", () => {
    const cause = new Error("root cause");
    const error = new WatcherError("watcher failed", cause);

    expect(error.message).toBe("watcher failed");
    expect(error.cause).toBe(cause);
  });
});

describe("WatcherLimitError", () => {
  it("creates with default message", () => {
    const error = new WatcherLimitError();

    expect(error.message).toBe("Watcher limit exceeded");
    expect(error.code).toBe("WATCHER_LIMIT_EXCEEDED");
    expect(error.name).toBe("WatcherLimitError");
  });

  it("creates with custom message", () => {
    const error = new WatcherLimitError("max 5 watchers");

    expect(error.message).toBe("max 5 watchers");
    expect(error.code).toBe("WATCHER_LIMIT_EXCEEDED");
  });

  it("creates with cause", () => {
    const cause = new Error("underlying");
    const error = new WatcherLimitError("limit hit", cause);

    expect(error.cause).toBe(cause);
  });
});

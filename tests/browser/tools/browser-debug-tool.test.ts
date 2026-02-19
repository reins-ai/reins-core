import { describe, expect, it } from "bun:test";
import { BrowserDebugTool } from "../../../src/browser/tools/browser-debug-tool";
import { BrowserError } from "../../../src/browser/errors";
import type { ToolContext } from "../../../src/types";

class MockDebugBuffer {
  console = [{ level: "log", text: "hello", timestamp: 1000 }];
  errors = [{ message: "Error: oops", stack: undefined }];
  network = [
    { url: "https://example.com", method: "GET", status: 200, failed: false },
  ];

  getConsole() {
    return this.console;
  }

  getErrors() {
    return this.errors;
  }

  getNetwork() {
    return this.network;
  }

  getAll() {
    return {
      console: this.console,
      errors: this.errors,
      network: this.network,
    };
  }
}

class MockService {
  public ensureBrowserCalled = false;
  public shouldFail = false;

  async ensureBrowser() {
    this.ensureBrowserCalled = true;
    if (this.shouldFail) {
      throw new BrowserError("Browser not running");
    }
    return {};
  }
}

const context: ToolContext = {
  conversationId: "conv-1",
  userId: "user-1",
};

describe("BrowserDebugTool", () => {
  function setup(options?: { emptyBuffer?: boolean; serviceFails?: boolean }) {
    const buffer = new MockDebugBuffer();
    if (options?.emptyBuffer) {
      buffer.console = [];
      buffer.errors = [];
      buffer.network = [];
    }
    const service = new MockService();
    if (options?.serviceFails) {
      service.shouldFail = true;
    }
    const tool = new BrowserDebugTool(service as never, buffer as never);
    return { tool, buffer, service };
  }

  it("has correct tool definition", () => {
    const { tool } = setup();
    expect(tool.definition.name).toBe("browser_debug");
    expect(tool.definition.parameters.required).toEqual(["action"]);
    expect(tool.definition.parameters.properties.action.enum).toEqual([
      "console",
      "errors",
      "network",
      "all",
    ]);
  });

  describe("action: console", () => {
    it("returns console entries", async () => {
      const { tool } = setup();
      const result = await tool.execute({ action: "console" }, context);

      expect(result.error).toBeUndefined();
      const data = result.result as { action: string; entries: unknown[] };
      expect(data.action).toBe("console");
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0]).toEqual({
        level: "log",
        text: "hello",
        timestamp: 1000,
      });
    });
  });

  describe("action: errors", () => {
    it("returns error entries", async () => {
      const { tool } = setup();
      const result = await tool.execute({ action: "errors" }, context);

      expect(result.error).toBeUndefined();
      const data = result.result as { action: string; entries: unknown[] };
      expect(data.action).toBe("errors");
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0]).toEqual({
        message: "Error: oops",
        stack: undefined,
      });
    });
  });

  describe("action: network", () => {
    it("returns network entries", async () => {
      const { tool } = setup();
      const result = await tool.execute({ action: "network" }, context);

      expect(result.error).toBeUndefined();
      const data = result.result as { action: string; entries: unknown[] };
      expect(data.action).toBe("network");
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0]).toEqual({
        url: "https://example.com",
        method: "GET",
        status: 200,
        failed: false,
      });
    });
  });

  describe("action: all", () => {
    it("returns all three categories", async () => {
      const { tool } = setup();
      const result = await tool.execute({ action: "all" }, context);

      expect(result.error).toBeUndefined();
      const data = result.result as {
        action: string;
        console: unknown[];
        errors: unknown[];
        network: unknown[];
      };
      expect(data.action).toBe("all");
      expect(data.console).toHaveLength(1);
      expect(data.errors).toHaveLength(1);
      expect(data.network).toHaveLength(1);
    });
  });

  describe("invalid action", () => {
    it("returns error for missing action", async () => {
      const { tool } = setup();
      const result = await tool.execute({}, context);

      expect(result.error).toBeDefined();
      expect(result.result).toBeNull();
      expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
    });

    it("returns error for invalid action value", async () => {
      const { tool } = setup();
      const result = await tool.execute({ action: "invalid" }, context);

      expect(result.error).toBeDefined();
      expect(result.result).toBeNull();
    });
  });

  describe("empty buffers", () => {
    it("returns empty arrays when no events captured", async () => {
      const { tool } = setup({ emptyBuffer: true });

      const consoleResult = await tool.execute(
        { action: "console" },
        context,
      );
      const data = consoleResult.result as {
        action: string;
        entries: unknown[];
      };
      expect(data.entries).toHaveLength(0);
    });

    it("returns empty arrays for all action with no events", async () => {
      const { tool } = setup({ emptyBuffer: true });

      const result = await tool.execute({ action: "all" }, context);
      const data = result.result as {
        action: string;
        console: unknown[];
        errors: unknown[];
        network: unknown[];
      };
      expect(data.console).toHaveLength(0);
      expect(data.errors).toHaveLength(0);
      expect(data.network).toHaveLength(0);
    });
  });

  describe("ensureBrowser failure", () => {
    it("returns error when browser is not running", async () => {
      const { tool } = setup({ serviceFails: true });
      const result = await tool.execute({ action: "console" }, context);

      expect(result.error).toBeDefined();
      expect(result.result).toBeNull();
      expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
      expect(result.errorDetail?.message).toBe("Browser not running");
    });
  });

  describe("callId handling", () => {
    it("uses provided callId", async () => {
      const { tool } = setup();
      const result = await tool.execute(
        { action: "console", callId: "call-123" },
        context,
      );
      expect(result.callId).toBe("call-123");
    });

    it("defaults to unknown-call when callId missing", async () => {
      const { tool } = setup();
      const result = await tool.execute({ action: "console" }, context);
      expect(result.callId).toBe("unknown-call");
    });
  });
});

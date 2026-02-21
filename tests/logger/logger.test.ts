import { describe, expect, it } from "bun:test";

import { createLogger } from "../../src/logger";

describe("createLogger", () => {
  function createCollector(): { lines: string[]; write: (line: string) => void } {
    const lines: string[] = [];
    return {
      lines,
      write(line: string): void {
        lines.push(line);
      },
    };
  }

  it("returns logger methods for all levels", () => {
    const logger = createLogger("test");

    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("filters log output based on configured level", () => {
    const collector = createCollector();
    const logger = createLogger("test", {
      logLevel: "warn",
      write: collector.write,
    });

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    const output = collector.lines.join("");
    expect(output).not.toContain("debug message");
    expect(output).not.toContain("info message");
    expect(output).toContain("warn message");
    expect(output).toContain("error message");
  });

  it("includes module name in output", () => {
    const collector = createCollector();
    const logger = createLogger("daemon", { write: collector.write });

    logger.info("daemon started");

    expect(collector.lines.join("")).toContain("[daemon]");
  });

  it("emits parseable json lines when configured", () => {
    const collector = createCollector();
    const logger = createLogger("json-module", {
      logFormat: "json",
      write: collector.write,
    });

    logger.info("json log", { port: 7433 });

    const line = collector.lines.join("").trim();
    const parsed = JSON.parse(line) as {
      level: string;
      module: string;
      message: string;
      data: { port: number };
    };

    expect(parsed.level).toBe("info");
    expect(parsed.module).toBe("json-module");
    expect(parsed.message).toBe("json log");
    expect(parsed.data.port).toBe(7433);
  });

  it("falls back to info level for invalid REINS_LOG_LEVEL", () => {
    const collector = createCollector();
    const logger = createLogger("test", {
      logLevel: "verbose",
      write: collector.write,
    });

    logger.debug("should be filtered");
    logger.info("should be logged");

    const output = collector.lines.join("");
    expect(output).not.toContain("should be filtered");
    expect(output).toContain("should be logged");
  });

  it("includes data object fields in both dev and json formats", () => {
    const devCollector = createCollector();
    const logger = createLogger("data-test", { write: devCollector.write });

    logger.info("dev message", { provider: "anthropic", port: 7433 });
    const devOutput = devCollector.lines.join("");
    expect(devOutput).toContain("provider=anthropic");
    expect(devOutput).toContain("port=7433");

    const jsonCollector = createCollector();
    const jsonLogger = createLogger("data-test", {
      logFormat: "json",
      write: jsonCollector.write,
    });

    jsonLogger.info("json message", { provider: "anthropic", port: 7433 });
    const jsonLine = jsonCollector.lines.join("").trim();
    const parsed = JSON.parse(jsonLine) as { data: { provider: string; port: number } };

    expect(parsed.data.provider).toBe("anthropic");
    expect(parsed.data.port).toBe(7433);
  });
});

import type { LogEntry, Logger, LogLevel } from "./types";

type LogFormat = "json" | "dev";

interface LoggerRuntimeOptions {
  logLevel?: string;
  logFormat?: string;
  nodeEnv?: string;
  write?: (line: string) => void;
  now?: () => Date;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) {
    return "info";
  }

  return LOG_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : "info";
}

function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[threshold];
}

function parseLogFormat(value: string | undefined, nodeEnv: string | undefined): LogFormat {
  if (value === "json" || nodeEnv === "production") {
    return "json";
  }

  return "dev";
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

function normalizeData(data: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    normalized[key] = normalizeValue(value);
  }

  return normalized;
}

function formatValue(value: unknown): string {
  const normalized = normalizeValue(value);

  if (typeof normalized === "string") {
    return normalized.includes(" ") ? JSON.stringify(normalized) : normalized;
  }

  if (typeof normalized === "number" || typeof normalized === "boolean") {
    return String(normalized);
  }

  return JSON.stringify(normalized);
}

function formatData(data: Record<string, unknown> | undefined): string {
  if (data === undefined) {
    return "";
  }

  const pairs = Object.entries(data).map(([key, value]) => `${key}=${formatValue(value)}`);
  return pairs.length > 0 ? ` ${pairs.join(" ")}` : "";
}

export function formatLogEntry(entry: LogEntry, format: LogFormat): string {
  if (format === "json") {
    const payload: LogEntry = entry.data === undefined ? entry : { ...entry, data: normalizeData(entry.data) };
    return JSON.stringify(payload);
  }

  const level = entry.level.toUpperCase().padEnd(5, " ");
  return `${entry.timestamp} [${level}] [${entry.module}] ${entry.message}${formatData(entry.data)}`;
}

function emitLog(entry: LogEntry, options: LoggerRuntimeOptions): void {
  const threshold = parseLogLevel(options.logLevel ?? process.env.REINS_LOG_LEVEL);
  if (!shouldLog(entry.level, threshold)) {
    return;
  }

  const format = parseLogFormat(options.logFormat ?? process.env.REINS_LOG_FORMAT, options.nodeEnv ?? process.env.NODE_ENV);
  const writeLine = options.write ?? ((line: string) => process.stderr.write(line));
  writeLine(`${formatLogEntry(entry, format)}\n`);
}

export function createLogger(module: string, options: LoggerRuntimeOptions = {}): Logger {
  const now = options.now ?? (() => new Date());

  function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    emitLog({
      timestamp: now().toISOString(),
      level,
      module,
      message,
      data,
    }, options);
  }

  return {
    debug(message: string, data?: Record<string, unknown>): void {
      log("debug", message, data);
    },
    info(message: string, data?: Record<string, unknown>): void {
      log("info", message, data);
    },
    warn(message: string, data?: Record<string, unknown>): void {
      log("warn", message, data);
    },
    error(message: string, data?: Record<string, unknown>): void {
      log("error", message, data);
    },
  };
}

export type { Logger, LogLevel, LogEntry } from "./types";

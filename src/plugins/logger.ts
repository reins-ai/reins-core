import type { PluginLogger } from "../types";

export interface LogOutput {
  write(level: string, pluginName: string, message: string, args: unknown[]): void;
}

export interface LogEntry {
  level: string;
  pluginName: string;
  message: string;
  args: unknown[];
}

export class ScopedPluginLogger implements PluginLogger {
  constructor(
    private readonly pluginName: string,
    private readonly output: LogOutput,
  ) {}

  info(message: string, ...args: unknown[]): void {
    this.output.write("info", this.pluginName, message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.output.write("warn", this.pluginName, message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.output.write("error", this.pluginName, message, args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.output.write("debug", this.pluginName, message, args);
  }
}

export class InMemoryLogOutput implements LogOutput {
  private readonly entries: LogEntry[] = [];

  write(level: string, pluginName: string, message: string, args: unknown[]): void {
    this.entries.push({
      level,
      pluginName,
      message,
      args: structuredClone(args),
    });
  }

  getEntries(): LogEntry[] {
    return structuredClone(this.entries);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

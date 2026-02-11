import { constants } from "node:fs";
import { access, appendFile, mkdir, open, readFile, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getTranscriptsDir, type DaemonPathOptions } from "../daemon/paths";
import { ConversationError } from "../errors";
import { err, ok, type Result } from "../result";
import type { TranscriptEntry } from "./transcript-types";

export interface TranscriptStoreOptions {
  transcriptsDir?: string;
  daemonPathOptions?: DaemonPathOptions;
}

type TranscriptStoreResult<T> = Result<T, ConversationError>;

export class TranscriptStore {
  private readonly transcriptsDir: string;
  private readonly syncHandles = new Map<string, FileHandle>();

  constructor(options: TranscriptStoreOptions = {}) {
    this.transcriptsDir = options.transcriptsDir ?? getTranscriptsDir(options.daemonPathOptions);
  }

  getPath(sessionId: string): string {
    return join(this.transcriptsDir, `${sessionId}.jsonl`);
  }

  async exists(sessionId: string): Promise<TranscriptStoreResult<boolean>> {
    const pathResult = this.resolvePath(sessionId);
    if (!pathResult.ok) {
      return pathResult;
    }

    try {
      await access(pathResult.value, constants.F_OK);
      return ok(true);
    } catch {
      return ok(false);
    }
  }

  async append(sessionId: string, entry: TranscriptEntry): Promise<TranscriptStoreResult<void>> {
    return this.appendBatch(sessionId, [entry]);
  }

  async appendBatch(sessionId: string, entries: TranscriptEntry[]): Promise<TranscriptStoreResult<void>> {
    if (entries.length === 0) {
      return ok(undefined);
    }

    const pathResult = this.resolvePath(sessionId);
    if (!pathResult.ok) {
      return pathResult;
    }

    try {
      await mkdir(dirname(pathResult.value), { recursive: true });
      const payload = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
      await appendFile(pathResult.value, payload, "utf8");
      return ok(undefined);
    } catch (cause) {
      return err(this.asConversationError("Failed to append transcript entries", cause));
    }
  }

  async read(sessionId: string): Promise<TranscriptStoreResult<TranscriptEntry[]>> {
    const pathResult = this.resolvePath(sessionId);
    if (!pathResult.ok) {
      return pathResult;
    }

    try {
      const fileExists = await this.existsByPath(pathResult.value);
      if (!fileExists) {
        return ok([]);
      }

      const content = await readFile(pathResult.value, "utf8");
      return this.parseLines(content, pathResult.value);
    } catch (cause) {
      return err(this.asConversationError("Failed to read transcript entries", cause));
    }
  }

  async readTail(sessionId: string, count: number): Promise<TranscriptStoreResult<TranscriptEntry[]>> {
    if (count <= 0) {
      return ok([]);
    }

    const readResult = await this.read(sessionId);
    if (!readResult.ok) {
      return readResult;
    }

    if (readResult.value.length <= count) {
      return readResult;
    }

    return ok(readResult.value.slice(-count));
  }

  async sync(sessionId: string): Promise<TranscriptStoreResult<void>> {
    const pathResult = this.resolvePath(sessionId);
    if (!pathResult.ok) {
      return pathResult;
    }

    try {
      await mkdir(dirname(pathResult.value), { recursive: true });
      const handle = await this.getSyncHandle(pathResult.value);
      await handle.sync();
      return ok(undefined);
    } catch (cause) {
      return err(this.asConversationError("Failed to sync transcript file", cause));
    }
  }

  async repair(sessionId: string): Promise<TranscriptStoreResult<boolean>> {
    const pathResult = this.resolvePath(sessionId);
    if (!pathResult.ok) {
      return pathResult;
    }

    try {
      const fileExists = await this.existsByPath(pathResult.value);
      if (!fileExists) {
        return ok(false);
      }

      const originalContent = await readFile(pathResult.value, "utf8");
      if (originalContent.length === 0) {
        return ok(false);
      }

      const repairPlan = this.createRepairPlan(originalContent);
      if (!repairPlan.changed) {
        return ok(false);
      }

      await writeFile(pathResult.value, repairPlan.content, "utf8");
      return ok(true);
    } catch (cause) {
      return err(this.asConversationError("Failed to repair transcript file", cause));
    }
  }

  private resolvePath(sessionId: string): TranscriptStoreResult<string> {
    if (!isValidSessionId(sessionId)) {
      return err(new ConversationError(`Invalid session id for transcript path: ${sessionId}`));
    }

    return ok(this.getPath(sessionId));
  }

  private async existsByPath(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private parseLines(content: string, path: string): TranscriptStoreResult<TranscriptEntry[]> {
    const lines = content.split("\n").filter((line) => line.length > 0);
    const entries: TranscriptEntry[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const parsedResult = this.parseLine(line, index + 1, path);
      if (!parsedResult.ok) {
        return parsedResult;
      }

      entries.push(parsedResult.value);
    }

    return ok(entries);
  }

  private parseLine(line: string, lineNumber: number, path: string): TranscriptStoreResult<TranscriptEntry> {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isTranscriptEntry(parsed)) {
        return err(
          new ConversationError(
            `Transcript entry is invalid at ${path}:${lineNumber}`,
          ),
        );
      }

      return ok(parsed);
    } catch (cause) {
      return err(
        this.asConversationError(
          `Failed to parse transcript JSON at ${path}:${lineNumber}`,
          cause,
        ),
      );
    }
  }

  private createRepairPlan(content: string): { content: string; changed: boolean } {
    const endsWithNewline = content.endsWith("\n");
    const segments = content.split("\n");
    const completeLines = segments.slice(0, -1);
    const trailingSegment = segments[segments.length - 1] ?? "";
    const candidateLines = [...completeLines];

    let changed = false;

    if (!endsWithNewline && trailingSegment.length > 0) {
      try {
        const parsed = JSON.parse(trailingSegment) as unknown;
        if (isTranscriptEntry(parsed)) {
          candidateLines.push(trailingSegment);
          changed = true;
        } else {
          changed = true;
        }
      } catch {
        changed = true;
      }
    }

    let lastValidIndex = candidateLines.length;

    for (let index = 0; index < candidateLines.length; index += 1) {
      const line = candidateLines[index];
      if (line.length === 0) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isTranscriptEntry(parsed)) {
          lastValidIndex = index;
          break;
        }
      } catch {
        lastValidIndex = index;
        break;
      }
    }

    const hasInvalidTail = lastValidIndex < candidateLines.length;
    changed = changed || hasInvalidTail;

    if (!changed) {
      return { content, changed: false };
    }

    const repairedLines = candidateLines.slice(0, lastValidIndex).filter((line) => line.length > 0);
    const repairedContent = repairedLines.length > 0 ? `${repairedLines.join("\n")}\n` : "";
    return { content: repairedContent, changed: true };
  }

  private async getSyncHandle(path: string): Promise<FileHandle> {
    const existing = this.syncHandles.get(path);
    if (existing) {
      return existing;
    }

    const handle = await open(path, "a+");
    this.syncHandles.set(path, handle);
    return handle;
  }

  private asConversationError(message: string, cause: unknown): ConversationError {
    if (cause instanceof ConversationError) {
      return cause;
    }

    return new ConversationError(message, cause instanceof Error ? cause : undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasTimestamp(value: Record<string, unknown>): boolean {
  return isString(value.timestamp);
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (!isRecord(value) || !isString(value.type) || !hasTimestamp(value)) {
    return false;
  }

  switch (value.type) {
    case "message":
      return (
        (value.role === "user" || value.role === "assistant" || value.role === "system") &&
        isString(value.content) &&
        isString(value.messageId)
      );
    case "tool_call":
      return isString(value.toolName) && isString(value.toolCallId);
    case "tool_result":
      return isString(value.toolCallId) && typeof value.isError === "boolean";
    case "token":
      return isString(value.content);
    case "turn_start":
      return isString(value.turnId) && isString(value.model) && isString(value.provider);
    case "turn_end":
      return (
        isString(value.turnId) &&
        isNumber(value.inputTokens) &&
        isNumber(value.outputTokens) &&
        isNumber(value.durationMs)
      );
    case "compaction":
      return isString(value.summary) && isNumber(value.messagesCompacted);
    case "memory_flush":
      return isNumber(value.memoriesCount);
    case "session_start":
      return isString(value.sessionId);
    case "error":
      return isString(value.code) && isString(value.message);
    default:
      return false;
  }
}

function isValidSessionId(sessionId: string): boolean {
  if (sessionId.trim().length === 0) {
    return false;
  }

  if (sessionId.includes("/")) {
    return false;
  }

  if (sessionId.includes("\\")) {
    return false;
  }

  return !sessionId.includes("..");
}

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { generateId } from "../../conversation/id";
import type { Conversation, Message, MessageRole } from "../../conversation/types";
import type { MapError, MapperOptions, MapResult } from "./types";

/**
 * Shape of a single line in an OpenClaw JSONL session transcript.
 */
export interface OpenClawSessionLine {
  id?: string;
  sessionId?: string;
  timestamp?: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationMapperOptions {
  outputDir?: string;
  batchSize?: number;
}

/**
 * Filesystem abstraction for testability.
 */
export interface ConversationMapperFileOps {
  readFileText(path: string): Promise<string>;
  writeJson(path: string, data: unknown): Promise<void>;
  exists(path: string): Promise<boolean>;
}

const defaultFileOps: ConversationMapperFileOps = {
  async readFileText(path: string): Promise<string> {
    const file = Bun.file(path);
    return file.text();
  },
  async writeJson(path: string, data: unknown): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, JSON.stringify(data, null, 2));
  },
  async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
  },
};

function defaultOutputDir(): string {
  return join(homedir(), ".reins", "conversations");
}

const VALID_ROLES = new Set<string>(["user", "assistant", "system"]);

const DEFAULT_BATCH_SIZE = 100;

/**
 * Parses a single JSONL line into an OpenClawSessionLine.
 * Returns null if the line is malformed or missing required fields.
 */
function parseLine(line: string): OpenClawSessionLine | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const role = parsed.role;
    if (typeof role !== "string" || !VALID_ROLES.has(role)) {
      return null;
    }

    const content = parsed.content;
    if (typeof content !== "string") {
      return null;
    }

    return {
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
      role: role as OpenClawSessionLine["role"],
      content,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      agentId: typeof parsed.agentId === "string" ? parsed.agentId : undefined,
      metadata: typeof parsed.metadata === "object" && parsed.metadata !== null
        ? parsed.metadata as Record<string, unknown>
        : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Derives a session key from a parsed line.
 * Falls back to a provided file-level key when no sessionId is present.
 */
function sessionKeyFor(line: OpenClawSessionLine, fileKey: string): string {
  return line.sessionId ?? fileKey;
}

/**
 * Converts a group of OpenClaw session lines into a Reins Conversation.
 */
function buildConversation(
  sessionId: string,
  lines: OpenClawSessionLine[],
): Conversation {
  const now = new Date();

  const messages: Message[] = lines.map((line) => ({
    id: line.id ?? generateId("msg"),
    role: line.role as MessageRole,
    content: line.content,
    createdAt: line.timestamp ? new Date(line.timestamp) : now,
    metadata: line.metadata,
  }));

  const firstTimestamp = lines[0]?.timestamp
    ? new Date(lines[0].timestamp)
    : now;
  const lastLineTimestamp = lines[lines.length - 1]?.timestamp;
  const lastTimestamp = lastLineTimestamp
    ? new Date(lastLineTimestamp)
    : now;

  const model = lines.find((l) => l.model)?.model ?? "unknown";
  const agentId = lines.find((l) => l.agentId)?.agentId;

  return {
    id: sessionId,
    title: `Imported session ${sessionId}`,
    messages,
    model,
    provider: "openclaw-import",
    personaId: agentId,
    createdAt: firstTimestamp,
    updatedAt: lastTimestamp,
    metadata: { source: "openclaw-import" },
  };
}

/**
 * Maps OpenClaw JSONL session transcripts to Reins conversation format.
 *
 * Processes files line-by-line in batches to avoid memory exhaustion on
 * large session histories. Groups messages by sessionId (or by file when
 * no sessionId is present) and writes each conversation as a JSON file.
 */
export class ConversationMapper {
  private readonly outputDir: string;
  private readonly fileOps: ConversationMapperFileOps;
  private readonly batchSize: number;

  constructor(options?: ConversationMapperOptions, fileOps?: ConversationMapperFileOps) {
    this.outputDir = options?.outputDir ?? defaultOutputDir();
    this.batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
    this.fileOps = fileOps ?? defaultFileOps;
  }

  async map(
    sessionPaths: string[],
    options?: MapperOptions,
  ): Promise<MapResult> {
    const errors: MapError[] = [];
    let converted = 0;
    let skipped = 0;

    for (const filePath of sessionPaths) {
      const fileResult = await this.processFile(filePath, options);
      converted += fileResult.converted;
      skipped += fileResult.skipped;
      errors.push(...fileResult.errors);
    }

    return { converted, skipped, errors };
  }

  private async processFile(
    filePath: string,
    options?: MapperOptions,
  ): Promise<MapResult> {
    const errors: MapError[] = [];
    let converted = 0;
    let skipped = 0;

    let text: string;
    try {
      text = await this.fileOps.readFileText(filePath);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      errors.push({ item: filePath, reason: `Failed to read file: ${reason}` });
      return { converted: 0, skipped: 0, errors };
    }

    const rawLines = text.split("\n");
    const nonEmptyLines: string[] = [];
    for (const line of rawLines) {
      if (line.trim().length > 0) {
        nonEmptyLines.push(line);
      }
    }

    if (nonEmptyLines.length === 0) {
      skipped++;
      return { converted, skipped, errors };
    }

    const totalLines = nonEmptyLines.length;
    const fileKey = this.fileKeyFromPath(filePath);

    // Group lines by session, processing in batches for progress reporting
    const sessions = new Map<string, OpenClawSessionLine[]>();
    let processedCount = 0;

    for (let i = 0; i < totalLines; i += this.batchSize) {
      const batchEnd = Math.min(i + this.batchSize, totalLines);
      const batch = nonEmptyLines.slice(i, batchEnd);

      for (const rawLine of batch) {
        const parsed = parseLine(rawLine);
        if (!parsed) {
          errors.push({
            item: `${filePath}:line ${i + batch.indexOf(rawLine) + 1}`,
            reason: "Malformed JSONL line",
          });
          continue;
        }

        const key = sessionKeyFor(parsed, fileKey);
        let group = sessions.get(key);
        if (!group) {
          group = [];
          sessions.set(key, group);
        }
        group.push(parsed);
      }

      processedCount = batchEnd;
      options?.onProgress?.(processedCount, totalLines);
    }

    // Build and write conversations from grouped sessions
    for (const [sessionId, lines] of sessions) {
      if (lines.length === 0) {
        skipped++;
        continue;
      }

      const conversation = buildConversation(sessionId, lines);

      if (options?.dryRun) {
        converted++;
        continue;
      }

      const outPath = join(this.outputDir, `${sessionId}.json`);
      try {
        await this.fileOps.writeJson(outPath, conversation);
        converted++;
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        errors.push({
          item: sessionId,
          reason: `Failed to write conversation: ${reason}`,
        });
      }
    }

    return { converted, skipped, errors };
  }

  /**
   * Derives a stable file-level key from a file path for sessions
   * that lack an explicit sessionId field.
   */
  private fileKeyFromPath(filePath: string): string {
    const base = filePath.split("/").pop() ?? filePath;
    return base.replace(/\.jsonl$/i, "");
  }
}

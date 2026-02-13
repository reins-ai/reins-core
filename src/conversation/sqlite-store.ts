import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import { ConversationError } from "../errors";
import { err, ok } from "../result";
import { deserializeContent, getTextContent, type ContentBlock, type Conversation, type ConversationSummary, type Message, type MessageRole } from "../types";
import type { ConversationStore, ConversationStoreResult, ListOptions } from "./store";

const CURRENT_SCHEMA_VERSION = 2;

interface SchemaVersionRow {
  version: number | null;
}

interface ConversationRow {
  id: string;
  title: string;
  provider: string;
  model: string;
  persona_id: string | null;
  workspace_id: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  role: MessageRole;
  content: string;
  content_blocks: string | null;
  provider: string | null;
  model: string | null;
  tool_calls_json: string | null;
  metadata_json: string | null;
  created_at: string;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface ConversationSummaryRow {
  id: string;
  title: string;
  model: string;
  provider: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message_at: string;
}

export interface SQLiteConversationStoreOptions {
  path?: string;
  now?: () => Date;
}

function isInMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}

function resolveDefaultDbPath(): string {
  return join(process.cwd(), ".reins", "conversation.db");
}

export class SQLiteConversationStore implements ConversationStore {
  public readonly path: string;
  private readonly connection: Database;
  private readonly now: () => Date;

  constructor(options: SQLiteConversationStoreOptions = {}) {
    this.path = options.path ?? resolveDefaultDbPath();
    this.now = options.now ?? (() => new Date());

    if (!isInMemoryPath(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true });
    }

    this.connection = new Database(this.path, { create: true });
    this.connection.exec("PRAGMA journal_mode=WAL");
    this.connection.exec("PRAGMA foreign_keys=ON");

    this.initializeSchema();
  }

  close(): void {
    this.connection.close();
  }

  async save(conversation: Conversation): Promise<ConversationStoreResult<void>> {
    try {
      this.connection.exec("BEGIN IMMEDIATE");

      this.connection
        .query(
          `
            INSERT INTO conversations (
              id,
              title,
              provider,
              model,
              persona_id,
              workspace_id,
              metadata_json,
              created_at,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              provider = excluded.provider,
              model = excluded.model,
              persona_id = excluded.persona_id,
              workspace_id = excluded.workspace_id,
              metadata_json = excluded.metadata_json,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          conversation.id,
          conversation.title,
          conversation.provider,
          conversation.model,
          conversation.personaId ?? null,
          conversation.workspaceId ?? null,
          conversation.metadata ? JSON.stringify(conversation.metadata) : null,
          conversation.createdAt.toISOString(),
          conversation.updatedAt.toISOString(),
        );

      this.connection.query("DELETE FROM messages WHERE conversation_id = ?1").run(conversation.id);

      const insertMessage = this.connection.query(
        `
          INSERT INTO messages (
            id,
            conversation_id,
            role,
            content,
            content_blocks,
            provider,
            model,
            tool_calls_json,
            metadata_json,
            created_at,
            completed_at,
            error_code,
            error_message
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        `,
      );

      for (const message of conversation.messages) {
        const metadata = message.metadata as Record<string, unknown> | undefined;
        const provider = typeof metadata?.provider === "string" ? metadata.provider : null;
        const model = typeof metadata?.model === "string" ? metadata.model : null;
        const completedAt = typeof metadata?.completedAt === "string" ? metadata.completedAt : null;
        const errorCode = typeof metadata?.errorCode === "string" ? metadata.errorCode : null;
        const errorMessage =
          typeof metadata?.errorMessage === "string" ? metadata.errorMessage : null;

        const contentText = getTextContent(message.content);
        const contentBlocks = Array.isArray(message.content)
          ? JSON.stringify(message.content)
          : null;

        insertMessage.run(
          message.id,
          conversation.id,
          message.role,
          contentText,
          contentBlocks,
          provider,
          model,
          message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          message.metadata ? JSON.stringify(message.metadata) : null,
          message.createdAt.toISOString(),
          completedAt,
          errorCode,
          errorMessage,
        );
      }

      this.connection.exec("COMMIT");
      return ok(undefined);
    } catch (cause) {
      this.safeRollback();
      return err(this.asConversationError("Failed to save conversation", cause));
    }
  }

  async load(id: string): Promise<ConversationStoreResult<Conversation | null>> {
    try {
      const row = this.connection
        .query(
          `
            SELECT
              id,
              title,
              provider,
              model,
              persona_id,
              workspace_id,
              metadata_json,
              created_at,
              updated_at
            FROM conversations
            WHERE id = ?1
          `,
        )
        .get(id) as ConversationRow | null;

      if (!row) {
        return ok(null);
      }

      const metadataResult = this.parseJson<Record<string, unknown>>(row.metadata_json);
      if (!metadataResult.ok) {
        return metadataResult;
      }

      const messageRows = this.connection
        .query(
          `
            SELECT
              id,
              role,
              content,
              content_blocks,
              provider,
              model,
              tool_calls_json,
              metadata_json,
              created_at,
              completed_at,
              error_code,
              error_message
            FROM messages
            WHERE conversation_id = ?1
            ORDER BY created_at ASC, id ASC
          `,
        )
        .all(id) as MessageRow[];

      const messages: Message[] = [];
      for (const messageRow of messageRows) {
        const toolCallsResult = this.parseJson<Message["toolCalls"]>(messageRow.tool_calls_json);
        if (!toolCallsResult.ok) {
          return toolCallsResult;
        }

        const messageMetadataResult = this.parseJson<Record<string, unknown>>(messageRow.metadata_json);
        if (!messageMetadataResult.ok) {
          return messageMetadataResult;
        }

        const metadata: Record<string, unknown> = {
          ...(messageMetadataResult.value ?? {}),
        };

        if (messageRow.provider) {
          metadata.provider = messageRow.provider;
        }

        if (messageRow.model) {
          metadata.model = messageRow.model;
        }

        if (messageRow.completed_at) {
          metadata.completedAt = messageRow.completed_at;
        }

        if (messageRow.error_code) {
          metadata.errorCode = messageRow.error_code;
        }

        if (messageRow.error_message) {
          metadata.errorMessage = messageRow.error_message;
        }

        const content = this.deserializeMessageContent(messageRow);

        messages.push({
          id: messageRow.id,
          role: messageRow.role,
          content,
          toolCalls: toolCallsResult.value,
          createdAt: new Date(messageRow.created_at),
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
      }

      return ok({
        id: row.id,
        title: row.title,
        messages,
        model: row.model,
        provider: row.provider,
        personaId: row.persona_id ?? undefined,
        workspaceId: row.workspace_id ?? undefined,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        metadata: metadataResult.value,
      });
    } catch (cause) {
      return err(this.asConversationError("Failed to load conversation", cause));
    }
  }

  async list(options?: ListOptions): Promise<ConversationStoreResult<ConversationSummary[]>> {
    try {
      const orderBy = options?.orderBy === "created" ? "c.created_at" : "c.updated_at";
      const offset = Math.max(0, options?.offset ?? 0);
      const limit = typeof options?.limit === "number" ? Math.max(0, options.limit) : -1;

      const rows = this.connection
        .query(
          `
            SELECT
              c.id,
              c.title,
              c.model,
              c.provider,
              c.created_at,
              c.updated_at,
              COUNT(m.id) AS message_count,
              COALESCE(MAX(m.created_at), c.updated_at) AS last_message_at
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            WHERE (?1 IS NULL OR c.workspace_id = ?1)
            GROUP BY c.id
            ORDER BY ${orderBy} DESC
            LIMIT ?2 OFFSET ?3
          `,
        )
        .all(options?.workspaceId ?? null, limit, offset) as ConversationSummaryRow[];

      return ok(
        rows.map((row) => ({
          id: row.id,
          title: row.title,
          model: row.model,
          provider: row.provider,
          messageCount: row.message_count,
          lastMessageAt: new Date(row.last_message_at),
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        })),
      );
    } catch (cause) {
      return err(this.asConversationError("Failed to list conversations", cause));
    }
  }

  async delete(id: string): Promise<ConversationStoreResult<boolean>> {
    try {
      const result = this.connection.query("DELETE FROM conversations WHERE id = ?1").run(id);
      return ok(result.changes > 0);
    } catch (cause) {
      return err(this.asConversationError("Failed to delete conversation", cause));
    }
  }

  async exists(id: string): Promise<ConversationStoreResult<boolean>> {
    try {
      const row = this.connection
        .query("SELECT 1 AS exists_flag FROM conversations WHERE id = ?1 LIMIT 1")
        .get(id) as { exists_flag: number } | null;

      return ok(Boolean(row));
    } catch (cause) {
      return err(this.asConversationError("Failed to check conversation existence", cause));
    }
  }

  async updateTitle(id: string, title: string): Promise<ConversationStoreResult<void>> {
    try {
      this.connection
        .query("UPDATE conversations SET title = ?2, updated_at = ?3 WHERE id = ?1")
        .run(id, title, this.now().toISOString());

      return ok(undefined);
    } catch (cause) {
      return err(this.asConversationError("Failed to update conversation title", cause));
    }
  }

  private initializeSchema(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const row = this.connection
      .query("SELECT MAX(version) AS version FROM schema_version")
      .get() as SchemaVersionRow | null;
    const currentVersion = row?.version ?? 0;

    if (currentVersion >= CURRENT_SCHEMA_VERSION) {
      return;
    }

    this.connection.exec("BEGIN IMMEDIATE");

    try {
      if (currentVersion < 1) {
        this.connection.exec(`
          CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            persona_id TEXT,
            workspace_id TEXT,
            metadata_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
            content TEXT NOT NULL,
            content_blocks TEXT,
            provider TEXT,
            model TEXT,
            tool_calls_json TEXT,
            metadata_json TEXT,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            error_code TEXT,
            error_message TEXT,
            FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
            ON messages(conversation_id, created_at, id);

          CREATE INDEX IF NOT EXISTS idx_conversations_updated
            ON conversations(updated_at DESC);

          INSERT INTO schema_version(version, applied_at)
          VALUES (1, '${this.now().toISOString()}');
        `);
      }

      if (currentVersion < 2) {
        if (currentVersion >= 1) {
          this.connection.exec("ALTER TABLE messages ADD COLUMN content_blocks TEXT");
        }

        this.connection.exec(`
          INSERT INTO schema_version(version, applied_at)
          VALUES (2, '${this.now().toISOString()}');
        `);
      }

      this.connection.exec("COMMIT");
    } catch (error) {
      this.safeRollback();
      throw error;
    }
  }

  private deserializeMessageContent(row: MessageRow): string | ContentBlock[] {
    if (row.content_blocks) {
      try {
        return JSON.parse(row.content_blocks) as ContentBlock[];
      } catch {
        // Corrupted content_blocks — fall through to content column
      }
    }

    return deserializeContent(row.content);
  }

  private parseJson<T>(value: string | null): ConversationStoreResult<T | undefined> {
    if (value === null) {
      return ok(undefined);
    }

    try {
      return ok(JSON.parse(value) as T);
    } catch (cause) {
      return err(this.asConversationError("Failed to parse persisted JSON payload", cause));
    }
  }

  private safeRollback(): void {
    try {
      this.connection.exec("ROLLBACK");
    } catch {
      // no-op
    }
  }

  private asConversationError(message: string, cause: unknown): ConversationError {
    return new ConversationError(message, cause instanceof Error ? cause : undefined);
  }
}

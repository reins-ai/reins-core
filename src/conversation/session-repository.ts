import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { ConversationError } from "../errors";
import { getSessionsDir, type DaemonPathOptions } from "../daemon/paths";
import { err, ok, type Result } from "../result";
import { generateId } from "./id";

export type SessionStatus = "active" | "archived" | "compacting";

export interface SessionMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  provider: string;
  messageCount: number;
  tokenCount: number;
  isMain: boolean;
  status: SessionStatus;
  lastCompactedAt?: string;
  transcriptPath: string;
  parentSessionId?: string;
  forkTurnIndex?: number;
}

interface SessionFileSchema {
  version: 1;
  mainSessionId: string;
  sessions: Record<string, SessionMetadata>;
}

interface SessionState {
  mainSessionId: string;
  sessions: Map<string, SessionMetadata>;
}

export interface SessionCreateOptions {
  title?: string;
  model: string;
  provider: string;
  messageCount?: number;
  tokenCount?: number;
  status?: SessionStatus;
  setAsMain?: boolean;
  transcriptPath?: string;
  parentSessionId?: string;
  forkTurnIndex?: number;
}

export interface SessionNewOptions {
  title?: string;
  model: string;
  provider: string;
  messageCount?: number;
  tokenCount?: number;
  transcriptPath?: string;
}

export interface SessionRepositoryOptions {
  sessionsDir?: string;
  daemonPathOptions?: DaemonPathOptions;
  defaultTitle?: string;
  defaultModel?: string;
  defaultProvider?: string;
}

type SessionResult<T> = Result<T, ConversationError>;

export class SessionRepository {
  private readonly sessionsDir: string;
  private readonly sessionsFilePath: string;
  private readonly defaultTitle: string;
  private readonly defaultModel: string;
  private readonly defaultProvider: string;

  constructor(options: SessionRepositoryOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? getSessionsDir(options.daemonPathOptions);
    this.sessionsFilePath = join(this.sessionsDir, "sessions.json");
    this.defaultTitle = options.defaultTitle ?? "Main Session";
    this.defaultModel = options.defaultModel ?? "unknown-model";
    this.defaultProvider = options.defaultProvider ?? "unknown-provider";
  }

  async getMain(): Promise<SessionResult<SessionMetadata>> {
    const stateResult = await this.loadState();
    if (!stateResult.ok) {
      return stateResult;
    }

    const state = stateResult.value;
    const main = state.sessions.get(state.mainSessionId);
    if (!main) {
      return err(new ConversationError("Main session metadata is missing"));
    }

    return ok(structuredClone(main));
  }

  async get(id: string): Promise<SessionResult<SessionMetadata | null>> {
    const stateResult = await this.loadState();
    if (!stateResult.ok) {
      return stateResult;
    }

    const session = stateResult.value.sessions.get(id);
    return ok(session ? structuredClone(session) : null);
  }

  async create(options: SessionCreateOptions): Promise<SessionResult<SessionMetadata>> {
    const stateResult = await this.loadState();
    if (!stateResult.ok) {
      return stateResult;
    }

    const state = stateResult.value;
    const now = new Date().toISOString();
    const id = generateId("sess");
    const title = options.title?.trim() || "New Session";
    const shouldBeMain = options.setAsMain === true || state.sessions.size === 0;

    if (shouldBeMain) {
      for (const existing of state.sessions.values()) {
        existing.isMain = false;
      }
      state.mainSessionId = id;
    }

    const session: SessionMetadata = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      model: options.model,
      provider: options.provider,
      messageCount: options.messageCount ?? 0,
      tokenCount: options.tokenCount ?? 0,
      isMain: shouldBeMain,
      status: options.status ?? "active",
      transcriptPath: options.transcriptPath ?? this.defaultTranscriptPath(id),
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.forkTurnIndex !== undefined ? { forkTurnIndex: options.forkTurnIndex } : {}),
    };

    state.sessions.set(id, session);

    const persistResult = await this.persistState(state);
    if (!persistResult.ok) {
      return persistResult;
    }

    return ok(structuredClone(session));
  }

  async update(
    id: string,
    updates: Partial<Omit<SessionMetadata, "id" | "createdAt" | "isMain">>,
  ): Promise<SessionResult<SessionMetadata>> {
    const stateResult = await this.loadState();
    if (!stateResult.ok) {
      return stateResult;
    }

    const state = stateResult.value;
    const session = state.sessions.get(id);
    if (!session) {
      return err(new ConversationError(`Session not found: ${id}`));
    }

    const normalizedTitle = updates.title?.trim();
    if (updates.title !== undefined && !normalizedTitle) {
      return err(new ConversationError("Session title cannot be empty"));
    }

    const updated: SessionMetadata = {
      ...session,
      title: normalizedTitle ?? session.title,
      updatedAt: new Date().toISOString(),
      model: updates.model ?? session.model,
      provider: updates.provider ?? session.provider,
      messageCount: updates.messageCount ?? session.messageCount,
      tokenCount: updates.tokenCount ?? session.tokenCount,
      status: updates.status ?? session.status,
      lastCompactedAt: updates.lastCompactedAt ?? session.lastCompactedAt,
      transcriptPath: updates.transcriptPath ?? session.transcriptPath,
      parentSessionId: updates.parentSessionId ?? session.parentSessionId,
      forkTurnIndex: updates.forkTurnIndex ?? session.forkTurnIndex,
    };

    state.sessions.set(id, updated);

    const persistResult = await this.persistState(state);
    if (!persistResult.ok) {
      return persistResult;
    }

    return ok(structuredClone(updated));
  }

  async list(): Promise<SessionResult<SessionMetadata[]>> {
    const stateResult = await this.loadState();
    if (!stateResult.ok) {
      return stateResult;
    }

    const sessions = Array.from(stateResult.value.sessions.values())
      .map((session) => structuredClone(session))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    return ok(sessions);
  }

  async delete(id: string, replacementMainId?: string): Promise<SessionResult<boolean>> {
    const stateResult = await this.loadState();
    if (!stateResult.ok) {
      return stateResult;
    }

    const state = stateResult.value;
    const target = state.sessions.get(id);
    if (!target) {
      return ok(false);
    }

    if (target.isMain) {
      if (state.sessions.size === 1) {
        return err(new ConversationError("Cannot delete the main session without a replacement"));
      }

      const replacementId = replacementMainId ?? this.firstNonMainSessionId(state, id);
      if (!replacementId) {
        return err(new ConversationError("Cannot determine a replacement main session"));
      }

      const replacement = state.sessions.get(replacementId);
      if (!replacement) {
        return err(new ConversationError(`Replacement session not found: ${replacementId}`));
      }

      replacement.isMain = true;
      replacement.updatedAt = new Date().toISOString();
      state.mainSessionId = replacement.id;
    }

    state.sessions.delete(id);

    const persistResult = await this.persistState(state);
    if (!persistResult.ok) {
      return persistResult;
    }

    return ok(true);
  }

  async setMain(id: string): Promise<SessionResult<SessionMetadata>> {
    const stateResult = await this.loadState();
    if (!stateResult.ok) {
      return stateResult;
    }

    const state = stateResult.value;
    const session = state.sessions.get(id);
    if (!session) {
      return err(new ConversationError(`Session not found: ${id}`));
    }

    for (const existing of state.sessions.values()) {
      existing.isMain = existing.id === id;
      if (existing.id === id) {
        existing.updatedAt = new Date().toISOString();
      }
    }

    state.mainSessionId = id;

    const persistResult = await this.persistState(state);
    if (!persistResult.ok) {
      return persistResult;
    }

    return ok(structuredClone(session));
  }

  async newSession(options: SessionNewOptions): Promise<SessionResult<SessionMetadata>> {
    const stateResult = await this.loadState();
    if (!stateResult.ok) {
      return stateResult;
    }

    const state = stateResult.value;
    const now = new Date().toISOString();
    const previousMain = state.sessions.get(state.mainSessionId);
    if (previousMain) {
      previousMain.isMain = false;
      previousMain.status = "archived";
      previousMain.updatedAt = now;
    }

    const id = generateId("sess");
    const session: SessionMetadata = {
      id,
      title: options.title?.trim() || "New Session",
      createdAt: now,
      updatedAt: now,
      model: options.model,
      provider: options.provider,
      messageCount: options.messageCount ?? 0,
      tokenCount: options.tokenCount ?? 0,
      isMain: true,
      status: "active",
      transcriptPath: options.transcriptPath ?? this.defaultTranscriptPath(id),
    };

    state.mainSessionId = id;
    state.sessions.set(id, session);

    const persistResult = await this.persistState(state);
    if (!persistResult.ok) {
      return persistResult;
    }

    return ok(structuredClone(session));
  }

  private async loadState(): Promise<SessionResult<SessionState>> {
    try {
      const file = Bun.file(this.sessionsFilePath);
      if (!(await file.exists())) {
        return this.bootstrapState();
      }

      const content = (await file.text()).trim();
      if (!content) {
        return this.bootstrapState();
      }

      const parsed = JSON.parse(content) as SessionFileSchema;
      const schemaResult = await this.parseSchema(parsed);
      if (!schemaResult.ok) {
        return schemaResult;
      }

      const normalized = this.normalizeMain(schemaResult.value);
      if (!normalized.ok) {
        return normalized;
      }

      const state = normalized.value;
      const persistResult = await this.persistState(state);
      if (!persistResult.ok) {
        return persistResult;
      }

      return ok(state);
    } catch (cause) {
      return err(this.asConversationError("Failed to load session metadata", cause));
    }
  }

  private async parseSchema(schema: SessionFileSchema): Promise<SessionResult<SessionState>> {
    if (!schema || typeof schema !== "object") {
      return err(new ConversationError("Session metadata file is invalid"));
    }

    if (schema.version !== 1) {
      return err(new ConversationError("Unsupported session metadata version"));
    }

    if (!schema.mainSessionId || typeof schema.mainSessionId !== "string") {
      return err(new ConversationError("Session metadata is missing mainSessionId"));
    }

    const sessions = new Map<string, SessionMetadata>();
    for (const [id, metadata] of Object.entries(schema.sessions ?? {})) {
      const sessionResult = this.validateSession(id, metadata);
      if (!sessionResult.ok) {
        return sessionResult;
      }

      sessions.set(id, sessionResult.value);
    }

    if (sessions.size === 0) {
      return this.bootstrapState();
    }

    return ok({
      mainSessionId: schema.mainSessionId,
      sessions,
    });
  }

  private validateSession(id: string, metadata: SessionMetadata): SessionResult<SessionMetadata> {
    if (!metadata || typeof metadata !== "object") {
      return err(new ConversationError(`Session metadata entry is invalid: ${id}`));
    }

    if (metadata.id !== id) {
      return err(new ConversationError(`Session metadata id mismatch for ${id}`));
    }

    if (!metadata.title || typeof metadata.title !== "string") {
      return err(new ConversationError(`Session title is invalid for ${id}`));
    }

    if (!metadata.model || typeof metadata.model !== "string") {
      return err(new ConversationError(`Session model is invalid for ${id}`));
    }

    if (!metadata.provider || typeof metadata.provider !== "string") {
      return err(new ConversationError(`Session provider is invalid for ${id}`));
    }

    if (!metadata.transcriptPath || typeof metadata.transcriptPath !== "string") {
      return err(new ConversationError(`Session transcriptPath is invalid for ${id}`));
    }

    if (!isSessionStatus(metadata.status)) {
      return err(new ConversationError(`Session status is invalid for ${id}`));
    }

    return ok(structuredClone(metadata));
  }

  private normalizeMain(state: SessionState): SessionResult<SessionState> {
    const sessions = new Map<string, SessionMetadata>();
    for (const [id, session] of state.sessions.entries()) {
      sessions.set(id, structuredClone(session));
    }

    const fallbackMainId = sessions.keys().next().value;
    const mainSessionId = sessions.has(state.mainSessionId) ? state.mainSessionId : fallbackMainId;

    if (!mainSessionId) {
      return err(new ConversationError("Session metadata is empty"));
    }

    for (const [id, session] of sessions.entries()) {
      session.isMain = id === mainSessionId;
    }

    return ok({
      mainSessionId,
      sessions,
    });
  }

  private async bootstrapState(): Promise<SessionResult<SessionState>> {
    const now = new Date().toISOString();
    const id = generateId("sess");
    const session: SessionMetadata = {
      id,
      title: this.defaultTitle,
      createdAt: now,
      updatedAt: now,
      model: this.defaultModel,
      provider: this.defaultProvider,
      messageCount: 0,
      tokenCount: 0,
      isMain: true,
      status: "active",
      transcriptPath: this.defaultTranscriptPath(id),
    };

    const state: SessionState = {
      mainSessionId: id,
      sessions: new Map([[id, session]]),
    };

    const persistResult = await this.persistState(state);
    if (!persistResult.ok) {
      return persistResult;
    }

    return ok(state);
  }

  private async persistState(state: SessionState): Promise<SessionResult<void>> {
    const normalized = this.normalizeMain(state);
    if (!normalized.ok) {
      return normalized;
    }

    try {
      await mkdir(this.sessionsDir, { recursive: true });

      const payload: SessionFileSchema = {
        version: 1,
        mainSessionId: normalized.value.mainSessionId,
        sessions: Object.fromEntries(normalized.value.sessions.entries()),
      };

      const content = JSON.stringify(payload, null, 2);
      const tempPath = `${this.sessionsFilePath}.tmp-${crypto.randomUUID()}`;

      await Bun.write(tempPath, content);
      await rename(tempPath, this.sessionsFilePath);

      return ok(undefined);
    } catch (cause) {
      return err(this.asConversationError("Failed to persist session metadata", cause));
    }
  }

  private firstNonMainSessionId(state: SessionState, excludingId: string): string | null {
    for (const id of state.sessions.keys()) {
      if (id !== excludingId) {
        return id;
      }
    }

    return null;
  }

  private defaultTranscriptPath(sessionId: string): string {
    return `transcripts/${sessionId}.jsonl`;
  }

  private asConversationError(message: string, cause: unknown): ConversationError {
    if (cause instanceof ConversationError) {
      return cause;
    }

    return new ConversationError(message, cause instanceof Error ? cause : undefined);
  }
}

function isSessionStatus(status: string): status is SessionStatus {
  return status === "active" || status === "archived" || status === "compacting";
}

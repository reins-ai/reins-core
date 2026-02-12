import { ConversationManager, InMemoryConversationStore, SessionRepository } from "../conversation";
import { ConversationError } from "../errors";
import { err, ok, type Result } from "../result";
import type { SessionMetadata } from "../conversation/session-repository";
import type { TypedEventBus } from "./event-bus";
import type { HarnessEventMap } from "./events";

export interface SessionStoreOptions {
  eventBus: TypedEventBus<HarnessEventMap>;
  sessionRepository?: SessionRepository;
  conversationManager?: ConversationManager;
}

export interface SessionStoreApi {
  getActiveSession(): SessionMetadata | null;
  startTurn(): Result<AbortSignal, ConversationError>;
  abortTurn(reason?: string): Promise<Result<boolean, ConversationError>>;
  isAborted(): boolean;
  persist(): Promise<Result<SessionMetadata, ConversationError>>;
  restore(sessionId?: string): Promise<Result<SessionMetadata, ConversationError>>;
}

type SessionStoreResult<T> = Result<T, ConversationError>;

export class SessionStore implements SessionStoreApi {
  private readonly eventBus: TypedEventBus<HarnessEventMap>;
  private readonly sessionRepository: SessionRepository;
  private readonly conversationManager: ConversationManager;
  private activeSession: SessionMetadata | null = null;
  private turnController: AbortController | null = null;

  constructor(options: SessionStoreOptions) {
    this.eventBus = options.eventBus;
    this.sessionRepository = options.sessionRepository ?? new SessionRepository();
    this.conversationManager =
      options.conversationManager ??
      new ConversationManager(new InMemoryConversationStore(), this.sessionRepository);
  }

  getActiveSession(): SessionMetadata | null {
    return this.activeSession ? structuredClone(this.activeSession) : null;
  }

  startTurn(): SessionStoreResult<AbortSignal> {
    if (this.turnController && !this.turnController.signal.aborted) {
      this.abortCurrentTurn("superseded by a newer turn");
    }

    const controller = new AbortController();
    this.turnController = controller;
    return ok(controller.signal);
  }

  async abortTurn(reason?: string): Promise<SessionStoreResult<boolean>> {
    if (!this.turnController || this.turnController.signal.aborted) {
      return ok(false);
    }

    const controller = this.turnController;

    if (reason) {
      controller.abort(reason);
    } else {
      controller.abort();
    }

    await this.eventBus.emit("aborted", {
      initiatedBy: "user",
      ...(reason ? { reason } : {}),
    });

    return ok(true);
  }

  isAborted(): boolean {
    if (!this.turnController) {
      return false;
    }

    return this.turnController.signal.aborted;
  }

  async persist(): Promise<SessionStoreResult<SessionMetadata>> {
    if (!this.activeSession) {
      return err(new ConversationError("No active session to persist"));
    }

    const updated = await this.sessionRepository.update(this.activeSession.id, {
      title: this.activeSession.title,
      model: this.activeSession.model,
      provider: this.activeSession.provider,
      messageCount: this.activeSession.messageCount,
      tokenCount: this.activeSession.tokenCount,
      status: this.activeSession.status,
      lastCompactedAt: this.activeSession.lastCompactedAt,
      transcriptPath: this.activeSession.transcriptPath,
    });
    if (!updated.ok) {
      return updated;
    }

    this.activeSession = updated.value;
    return ok(structuredClone(updated.value));
  }

  async restore(sessionId?: string): Promise<SessionStoreResult<SessionMetadata>> {
    const sessionResult = sessionId
      ? await this.sessionRepository.get(sessionId)
      : await this.conversationManager.resumeMain();

    if (!sessionResult.ok) {
      return sessionResult;
    }

    if (!sessionResult.value) {
      return err(new ConversationError(`Session not found: ${sessionId}`));
    }

    this.activeSession = sessionResult.value;
    return ok(structuredClone(sessionResult.value));
  }

  private abortCurrentTurn(reason: string): void {
    if (!this.turnController || this.turnController.signal.aborted) {
      return;
    }

    this.turnController.abort(reason);
    this.turnController = null;

    void this.eventBus.emit("aborted", {
      initiatedBy: "system",
      reason,
    });
  }
}

import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type { Message } from "../../types";
import type {
  CompactionContext,
  PreCompactionHook,
  PreservationResult,
} from "./memory-preservation-hook";

export interface CompactionManagerOptions {
  truncator?: Truncator;
}

export interface CompactionManagerResult {
  truncatedMessages: Message[];
  retainedMessages: Message[];
  preservationResults: PreservationResult[];
  telemetry: {
    extractedCount: number;
    persistedCount: number;
    skippedDuplicates: number;
  };
}

interface TruncationResult {
  truncatedMessages: Message[];
  retainedMessages: Message[];
}

type Truncator = (
  messages: Message[],
  context: CompactionContext,
) => Result<TruncationResult, CompactionManagerError>;

export class CompactionManagerError extends ReinsError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = "CompactionManagerError";
  }
}

export class CompactionManager {
  private readonly hooks: PreCompactionHook[] = [];
  private readonly truncator: Truncator;

  constructor(options: CompactionManagerOptions = {}) {
    this.truncator = options.truncator ?? defaultTruncator;
  }

  addPreCompactionHook(hook: PreCompactionHook): void {
    this.hooks.push(hook);
  }

  async compact(
    messages: Message[],
    context: CompactionContext,
  ): Promise<Result<CompactionManagerResult, CompactionManagerError>> {
    if (!context.conversationId.trim()) {
      return err(
        new CompactionManagerError(
          "Compaction context requires a conversationId",
          "COMPACTION_MANAGER_INVALID_CONTEXT",
        ),
      );
    }

    if (!context.sessionId.trim()) {
      return err(
        new CompactionManagerError(
          "Compaction context requires a sessionId",
          "COMPACTION_MANAGER_INVALID_CONTEXT",
        ),
      );
    }

    const truncatedMessages = messages.slice(0, clampTruncationPoint(context.truncationPoint, messages.length));
    const preservationResults: PreservationResult[] = [];

    for (const hook of this.hooks) {
      const result = await hook.onPreCompaction(truncatedMessages, context);
      if (!result.ok) {
        return err(
          new CompactionManagerError(
            "Pre-compaction memory preservation hook failed",
            "COMPACTION_MANAGER_HOOK_FAILED",
            result.error,
          ),
        );
      }

      preservationResults.push(result.value);
    }

    const truncation = this.truncator(messages, context);
    if (!truncation.ok) {
      return truncation;
    }

    return ok({
      ...truncation.value,
      preservationResults,
      telemetry: {
        extractedCount: preservationResults.reduce((sum, item) => sum + item.extractedCount, 0),
        persistedCount: preservationResults.reduce((sum, item) => sum + item.persistedCount, 0),
        skippedDuplicates: preservationResults.reduce((sum, item) => sum + item.skippedDuplicates, 0),
      },
    });
  }
}

function defaultTruncator(
  messages: Message[],
  context: CompactionContext,
): Result<TruncationResult, CompactionManagerError> {
  const truncationPoint = clampTruncationPoint(context.truncationPoint, messages.length);

  return ok({
    truncatedMessages: messages.slice(0, truncationPoint),
    retainedMessages: messages.slice(truncationPoint),
  });
}

function clampTruncationPoint(truncationPoint: number, length: number): number {
  if (!Number.isFinite(truncationPoint)) {
    return 0;
  }

  if (truncationPoint < 0) {
    return 0;
  }

  if (truncationPoint > length) {
    return length;
  }

  return Math.floor(truncationPoint);
}

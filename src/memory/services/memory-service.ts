import { createLogger } from "../../logger";
import { err, ok, type Result } from "../../result";
import type { MemoryLayer, MemoryRecord, MemoryType } from "../types/index";

const log = createLogger("memory:service");
import type {
  CreateMemoryInput,
  ListMemoryOptions,
  MemoryRepository,
  UpdateMemoryInput as RepoUpdateMemoryInput,
} from "../storage/memory-repository";
import { MemoryError } from "./memory-error";
import type { MemoryHealthStatus, MemoryServiceContract } from "./memory-service-contract";
import {
  createDefaultPolicies,
  DuplicatePolicy,
  runPolicies,
  type DuplicateChecker,
  type WritePolicy,
  type WritePolicyWarning,
} from "./memory-write-policies";

export interface ExplicitMemoryInput {
  content: string;
  type?: MemoryType;
  tags?: string[];
  entities?: string[];
  conversationId?: string;
  messageId?: string;
}

export interface ImplicitMemoryInput {
  content: string;
  type: MemoryType;
  confidence: number;
  tags?: string[];
  entities?: string[];
  conversationId: string;
  messageId?: string;
}

export interface MemoryListOptions {
  type?: MemoryType;
  layer?: MemoryLayer;
  limit?: number;
  offset?: number;
  sortBy?: "createdAt" | "importance" | "accessedAt";
  sortOrder?: "asc" | "desc";
}

export interface UpdateMemoryInput {
  content?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  entities?: string[];
}

export interface MemoryServiceOptions {
  repository: MemoryRepository;
  logger?: MemoryLogger;
}

export interface MemoryLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const DEFAULT_EXPLICIT_IMPORTANCE = 0.7;
const DEFAULT_IMPLICIT_IMPORTANCE = 0.5;
const DEFAULT_EXPLICIT_TYPE: MemoryType = "fact";
const DEFAULT_LIST_LIMIT = 50;

class RepositoryDuplicateChecker implements DuplicateChecker {
  private readonly repository: MemoryRepository;

  constructor(repository: MemoryRepository) {
    this.repository = repository;
  }

  async hasExactContent(content: string): Promise<boolean> {
    const result = await this.repository.list({ limit: 500 });
    if (!result.ok) {
      return false;
    }

    return result.value.some((record) => record.content === content);
  }
}

export class MemoryService implements MemoryServiceContract {
  private readonly repository: MemoryRepository;
  private readonly logger: MemoryLogger;
  private readonly policies: WritePolicy[];
  private readonly duplicatePolicy: DuplicatePolicy;
  private ready = false;

  constructor(options: MemoryServiceOptions) {
    this.repository = options.repository;
    this.logger = options.logger ?? createNoopLogger();

    const checker = new RepositoryDuplicateChecker(this.repository);
    this.policies = createDefaultPolicies(checker);

    const found = this.policies.find(
      (p): p is DuplicatePolicy => p instanceof DuplicatePolicy,
    );
    if (!found) {
      throw new Error("DuplicatePolicy must be present in default policies");
    }
    this.duplicatePolicy = found;
  }

  async initialize(): Promise<Result<void>> {
    try {
      this.ready = true;
      this.logger.info("Memory service initialized");
      return ok(undefined);
    } catch (cause) {
      return err(
        new MemoryError(
          "Failed to initialize memory service",
          "MEMORY_INIT_FAILED",
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  async shutdown(): Promise<Result<void>> {
    try {
      this.ready = false;
      this.logger.info("Memory service shut down");
      return ok(undefined);
    } catch (cause) {
      return err(
        new MemoryError(
          "Failed to shut down memory service",
          "MEMORY_SHUTDOWN_FAILED",
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async healthCheck(): Promise<Result<MemoryHealthStatus>> {
    const readyGuard = this.guardReady();
    if (readyGuard) {
      return readyGuard;
    }

    try {
      const countResult = await this.repository.count();
      if (!countResult.ok) {
        return ok({
          dbConnected: false,
          memoryCount: 0,
        });
      }

      return ok({
        dbConnected: true,
        memoryCount: countResult.value,
      });
    } catch (cause) {
      return err(
        new MemoryError(
          "Health check failed",
          "MEMORY_DB_ERROR",
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  async rememberExplicit(input: ExplicitMemoryInput): Promise<Result<MemoryRecord>> {
    const readyGuard = this.guardReady();
    if (readyGuard) {
      return readyGuard;
    }

    const createInput: CreateMemoryInput = {
      content: input.content,
      type: input.type ?? DEFAULT_EXPLICIT_TYPE,
      layer: "stm",
      importance: DEFAULT_EXPLICIT_IMPORTANCE,
      confidence: 1.0,
      tags: input.tags,
      entities: input.entities,
      source: {
        type: "explicit",
        conversationId: input.conversationId,
        messageId: input.messageId,
      },
    };

    return this.createWithPolicies(createInput);
  }

  async saveImplicit(input: ImplicitMemoryInput): Promise<Result<MemoryRecord>> {
    const readyGuard = this.guardReady();
    if (readyGuard) {
      return readyGuard;
    }

    const createInput: CreateMemoryInput = {
      content: input.content,
      type: input.type,
      layer: "stm",
      importance: DEFAULT_IMPLICIT_IMPORTANCE,
      confidence: input.confidence,
      tags: input.tags,
      entities: input.entities,
      source: {
        type: "implicit",
        conversationId: input.conversationId,
        messageId: input.messageId,
      },
    };

    return this.createWithPolicies(createInput);
  }

  async saveBatch(inputs: ImplicitMemoryInput[]): Promise<Result<MemoryRecord[]>> {
    const readyGuard = this.guardReady();
    if (readyGuard) {
      return readyGuard;
    }

    const records: MemoryRecord[] = [];

    for (const input of inputs) {
      const result = await this.saveImplicit(input);
      if (!result.ok) {
        this.logger.warn(
          `Batch save: skipping memory due to error: ${result.error.message}`,
        );
        continue;
      }

      records.push(result.value);
    }

    return ok(records);
  }

  async getById(id: string): Promise<Result<MemoryRecord | null>> {
    const readyGuard = this.guardReady();
    if (readyGuard) {
      return readyGuard;
    }

    return this.repository.getById(id);
  }

  async list(options?: MemoryListOptions): Promise<Result<MemoryRecord[]>> {
    const readyGuard = this.guardReady();
    if (readyGuard) {
      return readyGuard;
    }

    const repoOptions: ListMemoryOptions = {
      type: options?.type,
      limit: options?.limit ?? DEFAULT_LIST_LIMIT,
      offset: options?.offset ?? 0,
    };

    if (options?.layer === "stm" || options?.layer === "ltm") {
      repoOptions.layer = options.layer;
    }

    return this.repository.list(repoOptions);
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Result<MemoryRecord>> {
    const readyGuard = this.guardReady();
    if (readyGuard) {
      return readyGuard;
    }

    const repoInput: RepoUpdateMemoryInput = {
      content: input.content,
      importance: input.importance,
      confidence: input.confidence,
      tags: input.tags,
      entities: input.entities,
    };

    return this.repository.update(id, repoInput);
  }

  async forget(id: string): Promise<Result<void>> {
    const readyGuard = this.guardReady();
    if (readyGuard) {
      return readyGuard;
    }

    return this.repository.delete(id);
  }

  async count(filter?: { type?: MemoryType; layer?: MemoryLayer }): Promise<Result<number>> {
    const readyGuard = this.guardReady();
    if (readyGuard) {
      return readyGuard;
    }

    if (!filter?.type && !filter?.layer) {
      return this.repository.count();
    }

    const listOptions: ListMemoryOptions = {
      type: filter.type,
      limit: 100000,
    };

    if (filter.layer === "stm" || filter.layer === "ltm") {
      listOptions.layer = filter.layer;
    }

    const result = await this.repository.list(listOptions);
    if (!result.ok) {
      return result;
    }

    return ok(result.value.length);
  }

  private async createWithPolicies(input: CreateMemoryInput): Promise<Result<MemoryRecord>> {
    const policyResult = runPolicies(this.policies, input);
    if (!policyResult.passed) {
      const messages = policyResult.violations.map((v) => v.message).join("; ");
      return err(
        new MemoryError(
          `Write policy violation: ${messages}`,
          "MEMORY_DB_ERROR",
        ),
      );
    }

    const warnings = await this.checkDuplicateWarnings(input.content);
    for (const warning of warnings) {
      this.logger.warn(`[${warning.policy}] ${warning.message}`);
    }

    return this.repository.create(input);
  }

  private async checkDuplicateWarnings(content: string): Promise<WritePolicyWarning[]> {
    const warnings: WritePolicyWarning[] = [];

    try {
      const warning = await this.duplicatePolicy.checkDuplicateAsync(content);
      if (warning) {
        warnings.push(warning);
      }
    } catch (e) {
      // Expected: duplicate check is best-effort — don't block writes
      log.debug("duplicate check failed", { error: e instanceof Error ? e.message : String(e) });
    }

    return warnings;
  }

  private guardReady(): Result<never> | null {
    if (!this.ready) {
      return err(
        new MemoryError(
          "Memory service is not initialized",
          "MEMORY_NOT_READY",
        ),
      );
    }

    return null;
  }
}

function createNoopLogger(): MemoryLogger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

import { createHash } from "node:crypto";
import { basename } from "node:path";

import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import { DEFAULT_SOURCE_POLICY, type DocumentSourcePolicy } from "./document-source-policy";

export const DOCUMENT_SOURCE_STATUSES = [
  "registered",
  "indexing",
  "indexed",
  "error",
  "removed",
] as const;

export type DocumentSourceStatus = (typeof DOCUMENT_SOURCE_STATUSES)[number];

export interface DocumentSource {
  id: string;
  rootPath: string;
  name: string;
  policy: DocumentSourcePolicy;
  status: DocumentSourceStatus;
  lastIndexedAt?: string;
  lastCheckpoint?: string;
  fileCount?: number;
  errorMessage?: string;
  registeredAt: string;
  updatedAt: string;
}

export interface RegisterOptions {
  name?: string;
  policy?: Partial<DocumentSourcePolicy>;
}

export interface StatusUpdateMetadata {
  lastIndexedAt?: string;
  fileCount?: number;
  errorMessage?: string;
  lastCheckpoint?: string;
}

export class DocumentSourceRegistryError extends ReinsError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = "DocumentSourceRegistryError";
  }
}

function generateSourceId(rootPath: string): string {
  const normalized = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function nowISO(): string {
  return new Date().toISOString();
}

export class DocumentSourceRegistry {
  private readonly sources: Map<string, DocumentSource>;

  constructor(initialSources?: DocumentSource[]) {
    this.sources = new Map();
    if (initialSources) {
      for (const source of initialSources) {
        this.sources.set(source.id, source);
      }
    }
  }

  register(
    rootPath: string,
    options?: RegisterOptions,
  ): Result<DocumentSource, DocumentSourceRegistryError> {
    if (!rootPath || rootPath.trim().length === 0) {
      return err(
        new DocumentSourceRegistryError(
          "rootPath must be a non-empty string",
          "INVALID_ROOT_PATH",
        ),
      );
    }

    const id = generateSourceId(rootPath);

    const existing = this.sources.get(id);
    if (existing && existing.status !== "removed") {
      return err(
        new DocumentSourceRegistryError(
          `Source already registered: ${rootPath}`,
          "SOURCE_ALREADY_REGISTERED",
        ),
      );
    }

    const policy: DocumentSourcePolicy = {
      ...DEFAULT_SOURCE_POLICY,
      ...options?.policy,
    };

    const now = nowISO();
    const source: DocumentSource = {
      id,
      rootPath,
      name: options?.name ?? basename(rootPath),
      policy,
      status: "registered",
      registeredAt: now,
      updatedAt: now,
    };

    this.sources.set(id, source);
    return ok(source);
  }

  unregister(id: string): Result<void, DocumentSourceRegistryError> {
    const source = this.sources.get(id);
    if (!source) {
      return err(
        new DocumentSourceRegistryError(
          `Source not found: ${id}`,
          "SOURCE_NOT_FOUND",
        ),
      );
    }

    if (source.status === "removed") {
      return err(
        new DocumentSourceRegistryError(
          `Source already removed: ${id}`,
          "SOURCE_ALREADY_REMOVED",
        ),
      );
    }

    this.sources.set(id, {
      ...source,
      status: "removed",
      updatedAt: nowISO(),
    });

    return ok(undefined);
  }

  get(id: string): Result<DocumentSource | null, DocumentSourceRegistryError> {
    const source = this.sources.get(id) ?? null;
    return ok(source);
  }

  list(filter?: { status?: DocumentSourceStatus }): DocumentSource[] {
    const results: DocumentSource[] = [];
    for (const source of this.sources.values()) {
      if (filter?.status !== undefined && source.status !== filter.status) {
        continue;
      }
      results.push(source);
    }
    return results;
  }

  updateStatus(
    id: string,
    status: DocumentSourceStatus,
    metadata?: StatusUpdateMetadata,
  ): Result<DocumentSource, DocumentSourceRegistryError> {
    const source = this.sources.get(id);
    if (!source) {
      return err(
        new DocumentSourceRegistryError(
          `Source not found: ${id}`,
          "SOURCE_NOT_FOUND",
        ),
      );
    }

    const updated: DocumentSource = {
      ...source,
      status,
      updatedAt: nowISO(),
      ...(metadata?.lastIndexedAt !== undefined && { lastIndexedAt: metadata.lastIndexedAt }),
      ...(metadata?.fileCount !== undefined && { fileCount: metadata.fileCount }),
      ...(metadata?.errorMessage !== undefined && { errorMessage: metadata.errorMessage }),
      ...(metadata?.lastCheckpoint !== undefined && { lastCheckpoint: metadata.lastCheckpoint }),
    };

    this.sources.set(id, updated);
    return ok(updated);
  }

  getCheckpoint(id: string): Result<string | null, DocumentSourceRegistryError> {
    const source = this.sources.get(id);
    if (!source) {
      return err(
        new DocumentSourceRegistryError(
          `Source not found: ${id}`,
          "SOURCE_NOT_FOUND",
        ),
      );
    }

    return ok(source.lastCheckpoint ?? null);
  }

  saveCheckpoint(
    id: string,
    checkpoint: string,
  ): Result<void, DocumentSourceRegistryError> {
    const source = this.sources.get(id);
    if (!source) {
      return err(
        new DocumentSourceRegistryError(
          `Source not found: ${id}`,
          "SOURCE_NOT_FOUND",
        ),
      );
    }

    this.sources.set(id, {
      ...source,
      lastCheckpoint: checkpoint,
      updatedAt: nowISO(),
    });

    return ok(undefined);
  }
}

export { generateSourceId as generateSourceIdForTesting };

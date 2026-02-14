import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { err, ok, type Result } from "../result";
import { getDataRoot } from "./paths";
import { DaemonError } from "./types";
import type {
  EmbeddingProviderConfig,
  MemoryCapabilities,
  MemoryConfig,
} from "./types/memory-config";

const MEMORY_CONFIG_FILE = "embedding-config.json";

export interface MemoryConfigPathOptions {
  dataRoot?: string;
  filePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeEmbeddingProviderConfig(value: unknown): EmbeddingProviderConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (provider.length === 0 || model.length === 0) {
    return undefined;
  }

  return {
    provider,
    model,
  };
}

function normalizeMemoryConfig(value: unknown): MemoryConfig {
  if (!isRecord(value)) {
    return {};
  }

  return {
    embedding: normalizeEmbeddingProviderConfig(value.embedding),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

export function resolveMemoryConfigPath(options: MemoryConfigPathOptions = {}): string {
  if (options.filePath) {
    return options.filePath;
  }

  const dataRoot = options.dataRoot ?? getDataRoot();
  return join(dataRoot, "memory", MEMORY_CONFIG_FILE);
}

export function hasEmbeddingProviderConfig(config: MemoryConfig | null | undefined): boolean {
  return Boolean(config?.embedding?.provider && config.embedding.model);
}

export function resolveMemoryCapabilities(config: MemoryConfig | null, configPath: string): MemoryCapabilities {
  const embeddingConfigured = hasEmbeddingProviderConfig(config);

  return {
    embeddingConfigured,
    setupRequired: !embeddingConfigured,
    configPath,
    features: {
      crud: {
        enabled: true,
      },
      semanticSearch: embeddingConfigured
        ? { enabled: true }
        : { enabled: false, reason: "Embedding provider setup is required." },
      consolidation: embeddingConfigured
        ? { enabled: true }
        : { enabled: false, reason: "Embedding provider setup is required." },
    },
    embedding: config?.embedding,
  };
}

export async function readMemoryConfig(
  options: MemoryConfigPathOptions = {},
): Promise<Result<MemoryConfig | null, DaemonError>> {
  const configPath = resolveMemoryConfigPath(options);
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    return ok(null);
  }

  try {
    const raw = await file.json();
    return ok(normalizeMemoryConfig(raw));
  } catch (error) {
    return err(
      new DaemonError(
        `Unable to read memory embedding config: ${configPath}`,
        "DAEMON_MEMORY_CONFIG_READ_FAILED",
        error instanceof Error ? error : undefined,
      ),
    );
  }
}

export async function writeMemoryConfig(
  config: MemoryConfig,
  options: MemoryConfigPathOptions = {},
): Promise<Result<MemoryConfig, DaemonError>> {
  const configPath = resolveMemoryConfigPath(options);
  const normalizedConfig = normalizeMemoryConfig(config);
  const nextConfig: MemoryConfig = {
    ...normalizedConfig,
    updatedAt: new Date().toISOString(),
  };

  try {
    await mkdir(dirname(configPath), { recursive: true });
    await Bun.write(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
    return ok(nextConfig);
  } catch (error) {
    return err(
      new DaemonError(
        `Unable to write memory embedding config: ${configPath}`,
        "DAEMON_MEMORY_CONFIG_WRITE_FAILED",
        error instanceof Error ? error : undefined,
      ),
    );
  }
}

export class MemoryCapabilitiesResolver {
  private readonly options: MemoryConfigPathOptions;

  constructor(options: MemoryConfigPathOptions = {}) {
    this.options = options;
  }

  async getCapabilities(): Promise<Result<MemoryCapabilities, DaemonError>> {
    const configPath = resolveMemoryConfigPath(this.options);
    const configResult = await readMemoryConfig(this.options);
    if (!configResult.ok) {
      return configResult;
    }

    return ok(resolveMemoryCapabilities(configResult.value, configPath));
  }

  async saveConfig(config: MemoryConfig): Promise<Result<MemoryConfig, DaemonError>> {
    return writeMemoryConfig(config, this.options);
  }
}

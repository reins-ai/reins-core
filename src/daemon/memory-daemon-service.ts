import { createLogger } from "../logger";
import { DaemonError, type DaemonManagedService, type DaemonResult } from "./types";
import { err, ok, type Result } from "../result";
import { MemoryError, type MemoryErrorCode, type MemoryHealthStatus, type MemoryServiceContract } from "../memory/services";
import { MemoryCapabilitiesResolver } from "./memory-capabilities";
import type { MemoryCapabilities } from "./types/memory-config";

export type MemoryDaemonServiceState = "idle" | "starting" | "ready" | "stopping" | "stopped" | "error";

export interface MemoryDaemonServiceLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface MemoryDaemonServiceOptions {
  dbPath: string;
  dataDir: string;
  embeddingProvider?: string;
  logger?: MemoryDaemonServiceLogger;
  memoryService: MemoryServiceContract;
  initializeStorage?: (dbPath: string) => Promise<Result<void, MemoryError>>;
  scanDataDirectory?: (dataDir: string) => Promise<Result<number, MemoryError>>;
  flushPendingWrites?: () => Promise<Result<void, MemoryError>>;
  checkStorageHealth?: () => Promise<Result<boolean, MemoryError>>;
  closeStorage?: () => Promise<Result<void, MemoryError>>;
  capabilitiesResolver?: MemoryCapabilitiesResolver;
}

const defaultInitializeStorage = async (): Promise<Result<void, MemoryError>> => ok(undefined);
const defaultScanDataDirectory = async (): Promise<Result<number, MemoryError>> => ok(0);
const defaultFlushPendingWrites = async (): Promise<Result<void, MemoryError>> => ok(undefined);
const defaultCheckStorageHealth = async (): Promise<Result<boolean, MemoryError>> => ok(true);
const defaultCloseStorage = async (): Promise<Result<void, MemoryError>> => ok(undefined);

const moduleLogger = createLogger("memory");

const defaultLogger: MemoryDaemonServiceLogger = {
  info: (message, ...args) => {
    moduleLogger.info(message, args.length > 0 ? { args } : undefined);
  },
  warn: (message, ...args) => {
    moduleLogger.warn(message, args.length > 0 ? { args } : undefined);
  },
  error: (message, ...args) => {
    moduleLogger.error(message, args.length > 0 ? { args } : undefined);
  },
  debug: (message, ...args) => {
    moduleLogger.debug(message, args.length > 0 ? { args } : undefined);
  },
};

/**
 * Daemon-managed memory service lifecycle shell.
 *
 * This task provides lifecycle boundaries only; persistence internals are injected.
 */
export class MemoryDaemonService implements DaemonManagedService {
  readonly id = "memory";

  private state: MemoryDaemonServiceState = "idle";
  private readonly logger: MemoryDaemonServiceLogger;
  private readonly initializeStorage: (dbPath: string) => Promise<Result<void, MemoryError>>;
  private readonly scanDataDirectory: (dataDir: string) => Promise<Result<number, MemoryError>>;
  private readonly flushPendingWrites: () => Promise<Result<void, MemoryError>>;
  private readonly checkStorageHealth: () => Promise<Result<boolean, MemoryError>>;
  private readonly closeStorage: () => Promise<Result<void, MemoryError>>;
  private readonly memoryService: MemoryServiceContract;
  private readonly dbPath: string;
  private readonly dataDir: string;
  private readonly embeddingProvider?: string;
  private readonly capabilitiesResolver: MemoryCapabilitiesResolver;
  private capabilities: MemoryCapabilities;
  private memoryCount = 0;
  private lastConsolidation?: Date;

  constructor(options: MemoryDaemonServiceOptions) {
    this.dbPath = options.dbPath;
    this.dataDir = options.dataDir;
    this.embeddingProvider = options.embeddingProvider;
    this.logger = options.logger ?? defaultLogger;
    this.memoryService = options.memoryService;
    this.initializeStorage = options.initializeStorage ?? defaultInitializeStorage;
    this.scanDataDirectory = options.scanDataDirectory ?? defaultScanDataDirectory;
    this.flushPendingWrites = options.flushPendingWrites ?? defaultFlushPendingWrites;
    this.checkStorageHealth = options.checkStorageHealth ?? defaultCheckStorageHealth;
    this.closeStorage = options.closeStorage ?? defaultCloseStorage;
    this.capabilitiesResolver = options.capabilitiesResolver ?? new MemoryCapabilitiesResolver();
    this.capabilities = {
      embeddingConfigured: false,
      setupRequired: true,
      configPath: "",
      features: {
        crud: { enabled: true },
        semanticSearch: { enabled: false, reason: "Embedding provider setup is required." },
        consolidation: { enabled: false, reason: "Embedding provider setup is required." },
      },
    };
  }

  getState(): MemoryDaemonServiceState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === "ready" && this.memoryService.isReady();
  }

  getCapabilities(): MemoryCapabilities {
    return this.capabilities;
  }

  async refreshCapabilities(): Promise<void> {
    const capabilitiesResult = await this.capabilitiesResolver.getCapabilities();
    if (!capabilitiesResult.ok) {
      this.logger.warn("Unable to load memory embedding configuration; continuing in setup-required mode", {
        error: capabilitiesResult.error.message,
      });
      return;
    }

    this.capabilities = capabilitiesResult.value;
  }

  async start(): Promise<DaemonResult<void>> {
    if (!this.canStart()) {
      return err(this.toDaemonError(this.createMemoryError("Memory service cannot start in current state", "MEMORY_INIT_FAILED")));
    }

    this.state = "starting";
    this.logger.info("Starting memory daemon service", { dbPath: this.dbPath, dataDir: this.dataDir });

    await this.refreshCapabilities();

    const initializeStorageResult = await this.initializeStorage(this.dbPath);
    if (!initializeStorageResult.ok) {
      return this.failStart(initializeStorageResult.error);
    }

    const scanResult = await this.scanDataDirectory(this.dataDir);
    if (!scanResult.ok) {
      return this.failStart(scanResult.error);
    }
    this.memoryCount = scanResult.value;

    const initializeResult = await this.memoryService.initialize();
    if (!initializeResult.ok) {
      return this.failStart(this.toMemoryError(initializeResult.error, "MEMORY_INIT_FAILED"));
    }

    this.state = "ready";
    this.logger.info("Memory daemon service started", { memoryCount: this.memoryCount });
    return ok(undefined);
  }

  async stop(_signal?: NodeJS.Signals): Promise<DaemonResult<void>> {
    if (this.state === "idle" || this.state === "stopped") {
      this.state = "stopped";
      return ok(undefined);
    }

    this.state = "stopping";
    this.logger.info("Stopping memory daemon service");

    const errors: MemoryError[] = [];

    const flushResult = await this.flushPendingWrites();
    if (!flushResult.ok) {
      errors.push(flushResult.error);
    }

    const shutdownResult = await this.memoryService.shutdown();
    if (!shutdownResult.ok) {
      errors.push(this.toMemoryError(shutdownResult.error, "MEMORY_SHUTDOWN_FAILED"));
    }

    const closeStorageResult = await this.closeStorage();
    if (!closeStorageResult.ok) {
      errors.push(closeStorageResult.error);
    }

    if (errors.length > 0) {
      const primaryError = errors[0];
      this.state = "error";
      this.logger.error("Memory daemon service failed to stop cleanly", {
        code: primaryError.code,
        message: primaryError.message,
        errorCount: errors.length,
      });
      return err(this.toDaemonError(primaryError));
    }

    this.state = "stopped";
    this.logger.info("Memory daemon service stopped");
    return ok(undefined);
  }

  async healthCheck(): Promise<Result<MemoryHealthStatus, MemoryError>> {
    const storageHealthResult = await this.checkStorageHealth();
    if (!storageHealthResult.ok) {
      return err(this.toMemoryError(storageHealthResult.error, "MEMORY_DB_ERROR"));
    }

    if (!this.isReady() || !this.memoryService.isReady()) {
      return err(this.createMemoryError("Memory service is not ready", "MEMORY_NOT_READY"));
    }

    const healthResult = await this.memoryService.healthCheck();
    if (!healthResult.ok) {
      return err(this.toMemoryError(healthResult.error, "MEMORY_DB_ERROR"));
    }

    return ok({
      ...healthResult.value,
      dbConnected: healthResult.value.dbConnected && storageHealthResult.value,
      memoryCount: Math.max(healthResult.value.memoryCount, this.memoryCount),
      lastConsolidation: healthResult.value.lastConsolidation ?? this.lastConsolidation,
      embeddingProvider: healthResult.value.embeddingProvider ?? this.capabilities.embedding?.provider ?? this.embeddingProvider,
    });
  }

  private canStart(): boolean {
    return this.state === "idle" || this.state === "stopped";
  }

  private failStart(error: MemoryError): DaemonResult<void> {
    this.state = "error";
    this.logger.error("Memory daemon service failed to start", { code: error.code, message: error.message });
    return err(this.toDaemonError(error));
  }

  private toDaemonError(error: MemoryError): DaemonError {
    return new DaemonError(error.message, error.code, error);
  }

  private toMemoryError(error: unknown, fallbackCode: MemoryErrorCode): MemoryError {
    if (error instanceof MemoryError) {
      return error;
    }

    if (error instanceof Error) {
      return this.createMemoryError(error.message, fallbackCode, error);
    }

    return this.createMemoryError("Unknown memory service error", fallbackCode);
  }

  private createMemoryError(message: string, code: MemoryErrorCode, cause?: Error): MemoryError {
    return new MemoryError(message, code, cause);
  }
}

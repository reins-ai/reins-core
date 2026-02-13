import { ReinsError } from "../errors";
import type { Result } from "../result";

/**
 * Supported daemon lifecycle states.
 */
export type DaemonState = "stopped" | "starting" | "running" | "stopping" | "failed";

/**
 * Supported operating-system platforms.
 */
export type DaemonPlatform = "darwin" | "linux" | "win32";

/**
 * Lifecycle event categories emitted by daemon runtime.
 */
export type DaemonLifecycleEventType =
  | "state-transition"
  | "start-requested"
  | "stop-requested"
  | "restart-requested"
  | "signal-received"
  | "service-registered"
  | "error";

/**
 * Structured lifecycle event used for logs and observers.
 */
export interface DaemonLifecycleEvent {
  type: DaemonLifecycleEventType;
  timestamp: string;
  state: DaemonState;
  previousState?: DaemonState;
  nextState?: DaemonState;
  serviceId?: string;
  signal?: NodeJS.Signals;
  message?: string;
  error?: {
    name: string;
    code: string;
    message: string;
  };
}

/**
 * Logger contract for daemon lifecycle events.
 */
export interface DaemonLifecycleLogger {
  log(event: DaemonLifecycleEvent): void;
}

/**
 * Runtime-managed service started and stopped with the daemon lifecycle.
 */
export interface DaemonManagedService {
  id: string;
  start(): Promise<Result<void, DaemonError>>;
  stop(signal?: NodeJS.Signals): Promise<Result<void, DaemonError>>;
}

/**
 * Runtime configuration for lifecycle behavior.
 */
export interface DaemonRuntimeOptions {
  shutdownTimeoutMs?: number;
  restartBackoffMs?: number;
  logger?: DaemonLifecycleLogger;
  now?: () => Date;
}

/**
 * Service definition used to generate and install per-user service managers.
 */
export interface ServiceDefinition {
  serviceName: string;
  displayName: string;
  description: string;
  command: string;
  args: string[];
  workingDirectory: string;
  env: Record<string, string>;
  autoRestart: boolean;
}

/**
 * Generated platform-specific service configuration artifact.
 */
export interface GeneratedServiceConfig {
  platform: DaemonPlatform;
  filePath: string;
  content: string;
}

/**
 * Command execution contract for installer operations.
 */
export interface PlatformCommandRunner {
  run(command: string, args: string[]): Promise<Result<{ stdout: string; stderr: string }, DaemonError>>;
}

/**
 * Minimal file-system contract used by the service installer.
 */
export interface InstallerFileSystem {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  unlink(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/**
 * Platform adapter contract for per-user service managers.
 */
export interface PlatformServiceAdapter {
  platform: DaemonPlatform;
  generateConfig(definition: ServiceDefinition): Result<GeneratedServiceConfig, DaemonError>;
  install(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<Result<void, DaemonError>>;
  start(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<Result<void, DaemonError>>;
  stop(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<Result<void, DaemonError>>;
  uninstall(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<Result<void, DaemonError>>;
  status(
    definition: ServiceDefinition,
    runner: PlatformCommandRunner,
  ): Promise<Result<"running" | "stopped" | "not-installed", DaemonError>>;
}

/**
 * Error type for daemon runtime and installer operations.
 */
export class DaemonError extends ReinsError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = "DaemonError";
  }
}

export type DaemonResult<T> = Result<T, DaemonError>;
export type DaemonFailure = Result<never, DaemonError | ReinsError>;

export interface DaemonTokenStreamEvent {
  type: "token";
  content: string;
}

export interface DaemonToolCallStartStreamEvent {
  type: "tool_call_start";
  tool_use_id: string;
  name: string;
  input: Record<string, unknown>;
  timestamp?: string;
}

export interface DaemonToolCallEndStreamEvent {
  type: "tool_call_end";
  tool_use_id: string;
  result: unknown;
  result_summary: string;
  is_error?: boolean;
  error?: string;
  timestamp?: string;
}

export interface DaemonDoneStreamEvent {
  type: "done";
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  stepsUsed?: number;
  reason?: string;
}

export interface DaemonErrorStreamEvent {
  type: "error";
  error: string;
  code?: string;
}

export type DaemonStreamEvent =
  | DaemonTokenStreamEvent
  | DaemonToolCallStartStreamEvent
  | DaemonToolCallEndStreamEvent
  | DaemonDoneStreamEvent
  | DaemonErrorStreamEvent;

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { err, ok } from "../result";
import { DaemonError, type DaemonManagedService, type DaemonResult } from "../daemon/types";

import { SkillRegistry } from "./registry";
import { SkillScanner, type DiscoveryReport } from "./scanner";
import { FileSkillStateStore, type SkillStateStore } from "./state-store";
import { SkillWatcher, type SkillWatcherCallbacks, type SkillWatcherOptions } from "./watcher";

export type SkillDaemonServiceState = "idle" | "starting" | "running" | "stopping" | "stopped" | "error";

export interface SkillDaemonServiceLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface SkillDaemonServiceOptions {
  skillsDir: string;
  watcherCallbacks?: SkillWatcherCallbacks;
  watcherOptions?: SkillWatcherOptions;
  logger?: SkillDaemonServiceLogger;
  stateStore?: SkillStateStore;
  createRegistry?: (stateStore?: SkillStateStore) => SkillRegistry;
  createScanner?: (registry: SkillRegistry, skillsDir: string) => SkillScanner;
  createWatcher?: (
    registry: SkillRegistry,
    skillsDir: string,
    callbacks?: SkillWatcherCallbacks,
    options?: SkillWatcherOptions,
  ) => SkillWatcher;
  ensureSkillsDirectory?: (skillsDir: string) => Promise<void>;
}

const defaultLogger: SkillDaemonServiceLogger = {
  info: (...args) => {
    console.info(...args);
  },
  warn: (...args) => {
    console.warn(...args);
  },
  error: (...args) => {
    console.error(...args);
  },
};

const defaultCreateRegistry = (stateStore?: SkillStateStore): SkillRegistry =>
  new SkillRegistry({ stateStore });
const defaultCreateScanner = (registry: SkillRegistry, skillsDir: string): SkillScanner =>
  new SkillScanner(registry, skillsDir);
const defaultCreateWatcher = (
  registry: SkillRegistry,
  skillsDir: string,
  callbacks?: SkillWatcherCallbacks,
  options?: SkillWatcherOptions,
): SkillWatcher => new SkillWatcher(registry, skillsDir, callbacks, options);
const defaultEnsureSkillsDirectory = async (skillsDir: string): Promise<void> => {
  await mkdir(skillsDir, { recursive: true });
};

export class SkillDaemonService implements DaemonManagedService {
  readonly id = "skills";

  private readonly skillsDir: string;
  private readonly watcherCallbacks?: SkillWatcherCallbacks;
  private readonly watcherOptions?: SkillWatcherOptions;
  private readonly logger: SkillDaemonServiceLogger;
  private readonly stateStore: SkillStateStore;
  private readonly createRegistry: (stateStore?: SkillStateStore) => SkillRegistry;
  private readonly createScanner: (registry: SkillRegistry, skillsDir: string) => SkillScanner;
  private readonly createWatcher: (
    registry: SkillRegistry,
    skillsDir: string,
    callbacks?: SkillWatcherCallbacks,
    options?: SkillWatcherOptions,
  ) => SkillWatcher;
  private readonly ensureSkillsDirectory: (skillsDir: string) => Promise<void>;

  private state: SkillDaemonServiceState = "idle";
  private registry: SkillRegistry | null = null;
  private scanner: SkillScanner | null = null;
  private watcher: SkillWatcher | null = null;
  private lastDiscoveryReport: DiscoveryReport | null = null;

  constructor(options: SkillDaemonServiceOptions) {
    this.skillsDir = options.skillsDir;
    this.watcherCallbacks = options.watcherCallbacks;
    this.watcherOptions = options.watcherOptions;
    this.logger = options.logger ?? defaultLogger;
    this.stateStore = options.stateStore ?? new FileSkillStateStore(join(options.skillsDir, "..", "skill-state.json"));
    this.createRegistry = options.createRegistry ?? defaultCreateRegistry;
    this.createScanner = options.createScanner ?? defaultCreateScanner;
    this.createWatcher = options.createWatcher ?? defaultCreateWatcher;
    this.ensureSkillsDirectory = options.ensureSkillsDirectory ?? defaultEnsureSkillsDirectory;
  }

  getState(): SkillDaemonServiceState {
    return this.state;
  }

  getRegistry(): SkillRegistry | null {
    return this.registry;
  }

  getScanner(): SkillScanner | null {
    return this.scanner;
  }

  getWatcher(): SkillWatcher | null {
    return this.watcher;
  }

  getLastDiscoveryReport(): DiscoveryReport | null {
    return this.lastDiscoveryReport;
  }

  async start(): Promise<DaemonResult<void>> {
    if (!this.canStart()) {
      return err(new DaemonError("Skill service cannot start in current state", "DAEMON_INVALID_STATE"));
    }

    this.state = "starting";

    try {
      await this.ensureSkillsDirectory(this.skillsDir);
      await this.stateStore.load();

      const registry = this.createRegistry(this.stateStore);
      const scanner = this.createScanner(registry, this.skillsDir);
      const report = await scanner.scan();
      const watcher = this.createWatcher(registry, this.skillsDir, this.watcherCallbacks, this.watcherOptions);
      watcher.start();

      this.registry = registry;
      this.scanner = scanner;
      this.watcher = watcher;
      this.lastDiscoveryReport = report;
      this.state = "running";

      if (report.errors.length > 0) {
        for (const scanError of report.errors) {
          this.logger.warn("Skill discovery error", {
            skillDir: scanError.skillDir,
            error: scanError.error,
          });
        }
      }

      this.logger.info("Skill daemon service started", {
        skillsDir: this.skillsDir,
        discovered: report.discovered,
        loaded: report.loaded,
        skipped: report.skipped,
        errors: report.errors.length,
      });

      return ok(undefined);
    } catch (error) {
      this.state = "error";
      return err(this.toDaemonError("Failed to start skill daemon service", "DAEMON_SKILL_START_FAILED", error));
    }
  }

  async stop(_signal?: NodeJS.Signals): Promise<DaemonResult<void>> {
    if (this.state === "idle" || this.state === "stopped") {
      this.state = "stopped";
      return ok(undefined);
    }

    this.state = "stopping";

    try {
      this.watcher?.stop();
      this.watcher = null;
      this.scanner = null;
      this.registry?.clear();
      this.state = "stopped";
      this.logger.info("Skill daemon service stopped");
      return ok(undefined);
    } catch (error) {
      this.state = "error";
      return err(this.toDaemonError("Failed to stop skill daemon service", "DAEMON_SKILL_STOP_FAILED", error));
    }
  }

  private canStart(): boolean {
    return this.state === "idle" || this.state === "stopped";
  }

  private toDaemonError(message: string, code: string, error: unknown): DaemonError {
    if (error instanceof DaemonError) {
      return error;
    }

    if (error instanceof Error) {
      this.logger.error(message, { code, error: error.message });
      return new DaemonError(message, code, error);
    }

    this.logger.error(message, { code, error: String(error) });
    return new DaemonError(message, code);
  }
}

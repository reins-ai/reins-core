import { randomUUID } from "node:crypto";

import { createLogger } from "../logger";
import { readUserConfig, type UserConfig } from "../config";

const log = createLogger("tasks:worker-manager");
import { AgentLoop } from "../harness/agent-loop";
import { PermissionChecker } from "../harness/permissions";
import type { ProviderRegistry } from "../providers";
import { ToolExecutor } from "../tools";
import { ToolRegistry } from "../tools/registry";
import type { TaskRecord } from "./types";
import type { TaskQueue } from "./task-queue";

const DEFAULT_MAX_CONCURRENT_WORKERS = 3;
/** Maximum wall-clock time (ms) a single task worker may run before being aborted. */
const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60 * 1000;

type WorkerAbortReason = "cancelled" | "timeout";

interface WorkerRuntime {
  taskId: string;
  workerId: string;
  abortController: AbortController;
  timeoutId: ReturnType<typeof setTimeout>;
  setAbortReason: (reason: WorkerAbortReason) => void;
  getAbortReason: () => WorkerAbortReason | undefined;
}

export interface WorkerManagerStatus {
  maxConcurrentWorkers: number;
  runningCount: number;
  runningTaskIds: string[];
  pendingTaskIds: string[];
}

export interface WorkerSpawnResult {
  taskId: string;
  status: "running" | "pending" | "already_tracked" | "not_found" | "not_pending";
}

export interface WorkerFactoryContext {
  signal: AbortSignal;
  permissionChecker: PermissionChecker;
}

export interface WorkerRunContext {
  task: TaskRecord;
  providerRegistry: ProviderRegistry;
  permissionChecker: PermissionChecker;
  agentLoop: AgentLoop;
  toolExecutor: ToolExecutor;
  abortSignal: AbortSignal;
}

export interface WorkerManagerOptions {
  maxConcurrentWorkers?: number;
  workerTimeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  readUserConfig?: () => Promise<UserConfig | null>;
  createAgentLoop?: (context: WorkerFactoryContext) => AgentLoop;
  createToolExecutor?: () => ToolExecutor;
  runTask?: (context: WorkerRunContext) => Promise<string>;
}

export class WorkerManager {
  private maxConcurrentWorkers: number;
  private readonly workerTimeoutMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly configLoadPromise: Promise<void>;
  private readonly createAgentLoop: (context: WorkerFactoryContext) => AgentLoop;
  private readonly createToolExecutor: () => ToolExecutor;
  private readonly runTask: (context: WorkerRunContext) => Promise<string>;

  private readonly pendingTaskIds: string[] = [];
  private readonly runningWorkers = new Map<string, WorkerRuntime>();
  private readonly workerPromises = new Map<string, Promise<void>>();

  constructor(
    private readonly queue: TaskQueue,
    private readonly providerRegistry: ProviderRegistry,
    private readonly permissionChecker: PermissionChecker,
    options: WorkerManagerOptions = {},
  ) {
    this.maxConcurrentWorkers = DEFAULT_MAX_CONCURRENT_WORKERS;
    if (typeof options.maxConcurrentWorkers === "number") {
      this.maxConcurrentWorkers = options.maxConcurrentWorkers;
      this.configLoadPromise = Promise.resolve();
    } else {
      this.configLoadPromise = this.loadMaxConcurrentWorkersFromConfig(
        options.readUserConfig,
      );
    }
    this.workerTimeoutMs = options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.createAgentLoop =
      options.createAgentLoop ??
      ((context) =>
        new AgentLoop({
          signal: context.signal,
          permissionChecker: context.permissionChecker,
        }));
    this.createToolExecutor =
      options.createToolExecutor ?? (() => new ToolExecutor(new ToolRegistry()));
    this.runTask = options.runTask ?? this.defaultRunTask;
  }

  async spawn(taskId: string): Promise<WorkerSpawnResult> {
    await this.configLoadPromise;

    if (this.runningWorkers.has(taskId) || this.pendingTaskIds.includes(taskId)) {
      return {
        taskId,
        status: "already_tracked",
      };
    }

    const task = await this.queue.getTask(taskId);
    if (!task) {
      return {
        taskId,
        status: "not_found",
      };
    }

    if (task.status !== "pending") {
      return {
        taskId,
        status: "not_pending",
      };
    }

    this.pendingTaskIds.push(taskId);
    await this.drainQueue();

    return {
      taskId,
      status: this.runningWorkers.has(taskId) ? "running" : "pending",
    };
  }

  cancel(taskId: string): boolean {
    const runtime = this.runningWorkers.get(taskId);
    if (!runtime) {
      return false;
    }

    runtime.setAbortReason("cancelled");
    runtime.abortController.abort("cancelled");
    return true;
  }

  async shutdown(): Promise<void> {
    for (const runtime of this.runningWorkers.values()) {
      runtime.setAbortReason("cancelled");
      runtime.abortController.abort("cancelled");
    }

    this.pendingTaskIds.length = 0;

    await Promise.allSettled(this.workerPromises.values());
  }

  getStatus(): WorkerManagerStatus {
    return {
      maxConcurrentWorkers: this.maxConcurrentWorkers,
      runningCount: this.runningWorkers.size,
      runningTaskIds: Array.from(this.runningWorkers.keys()),
      pendingTaskIds: [...this.pendingTaskIds],
    };
  }

  private async drainQueue(): Promise<void> {
    while (
      this.runningWorkers.size < this.maxConcurrentWorkers &&
      this.pendingTaskIds.length > 0
    ) {
      const nextTaskId = this.pendingTaskIds.shift();
      if (!nextTaskId) {
        break;
      }

      await this.startWorker(nextTaskId);
    }
  }

  private async startWorker(taskId: string): Promise<void> {
    const workerId = randomUUID();
    const startedTask = await this.queue.start(taskId, workerId);
    if (!startedTask) {
      return;
    }

    const abortController = new AbortController();
    let abortReason: WorkerAbortReason | undefined;

    const timeoutId = this.setTimeoutFn(() => {
      abortReason = "timeout";
      abortController.abort("timeout");
    }, this.workerTimeoutMs);

    const runtime: WorkerRuntime = {
      taskId,
      workerId,
      abortController,
      timeoutId,
      setAbortReason: (reason) => {
        abortReason = reason;
      },
      getAbortReason: () => abortReason,
    };

    this.runningWorkers.set(taskId, runtime);
    const workerPromise = this.executeWorker(startedTask, runtime).finally(() => {
      this.workerPromises.delete(taskId);
    });
    this.workerPromises.set(taskId, workerPromise);
  }

  private async executeWorker(task: TaskRecord, runtime: WorkerRuntime): Promise<void> {
    const agentLoop = this.createAgentLoop({
      signal: runtime.abortController.signal,
      permissionChecker: this.permissionChecker,
    });
    const toolExecutor = this.createToolExecutor();

    try {
      const result = await this.runTask({
        task,
        providerRegistry: this.providerRegistry,
        permissionChecker: this.permissionChecker,
        agentLoop,
        toolExecutor,
        abortSignal: runtime.abortController.signal,
      });

      if (runtime.abortController.signal.aborted) {
        await this.queue.fail(task.id, runtime.getAbortReason() ?? "cancelled");
        return;
      }

      await this.queue.complete(task.id, result);
    } catch (error) {
      if (runtime.abortController.signal.aborted) {
        await this.queue.fail(task.id, runtime.getAbortReason() ?? "cancelled");
        return;
      }

      await this.queue.fail(task.id, toErrorMessage(error));
    } finally {
      this.clearTimeoutFn(runtime.timeoutId);
      this.runningWorkers.delete(runtime.taskId);
      await this.drainQueue();
    }
  }

  private async defaultRunTask(context: WorkerRunContext): Promise<string> {
    return `Task ${context.task.id} completed`;
  }

  private async loadMaxConcurrentWorkersFromConfig(
    readUserConfigOverride?: () => Promise<UserConfig | null>,
  ): Promise<void> {
    const readConfig = readUserConfigOverride ?? this.defaultReadUserConfig;
    try {
      const userConfig = await readConfig();
      const configured = userConfig?.tasks?.maxConcurrentWorkers;

      if (
        typeof configured === "number"
        && Number.isInteger(configured)
        && configured > 0
      ) {
        this.maxConcurrentWorkers = configured;
      }
    } catch (e) {
      // Expected: keep default when config read fails
      log.debug("failed to read max workers from config", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async defaultReadUserConfig(): Promise<UserConfig | null> {
    const result = await readUserConfig();
    if (!result.ok) {
      return null;
    }

    return result.value;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "worker failed";
}

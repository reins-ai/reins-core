import type { TaskCreateInput, TaskListOptions, TaskRecord } from "./types";
import type { TaskStore } from "./task-store";

export interface TaskQueueOptions {
  now?: () => Date;
  restartFailureReason?: string;
}

export class TaskQueue {
  private readonly now: () => Date;
  private readonly restartFailureReason: string;

  constructor(
    private readonly store: TaskStore,
    options: TaskQueueOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.restartFailureReason = options.restartFailureReason ?? "daemon restart";
  }

  async enqueue(input: TaskCreateInput): Promise<TaskRecord> {
    return this.store.createTask(input);
  }

  async dequeue(workerId?: string): Promise<TaskRecord | null> {
    const pendingTasks = await this.store.listTasks({ status: "pending" });

    for (let index = pendingTasks.length - 1; index >= 0; index -= 1) {
      const task = pendingTasks[index];
      if (!task) {
        continue;
      }

      const runningTask = await this.store.updateTask(
        task.id,
        {
          status: "running",
          startedAt: this.now(),
          workerId,
        },
        { expectedStatus: "pending" },
      );

      if (runningTask) {
        return runningTask;
      }
    }

    return null;
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    return this.store.getTask(id);
  }

  async start(id: string, workerId?: string): Promise<TaskRecord | null> {
    return this.store.updateTask(
      id,
      {
        status: "running",
        startedAt: this.now(),
        workerId,
      },
      { expectedStatus: "pending" },
    );
  }

  async complete(id: string, result: string): Promise<TaskRecord | null> {
    return this.store.updateTask(
      id,
      {
        status: "complete",
        result,
        completedAt: this.now(),
        delivered: false,
      },
      { expectedStatus: "running" },
    );
  }

  async fail(id: string, error: string): Promise<TaskRecord | null> {
    return this.store.updateTask(
      id,
      {
        status: "failed",
        error,
        completedAt: this.now(),
      },
      { expectedStatus: "running" },
    );
  }

  async retry(id: string): Promise<TaskRecord | null> {
    const sourceTask = await this.store.getTask(id);
    if (!sourceTask || sourceTask.status !== "failed") {
      return null;
    }

    return this.store.createTask({
      prompt: sourceTask.prompt,
      conversationId: sourceTask.conversationId,
    });
  }

  async list(options?: TaskListOptions): Promise<TaskRecord[]> {
    return this.store.listTasks(options);
  }

  async recoverFromRestart(): Promise<number> {
    return this.store.failRunningTasks(this.restartFailureReason);
  }
}

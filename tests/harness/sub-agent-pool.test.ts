import { describe, expect, it } from "bun:test";

import { SubAgentPool, type AgentLoopFactory, type SubAgentTask } from "../../src/harness/sub-agent-pool";
import { DoomLoopGuard } from "../../src/harness/doom-loop-guard";
import type { AgentLoopOptions, LoopTerminationReason } from "../../src/harness/agent-loop";

interface MockBehavior {
  delayMs?: number;
  fail?: boolean;
  output?: string;
  stepsUsed?: number;
  terminationReason?: LoopTerminationReason;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createTasks(count: number): SubAgentTask[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `task-${index + 1}`,
    prompt: `prompt-${index + 1}`,
  }));
}

function createFactory(
  behaviorByTaskId: Record<string, MockBehavior>,
  onOptions?: (taskId: string, options: AgentLoopOptions) => void,
): AgentLoopFactory {
  return (options) => ({
    async runTask(task, signal) {
      onOptions?.(task.id, options);
      const behavior = behaviorByTaskId[task.id] ?? {};
      const delayMs = behavior.delayMs ?? 0;

      if (delayMs > 0) {
        await sleep(delayMs);
      }

      if (signal.aborted) {
        throw new Error("Aborted");
      }

      if (behavior.fail) {
        throw new Error(`Task failed: ${task.id}`);
      }

      return {
        output: behavior.output ?? `output-${task.id}`,
        stepsUsed: behavior.stepsUsed ?? 1,
        terminationReason: behavior.terminationReason ?? "text_only_response",
      };
    },
  });
}

async function runPoolAndCaptureMaxActive(
  tasks: SubAgentTask[],
  poolOptions: ConstructorParameters<typeof SubAgentPool>[0],
): Promise<{ maxActive: number }> {
  let active = 0;
  let maxActive = 0;

  const pool = new SubAgentPool({
    ...poolOptions,
    agentLoopFactory: () => ({
      async runTask(task, signal) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(40);
        active -= 1;

        if (signal.aborted) {
          throw new Error("Aborted");
        }

        return {
          output: `done-${task.id}`,
          stepsUsed: 1,
          terminationReason: "text_only_response",
        };
      },
    }),
  });

  const results = await pool.runAll(tasks);
  expect(results.every((result) => result.error === undefined)).toBe(true);

  return { maxActive };
}

describe("SubAgentPool", () => {
  it("completes tasks in parallel and returns all successful results", async () => {
    const tasks = createTasks(5);
    const behavior = Object.fromEntries(tasks.map((task) => [task.id, { delayMs: 50 }])) as Record<string, MockBehavior>;

    const pool = new SubAgentPool({
      agentLoopFactory: createFactory(behavior),
    });

    const startedAt = Date.now();
    const results = await pool.runAll(tasks);
    const elapsedMs = Date.now() - startedAt;

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.error === undefined)).toBe(true);
    expect(results.every((result) => typeof result.output === "string")).toBe(true);
    expect(elapsedMs).toBeLessThan(200);
  });

  it("returns partial results when some tasks fail", async () => {
    const tasks = createTasks(5);
    const behavior: Record<string, MockBehavior> = {
      "task-1": { output: "ok-1" },
      "task-2": { fail: true },
      "task-3": { output: "ok-3" },
      "task-4": { fail: true },
      "task-5": { output: "ok-5" },
    };

    const pool = new SubAgentPool({
      agentLoopFactory: createFactory(behavior),
    });

    await expect(pool.runAll(tasks)).resolves.toHaveLength(5);
    const results = await pool.runAll(tasks);

    const successful = results.filter((result) => result.error === undefined);
    const failed = results.filter((result) => result.error instanceof Error);

    expect(successful).toHaveLength(3);
    expect(failed).toHaveLength(2);
    expect(failed.every((result) => result.terminationReason === "error")).toBe(true);
  });

  it("propagates parent abort to all children within 500ms", async () => {
    const taskCounts = [1, 3, 5];

    for (const count of taskCounts) {
      const tasks = createTasks(count);
      const controller = new AbortController();
      const abortedAtByTaskId = new Map<string, number>();

      const pool = new SubAgentPool({
        signal: controller.signal,
        agentLoopFactory: () => ({
          async runTask(task, signal) {
            await new Promise<never>((_resolve, reject) => {
              const timer = setTimeout(() => {
                reject(new Error(`Timed out waiting for abort for ${task.id}`));
              }, 2000);

              if (signal.aborted) {
                clearTimeout(timer);
                abortedAtByTaskId.set(task.id, Date.now());
                reject(new Error("Aborted"));
                return;
              }

              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  abortedAtByTaskId.set(task.id, Date.now());
                  reject(new Error("Aborted"));
                },
                { once: true },
              );
            });
          },
        }),
      });

      const runPromise = pool.runAll(tasks);
      await sleep(50);
      const parentAbortedAt = Date.now();
      controller.abort("cancelled-by-parent");

      const results = await runPromise;

      expect(results).toHaveLength(count);
      expect(results.every((result) => result.terminationReason === "aborted")).toBe(true);
      expect(results.every((result) => result.error instanceof Error)).toBe(true);

      for (const task of tasks) {
        const abortedAt = abortedAtByTaskId.get(task.id);
        expect(abortedAt).toBeDefined();
        expect((abortedAt ?? parentAbortedAt) - parentAbortedAt).toBeLessThanOrEqual(500);
      }
    }
  });

  it("enforces maxConcurrent via semaphore queueing", async () => {
    const tasks = createTasks(5);
    let active = 0;
    let maxActive = 0;

    const pool = new SubAgentPool({
      maxConcurrent: 2,
      agentLoopFactory: () => ({
        async runTask(task, signal) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(60);
          active -= 1;

          if (signal.aborted) {
            throw new Error("Aborted");
          }

          return {
            output: `done-${task.id}`,
            stepsUsed: 2,
            terminationReason: "text_only_response",
          };
        },
      }),
    });

    const results = await pool.runAll(tasks);

    expect(results).toHaveLength(5);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results.every((result) => result.error === undefined)).toBe(true);
  });

  it("injects per-child DoomLoopGuard and forwards maxSteps to loop factory", async () => {
    const tasks: SubAgentTask[] = [
      { id: "task-a", prompt: "A", maxSteps: 3 },
      { id: "task-b", prompt: "B", maxSteps: 8 },
      { id: "task-c", prompt: "C" },
    ];

    const seenOptions = new Map<string, AgentLoopOptions>();

    const pool = new SubAgentPool({
      agentLoopFactory: createFactory(
        {
          "task-a": { stepsUsed: 3, terminationReason: "max_steps_reached" },
          "task-b": { stepsUsed: 8, terminationReason: "max_steps_reached" },
          "task-c": { stepsUsed: 1, terminationReason: "text_only_response" },
        },
        (taskId, options) => {
          seenOptions.set(taskId, options);
        },
      ),
    });

    const results = await pool.runAll(tasks);

    expect(results).toHaveLength(3);
    expect(results[0]?.stepsUsed).toBe(3);
    expect(results[0]?.terminationReason).toBe("max_steps_reached");

    const guards = tasks
      .map((task) => seenOptions.get(task.id)?.doomLoopGuard)
      .filter((guard): guard is DoomLoopGuard => guard instanceof DoomLoopGuard);

    expect(guards).toHaveLength(3);
    expect(new Set(guards).size).toBe(3);
    expect(seenOptions.get("task-a")?.maxSteps).toBe(3);
    expect(seenOptions.get("task-b")?.maxSteps).toBe(8);
    expect(seenOptions.get("task-c")?.maxSteps).toBeUndefined();
  });

  it("returns empty output for empty task list and defaults invalid maxConcurrent", async () => {
    const emptyPool = new SubAgentPool();
    await expect(emptyPool.runAll([])).resolves.toEqual([]);

    const tasks = createTasks(2);
    const pool = new SubAgentPool({
      maxConcurrent: 0,
      agentLoopFactory: createFactory({
        "task-1": { output: "ok-1" },
        "task-2": { output: "ok-2" },
      }),
    });

    const results = await pool.runAll(tasks);
    expect(results.every((result) => result.error === undefined)).toBe(true);
  });

  it("tier: Free workspace limits to 2 concurrent", async () => {
    const tasks = createTasks(6);
    const { maxActive } = await runPoolAndCaptureMaxActive(tasks, {
      tier: "free",
    });

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBe(2);
  });

  it("tier: Pro workspace limits to 5 concurrent", async () => {
    const tasks = createTasks(8);
    const { maxActive } = await runPoolAndCaptureMaxActive(tasks, {
      tier: "pro",
    });

    expect(maxActive).toBeLessThanOrEqual(5);
    expect(maxActive).toBe(5);
  });

  it("tier: Team workspace limits to 15 concurrent", async () => {
    const tasks = createTasks(20);
    const { maxActive } = await runPoolAndCaptureMaxActive(tasks, {
      tier: "team",
    });

    expect(maxActive).toBeLessThanOrEqual(15);
    expect(maxActive).toBe(15);
  });

  it("tier: explicit maxConcurrent overrides tier", async () => {
    const tasks = createTasks(12);
    const { maxActive } = await runPoolAndCaptureMaxActive(tasks, {
      tier: "free",
      maxConcurrent: 10,
    });

    expect(maxActive).toBeLessThanOrEqual(10);
    expect(maxActive).toBe(10);
  });

  it("tier: tasks beyond limit are queued, not rejected", async () => {
    const tasks = createTasks(5);
    let active = 0;
    let maxActive = 0;

    const pool = new SubAgentPool({
      tier: "free",
      agentLoopFactory: () => ({
        async runTask(task, signal) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(50);
          active -= 1;

          if (signal.aborted) {
            throw new Error("Aborted");
          }

          return {
            output: `queued-${task.id}`,
            stepsUsed: 1,
            terminationReason: "text_only_response",
          };
        },
      }),
    });

    const results = await pool.runAll(tasks);

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.error === undefined)).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("uses default AgentLoop factory when no factory is supplied", async () => {
    const pool = new SubAgentPool();
    const task: SubAgentTask = {
      id: "default-task",
      prompt: "echo output",
      maxSteps: 2,
    };

    const [result] = await pool.runAll([task]);

    expect(result?.id).toBe("default-task");
    expect(result?.output).toBe("echo output");
    expect(result?.terminationReason).toBe("text_only_response");
    expect(result?.error).toBeUndefined();
  });
});

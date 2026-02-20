import type { TaskQueue } from "./task-queue";
import type { TaskRecord } from "./types";

export interface TaskCommandResult {
  success: boolean;
  taskId?: string;
  message: string;
  task?: TaskRecord;
}

/**
 * Handles the `/task <description>` command.
 *
 * Always creates a background task — bypasses the heuristic classifier.
 * The description is used as the task prompt verbatim.
 */
export async function handleTaskCommand(
  input: string,
  taskQueue: TaskQueue,
  conversationId?: string,
): Promise<TaskCommandResult> {
  const description = input.trim();

  if (!description) {
    return {
      success: false,
      message: "Please provide a task description. Usage: /task <description>",
    };
  }

  const task = await taskQueue.enqueue({
    prompt: description,
    conversationId,
  });

  return {
    success: true,
    taskId: task.id,
    message: `Task queued (${task.id}): ${description}`,
    task,
  };
}

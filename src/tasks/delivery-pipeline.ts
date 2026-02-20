import type { ChannelRegistry } from "../channels/registry";
import type { Channel, ChannelMessage } from "../channels/types";
import type { TaskStore } from "./task-store";
import type { TaskRecord } from "./types";

export type TaskDeliveryMethod = "tui" | "channel" | "badge";

export interface TaskDeliveryAssistantMessage {
  taskId: string;
  conversationId?: string;
  content: string;
}

export interface TaskDeliveryWebSocketTransport {
  isConnected(): boolean;
  sendAssistantMessage(message: TaskDeliveryAssistantMessage): Promise<void>;
}

export interface TaskDeliveryReport {
  taskId: string;
  delivered: boolean;
  method: TaskDeliveryMethod;
  channelSuccessCount: number;
  channelFailureCount: number;
}

export interface TaskDeliveryPipelineOptions {
  wsTransport?: TaskDeliveryWebSocketTransport;
  now?: () => Date;
}

function formatAssistantMessage(result: string): string {
  return `Background task complete:\n\n${result}`;
}

function buildChannelMessage(
  task: TaskRecord,
  channel: Channel,
  result: string,
  timestamp: Date,
): ChannelMessage {
  return {
    id: crypto.randomUUID(),
    platform: channel.config.platform,
    channelId: channel.config.id,
    conversationId: task.conversationId,
    sender: {
      id: "reins-system",
      displayName: "Reins",
      isBot: true,
    },
    timestamp,
    text: formatAssistantMessage(result),
  };
}

async function sendToChannel(task: TaskRecord, channel: Channel, result: string, timestamp: Date): Promise<boolean> {
  try {
    await channel.send(buildChannelMessage(task, channel, result, timestamp));
    return true;
  } catch {
    return false;
  }
}

export class TaskDeliveryPipeline {
  private readonly wsTransport: TaskDeliveryWebSocketTransport | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly taskStore: TaskStore,
    private readonly channelRegistry: ChannelRegistry,
    options: TaskDeliveryPipelineOptions = {},
  ) {
    this.wsTransport = options.wsTransport;
    this.now = options.now ?? (() => new Date());
  }

  async deliver(taskId: string, result: string): Promise<TaskDeliveryReport> {
    const task = await this.taskStore.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== "complete") {
      throw new Error(`Task ${taskId} must be complete before delivery`);
    }

    const persistedTask = await this.taskStore.updateTask(taskId, {
      result,
      delivered: false,
      completedAt: task.completedAt ?? this.now(),
    });

    if (!persistedTask) {
      throw new Error(`Failed to persist result for task: ${taskId}`);
    }

    if (this.wsTransport?.isConnected()) {
      await this.wsTransport.sendAssistantMessage({
        taskId,
        conversationId: persistedTask.conversationId,
        content: formatAssistantMessage(result),
      });

      await this.taskStore.updateTask(taskId, { delivered: true });
      return {
        taskId,
        delivered: true,
        method: "tui",
        channelSuccessCount: 0,
        channelFailureCount: 0,
      };
    }

    const enabledChannels = this.channelRegistry.list().filter((channel) => channel.config.enabled);
    if (enabledChannels.length > 0) {
      let successCount = 0;

      for (const channel of enabledChannels) {
        const sent = await sendToChannel(persistedTask, channel, result, this.now());
        if (sent) {
          successCount += 1;
        }
      }

      const failureCount = enabledChannels.length - successCount;
      const delivered = successCount > 0;
      await this.taskStore.updateTask(taskId, { delivered });

      return {
        taskId,
        delivered,
        method: delivered ? "channel" : "badge",
        channelSuccessCount: successCount,
        channelFailureCount: failureCount,
      };
    }

    await this.taskStore.updateTask(taskId, { delivered: false });
    return {
      taskId,
      delivered: false,
      method: "badge",
      channelSuccessCount: 0,
      channelFailureCount: 0,
    };
  }

  async getBadgeCount(): Promise<number> {
    return this.taskStore.countUndeliveredCompleted();
  }
}

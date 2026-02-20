export type TaskStatus = "pending" | "running" | "complete" | "failed";

export interface TaskRecord {
  id: string;
  prompt: string;
  status: TaskStatus;
  result?: string;
  error?: string;
  conversationId?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  workerId?: string;
  delivered: boolean;
}

export interface TaskCreateInput {
  prompt: string;
  conversationId?: string;
  createdAt?: Date;
}

export interface TaskUpdateInput {
  prompt?: string;
  status?: TaskStatus;
  result?: string;
  error?: string;
  conversationId?: string;
  startedAt?: Date;
  completedAt?: Date;
  workerId?: string;
  delivered?: boolean;
}

export interface TaskListOptions {
  status?: TaskStatus;
  limit?: number;
  offset?: number;
}

export interface TaskUpdateOptions {
  expectedStatus?: TaskStatus;
}

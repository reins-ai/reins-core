import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentWorkspaceOptions {
  baseDir?: string;
}

const DEFAULT_SUBDIRECTORIES = ["memory"] as const;

export class AgentWorkspaceManager {
  private readonly baseDir: string;

  constructor(options?: AgentWorkspaceOptions) {
    this.baseDir = options?.baseDir ?? join(homedir(), ".reins", "agents");
  }

  resolveWorkspacePath(agentId: string): string {
    return join(this.baseDir, agentId);
  }

  async createWorkspace(agentId: string): Promise<string> {
    const workspacePath = this.resolveWorkspacePath(agentId);

    await mkdir(workspacePath, { recursive: true });

    for (const subdir of DEFAULT_SUBDIRECTORIES) {
      await mkdir(join(workspacePath, subdir), { recursive: true });
    }

    return workspacePath;
  }

  async removeWorkspace(agentId: string): Promise<void> {
    const workspacePath = this.resolveWorkspacePath(agentId);
    await rm(workspacePath, { recursive: true, force: true });
  }

  async workspaceExists(agentId: string): Promise<boolean> {
    const workspacePath = this.resolveWorkspacePath(agentId);

    try {
      const info = await stat(workspacePath);
      return info.isDirectory();
    } catch {
      return false;
    }
  }
}

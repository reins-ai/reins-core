import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentWorkspaceManager } from "../../src/agents/workspace";

let tmpDir: string;
let manager: AgentWorkspaceManager;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "reins-workspace-test-"));
  manager = new AgentWorkspaceManager({ baseDir: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("AgentWorkspaceManager", () => {
  describe("resolveWorkspacePath", () => {
    it("returns correct absolute path for given agentId", () => {
      const result = manager.resolveWorkspacePath("test-agent");
      expect(result).toBe(join(tmpDir, "test-agent"));
    });
  });

  describe("createWorkspace", () => {
    it("creates directory at resolved path", async () => {
      await manager.createWorkspace("agent-one");

      const workspacePath = join(tmpDir, "agent-one");
      const info = await stat(workspacePath);
      expect(info.isDirectory()).toBe(true);
    });

    it("creates memory subdirectory inside workspace", async () => {
      await manager.createWorkspace("agent-one");

      const memoryPath = join(tmpDir, "agent-one", "memory");
      const info = await stat(memoryPath);
      expect(info.isDirectory()).toBe(true);
    });

    it("returns the absolute workspace path", async () => {
      const result = await manager.createWorkspace("agent-one");
      expect(result).toBe(join(tmpDir, "agent-one"));
    });

    it("is idempotent — calling twice does not throw", async () => {
      await manager.createWorkspace("agent-one");
      const second = await manager.createWorkspace("agent-one");
      expect(second).toBe(join(tmpDir, "agent-one"));
    });
  });

  describe("workspaceExists", () => {
    it("returns true after createWorkspace", async () => {
      await manager.createWorkspace("agent-one");
      const exists = await manager.workspaceExists("agent-one");
      expect(exists).toBe(true);
    });

    it("returns false before createWorkspace", async () => {
      const exists = await manager.workspaceExists("nonexistent");
      expect(exists).toBe(false);
    });
  });

  describe("removeWorkspace", () => {
    it("directory no longer exists after removal", async () => {
      await manager.createWorkspace("agent-one");
      await manager.removeWorkspace("agent-one");

      const exists = await manager.workspaceExists("agent-one");
      expect(exists).toBe(false);
    });

    it("is idempotent — no error if already removed", async () => {
      await manager.removeWorkspace("nonexistent");
      const exists = await manager.workspaceExists("nonexistent");
      expect(exists).toBe(false);
    });
  });
});

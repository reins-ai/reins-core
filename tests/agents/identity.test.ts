import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IdentityFileManager } from "../../src/agents/identity";
import type { Agent } from "../../src/agents/types";

function makeMockAgent(workspacePath: string): Agent {
  return {
    id: "agent-eleanor",
    name: "Eleanor",
    role: "Chief of Staff",
    workspacePath,
    skills: [],
    identityFiles: { custom: {} },
    metadata: {
      createdAt: "2026-02-21T10:00:00.000Z",
      updatedAt: "2026-02-21T10:00:00.000Z",
      source: "test",
    },
  };
}

async function withTempDir(
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "reins-identity-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("IdentityFileManager", () => {
  describe("generateIdentityFiles", () => {
    test("creates SOUL.md in agent workspace", async () => {
      await withTempDir(async (dir) => {
        const workspace = join(dir, "workspace");
        await mkdir(workspace, { recursive: true });

        const manager = new IdentityFileManager();
        const agent = makeMockAgent(workspace);
        await manager.generateIdentityFiles(agent);

        const file = Bun.file(join(workspace, "SOUL.md"));
        expect(await file.exists()).toBe(true);
      });
    });

    test("creates MEMORY.md in agent workspace", async () => {
      await withTempDir(async (dir) => {
        const workspace = join(dir, "workspace");
        await mkdir(workspace, { recursive: true });

        const manager = new IdentityFileManager();
        const agent = makeMockAgent(workspace);
        await manager.generateIdentityFiles(agent);

        const file = Bun.file(join(workspace, "MEMORY.md"));
        expect(await file.exists()).toBe(true);
      });
    });

    test("creates IDENTITY.md in agent workspace", async () => {
      await withTempDir(async (dir) => {
        const workspace = join(dir, "workspace");
        await mkdir(workspace, { recursive: true });

        const manager = new IdentityFileManager();
        const agent = makeMockAgent(workspace);
        await manager.generateIdentityFiles(agent);

        const file = Bun.file(join(workspace, "IDENTITY.md"));
        expect(await file.exists()).toBe(true);
      });
    });

    test("returns AgentIdentityFiles with correct absolute paths", async () => {
      await withTempDir(async (dir) => {
        const workspace = join(dir, "workspace");
        await mkdir(workspace, { recursive: true });

        const manager = new IdentityFileManager();
        const agent = makeMockAgent(workspace);
        const result = await manager.generateIdentityFiles(agent);

        expect(result.soul).toBe(join(workspace, "SOUL.md"));
        expect(result.memory).toBe(join(workspace, "MEMORY.md"));
        expect(result.identity).toBe(join(workspace, "IDENTITY.md"));
        expect(result.custom).toEqual({});
      });
    });

    test("substitutes agent.name in SOUL.md content", async () => {
      await withTempDir(async (dir) => {
        const workspace = join(dir, "workspace");
        await mkdir(workspace, { recursive: true });

        const manager = new IdentityFileManager();
        const agent = makeMockAgent(workspace);
        await manager.generateIdentityFiles(agent);

        const content = await Bun.file(join(workspace, "SOUL.md")).text();
        expect(content).toContain("# Eleanor — Soul Document");
        expect(content).toContain("You are Eleanor, a specialized AI assistant");
      });
    });

    test("substitutes agent.role in SOUL.md content", async () => {
      await withTempDir(async (dir) => {
        const workspace = join(dir, "workspace");
        await mkdir(workspace, { recursive: true });

        const manager = new IdentityFileManager();
        const agent = makeMockAgent(workspace);
        await manager.generateIdentityFiles(agent);

        const content = await Bun.file(join(workspace, "SOUL.md")).text();
        expect(content).toContain("**Role:** Chief of Staff");
        expect(content).toContain("serving as Chief of Staff");
      });
    });

    test("substitutes agent.id and createdAt in IDENTITY.md", async () => {
      await withTempDir(async (dir) => {
        const workspace = join(dir, "workspace");
        await mkdir(workspace, { recursive: true });

        const manager = new IdentityFileManager();
        const agent = makeMockAgent(workspace);
        await manager.generateIdentityFiles(agent);

        const content = await Bun.file(join(workspace, "IDENTITY.md")).text();
        expect(content).toContain("**Agent ID:** agent-eleanor");
        expect(content).toContain("**Created:** 2026-02-21T10:00:00.000Z");
        expect(content).toContain(`\`${workspace}\``);
      });
    });

    test("substitutes fields in MEMORY.md content", async () => {
      await withTempDir(async (dir) => {
        const workspace = join(dir, "workspace");
        await mkdir(workspace, { recursive: true });

        const manager = new IdentityFileManager();
        const agent = makeMockAgent(workspace);
        await manager.generateIdentityFiles(agent);

        const content = await Bun.file(join(workspace, "MEMORY.md")).text();
        expect(content).toContain("# Eleanor — Memory");
        expect(content).toContain("**Agent:** Eleanor");
        expect(content).toContain("**Role:** Chief of Staff");
        expect(content).toContain("**Initialized:** 2026-02-21T10:00:00.000Z");
      });
    });
  });

  describe("readIdentityFile", () => {
    test("reads existing file and returns content", async () => {
      await withTempDir(async (dir) => {
        const workspace = join(dir, "workspace");
        await mkdir(workspace, { recursive: true });
        await Bun.write(join(workspace, "SOUL.md"), "soul content");

        const manager = new IdentityFileManager();
        const content = await manager.readIdentityFile(workspace, "SOUL.md");

        expect(content).toBe("soul content");
      });
    });

    test("returns null for non-existent file", async () => {
      await withTempDir(async (dir) => {
        const workspace = join(dir, "workspace");
        await mkdir(workspace, { recursive: true });

        const manager = new IdentityFileManager();
        const content = await manager.readIdentityFile(workspace, "MISSING.md");

        expect(content).toBeNull();
      });
    });
  });

  describe("writeIdentityFile", () => {
    test("writes custom file and returns absolute path", async () => {
      await withTempDir(async (dir) => {
        const workspace = join(dir, "workspace");
        await mkdir(workspace, { recursive: true });

        const manager = new IdentityFileManager();
        const path = await manager.writeIdentityFile(
          workspace,
          "custom.md",
          "custom content",
        );

        expect(path).toBe(join(workspace, "custom.md"));
      });
    });

    test("custom file is readable after write", async () => {
      await withTempDir(async (dir) => {
        const workspace = join(dir, "workspace");
        await mkdir(workspace, { recursive: true });

        const manager = new IdentityFileManager();
        await manager.writeIdentityFile(
          workspace,
          "custom.md",
          "custom content here",
        );

        const content = await manager.readIdentityFile(workspace, "custom.md");
        expect(content).toBe("custom content here");
      });
    });
  });
});

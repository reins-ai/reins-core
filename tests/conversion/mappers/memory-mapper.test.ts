import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { AgentWorkspaceManager } from "../../../src/agents/workspace";
import { MemoryMapper } from "../../../src/conversion/mappers/memory-mapper";
import type { WorkspaceMapping } from "../../../src/conversion/mappers/memory-mapper";

const TEST_BASE = join("/tmp", `reins-test-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const SOURCE_DIR = join(TEST_BASE, "openclaw-workspaces");
const DEST_DIR = join(TEST_BASE, "reins-agents");

let workspaceManager: AgentWorkspaceManager;
let mapper: MemoryMapper;

beforeEach(async () => {
  await mkdir(SOURCE_DIR, { recursive: true });
  await mkdir(DEST_DIR, { recursive: true });

  workspaceManager = new AgentWorkspaceManager({ baseDir: DEST_DIR });
  mapper = new MemoryMapper(workspaceManager);
});

afterEach(async () => {
  await rm(TEST_BASE, { recursive: true, force: true });
});

describe("MemoryMapper", () => {
  it("copies a single .md file from source to destination", async () => {
    const agentSrc = join(SOURCE_DIR, "agent-a");
    await mkdir(agentSrc, { recursive: true });
    await Bun.write(join(agentSrc, "MEMORY.md"), "# Agent A Memory");

    const mappings: WorkspaceMapping[] = [
      { openClawPath: agentSrc, reinsAgentId: "agent-a" },
    ];

    const result = await mapper.map(mappings);

    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    const destFile = join(DEST_DIR, "agent-a", "MEMORY.md");
    const content = await Bun.file(destFile).text();
    expect(content).toBe("# Agent A Memory");
  });

  it("preserves directory structure for nested .md files", async () => {
    const agentSrc = join(SOURCE_DIR, "agent-b");
    const memoryDir = join(agentSrc, "memory");
    await mkdir(memoryDir, { recursive: true });
    await Bun.write(join(agentSrc, "MEMORY.md"), "# Root memory");
    await Bun.write(join(memoryDir, "notes.md"), "# Notes");
    await Bun.write(join(memoryDir, "decisions.md"), "# Decisions");

    const mappings: WorkspaceMapping[] = [
      { openClawPath: agentSrc, reinsAgentId: "agent-b" },
    ];

    const result = await mapper.map(mappings);

    expect(result.converted).toBe(3);
    expect(result.errors).toHaveLength(0);

    const rootContent = await Bun.file(join(DEST_DIR, "agent-b", "MEMORY.md")).text();
    expect(rootContent).toBe("# Root memory");

    const notesContent = await Bun.file(join(DEST_DIR, "agent-b", "memory", "notes.md")).text();
    expect(notesContent).toBe("# Notes");

    const decisionsContent = await Bun.file(join(DEST_DIR, "agent-b", "memory", "decisions.md")).text();
    expect(decisionsContent).toBe("# Decisions");
  });

  it("skips non-.md files", async () => {
    const agentSrc = join(SOURCE_DIR, "agent-c");
    await mkdir(agentSrc, { recursive: true });
    await Bun.write(join(agentSrc, "MEMORY.md"), "# Memory");
    await Bun.write(join(agentSrc, "data.json"), '{"key": "value"}');
    await Bun.write(join(agentSrc, "script.ts"), "console.log('hi')");

    const mappings: WorkspaceMapping[] = [
      { openClawPath: agentSrc, reinsAgentId: "agent-c" },
    ];

    const result = await mapper.map(mappings);

    expect(result.converted).toBe(1);

    const destEntries = await readdir(join(DEST_DIR, "agent-c"));
    expect(destEntries).toEqual(["MEMORY.md"]);
  });

  it("handles multiple workspace mappings", async () => {
    const srcA = join(SOURCE_DIR, "agent-a");
    const srcB = join(SOURCE_DIR, "agent-b");
    await mkdir(srcA, { recursive: true });
    await mkdir(srcB, { recursive: true });
    await Bun.write(join(srcA, "MEMORY.md"), "# A");
    await Bun.write(join(srcB, "SOUL.md"), "# B Soul");
    await Bun.write(join(srcB, "IDENTITY.md"), "# B Identity");

    const mappings: WorkspaceMapping[] = [
      { openClawPath: srcA, reinsAgentId: "agent-a" },
      { openClawPath: srcB, reinsAgentId: "agent-b" },
    ];

    const result = await mapper.map(mappings);

    expect(result.converted).toBe(3);
    expect(result.errors).toHaveLength(0);

    const contentA = await Bun.file(join(DEST_DIR, "agent-a", "MEMORY.md")).text();
    expect(contentA).toBe("# A");

    const contentB = await Bun.file(join(DEST_DIR, "agent-b", "SOUL.md")).text();
    expect(contentB).toBe("# B Soul");
  });

  it("records error when source directory does not exist", async () => {
    const mappings: WorkspaceMapping[] = [
      { openClawPath: join(SOURCE_DIR, "nonexistent"), reinsAgentId: "agent-x" },
    ];

    const result = await mapper.map(mappings);

    expect(result.converted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].item).toContain("nonexistent");
    expect(result.errors[0].reason).toBe("Source workspace directory does not exist");
  });

  it("skips workspace with no .md files", async () => {
    const agentSrc = join(SOURCE_DIR, "agent-empty");
    await mkdir(agentSrc, { recursive: true });
    await Bun.write(join(agentSrc, "data.json"), "{}");

    const mappings: WorkspaceMapping[] = [
      { openClawPath: agentSrc, reinsAgentId: "agent-empty" },
    ];

    const result = await mapper.map(mappings);

    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("invokes onProgress callback for each mapping", async () => {
    const srcA = join(SOURCE_DIR, "agent-a");
    const srcB = join(SOURCE_DIR, "agent-b");
    await mkdir(srcA, { recursive: true });
    await mkdir(srcB, { recursive: true });
    await Bun.write(join(srcA, "MEMORY.md"), "# A");
    await Bun.write(join(srcB, "MEMORY.md"), "# B");

    const progressCalls: Array<[number, number]> = [];

    const mappings: WorkspaceMapping[] = [
      { openClawPath: srcA, reinsAgentId: "agent-a" },
      { openClawPath: srcB, reinsAgentId: "agent-b" },
    ];

    await mapper.map(mappings, {
      onProgress: (processed, total) => {
        progressCalls.push([processed, total]);
      },
    });

    expect(progressCalls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("does not write files in dryRun mode", async () => {
    const agentSrc = join(SOURCE_DIR, "agent-dry");
    await mkdir(agentSrc, { recursive: true });
    await Bun.write(join(agentSrc, "MEMORY.md"), "# Dry run");

    const mappings: WorkspaceMapping[] = [
      { openClawPath: agentSrc, reinsAgentId: "agent-dry" },
    ];

    const result = await mapper.map(mappings, { dryRun: true });

    expect(result.converted).toBe(1);
    expect(result.errors).toHaveLength(0);

    const destFile = Bun.file(join(DEST_DIR, "agent-dry", "MEMORY.md"));
    expect(destFile.size).toBe(0);
  });

  it("handles deeply nested directory structures", async () => {
    const agentSrc = join(SOURCE_DIR, "agent-deep");
    const deepDir = join(agentSrc, "memory", "projects", "alpha");
    await mkdir(deepDir, { recursive: true });
    await Bun.write(join(deepDir, "notes.md"), "# Deep notes");

    const mappings: WorkspaceMapping[] = [
      { openClawPath: agentSrc, reinsAgentId: "agent-deep" },
    ];

    const result = await mapper.map(mappings);

    expect(result.converted).toBe(1);

    const content = await Bun.file(
      join(DEST_DIR, "agent-deep", "memory", "projects", "alpha", "notes.md"),
    ).text();
    expect(content).toBe("# Deep notes");
  });

  it("returns empty result for empty mappings array", async () => {
    const result = await mapper.map([]);

    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("preserves binary content in .md files", async () => {
    const agentSrc = join(SOURCE_DIR, "agent-binary");
    await mkdir(agentSrc, { recursive: true });

    const binaryContent = new Uint8Array([0x23, 0x20, 0xc3, 0xa9, 0xc3, 0xa0, 0xc3, 0xbc, 0x0a]);
    await Bun.write(join(agentSrc, "unicode.md"), binaryContent);

    const mappings: WorkspaceMapping[] = [
      { openClawPath: agentSrc, reinsAgentId: "agent-binary" },
    ];

    const result = await mapper.map(mappings);

    expect(result.converted).toBe(1);

    const destContent = await Bun.file(join(DEST_DIR, "agent-binary", "unicode.md")).arrayBuffer();
    expect(new Uint8Array(destContent)).toEqual(binaryContent);
  });
});

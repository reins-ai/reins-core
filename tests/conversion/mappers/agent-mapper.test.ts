import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentStore } from "../../../src/agents/store";
import { IdentityFileManager } from "../../../src/agents/identity";
import { AgentWorkspaceManager } from "../../../src/agents/workspace";
import type { OpenClawAgentConfig } from "../../../src/conversion/types";
import {
  AgentMapper,
  type AgentMapperFileCopier,
} from "../../../src/conversion/mappers/agent-mapper";

let tempDir: string;
let store: AgentStore;
let workspaceManager: AgentWorkspaceManager;
let identityManager: IdentityFileManager;

function makeMockFileCopier(
  files: Record<string, string> = {},
): AgentMapperFileCopier & { copied: Array<{ src: string; dest: string }> } {
  const copied: Array<{ src: string; dest: string }> = [];
  return {
    copied,
    async copy(srcPath: string, destPath: string): Promise<void> {
      copied.push({ src: srcPath, dest: destPath });
    },
    async exists(path: string): Promise<boolean> {
      return path in files;
    },
  };
}

function makeAgents(
  overrides: Record<string, Partial<OpenClawAgentConfig>> = {},
): Record<string, Partial<OpenClawAgentConfig>> {
  return overrides;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "reins-agent-mapper-"));
  store = new AgentStore({ filePath: join(tempDir, "agents.json") });
  workspaceManager = new AgentWorkspaceManager({ baseDir: join(tempDir, "agents") });
  identityManager = new IdentityFileManager();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("AgentMapper", () => {
  describe("map", () => {
    it("converts a single agent with all fields", async () => {
      const fileCopier = makeMockFileCopier({
        "/oc/agents/eleanor/SOUL.md": "soul content",
      });

      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "Eleanor": {
          id: "eleanor",
          modelOverride: "anthropic/claude-sonnet-4-20250514",
          skills: ["calendar", "notes"],
          identityFiles: {
            soul: "/oc/agents/eleanor/SOUL.md",
          },
        },
      });

      const result = await mapper.map(agents);

      expect(result.converted).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;

      expect(listResult.value).toHaveLength(1);
      const agent = listResult.value[0];
      expect(agent.id).toBe("eleanor");
      expect(agent.name).toBe("Eleanor");
      expect(agent.skills).toEqual(["calendar", "notes"]);
      expect(agent.modelOverride).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      });
      expect(agent.metadata.source).toBe("openclaw-import");
    });

    it("converts multiple agents", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "Alice": { skills: ["search"] },
        "Bob": { skills: ["calendar"] },
        "Charlie": {},
      });

      const result = await mapper.map(agents);

      expect(result.converted).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value).toHaveLength(3);
    });

    it("generates slug id from name when no id provided", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "Chief of Staff": {},
      });

      const result = await mapper.map(agents);

      expect(result.converted).toBe(1);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value[0].id).toBe("chief-of-staff");
    });

    it("skips agents with empty name key and records error", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "": { skills: ["search"] },
        "ValidAgent": {},
      });

      const result = await mapper.map(agents);

      expect(result.converted).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].item).toBe("(unnamed)");
      expect(result.errors[0].reason).toContain("no name");
    });

    it("records error when agent store rejects duplicate id", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      // Create two agents that will produce the same slug id
      const agents = makeAgents({
        "Duplicate": { id: "same-id" },
      });
      const agents2 = makeAgents({
        "Another": { id: "same-id" },
      });

      await mapper.map(agents);
      const result = await mapper.map(agents2);

      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].item).toBe("Another");
      expect(result.errors[0].reason).toContain("already exists");
    });

    it("sets default role to assistant", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "TestAgent": {},
      });

      await mapper.map(agents);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value[0].role).toBe("assistant");
    });

    it("maps OpenClaw role when provided", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "Coordinator": {
          role: "chief-of-staff",
        },
      });

      await mapper.map(agents);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value[0].role).toBe("chief-of-staff");
    });

    it("sets empty skills array when none provided", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "NoSkills": {},
      });

      await mapper.map(agents);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value[0].skills).toEqual([]);
    });

    it("creates workspace directory for each agent", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "WorkspaceAgent": { id: "ws-agent" },
      });

      await mapper.map(agents);

      const exists = await workspaceManager.workspaceExists("ws-agent");
      expect(exists).toBe(true);
    });

    it("parses model override with provider/model format", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "ModelAgent": {
          id: "model-agent",
          modelOverride: "openai/gpt-4o",
        },
      });

      await mapper.map(agents);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value[0].modelOverride).toEqual({
        provider: "openai",
        model: "gpt-4o",
      });
    });

    it("parses model override without provider prefix", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "SimpleModel": {
          id: "simple-model",
          modelOverride: "gpt-4o",
        },
      });

      await mapper.map(agents);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value[0].modelOverride).toEqual({
        provider: "default",
        model: "gpt-4o",
      });
    });

    it("does not set modelOverride when none provided", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "NoModel": { id: "no-model" },
      });

      await mapper.map(agents);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value[0].modelOverride).toBeUndefined();
    });
  });

  describe("identity file copying", () => {
    it("copies known identity files to agent workspace", async () => {
      const fileCopier = makeMockFileCopier({
        "/oc/soul.md": "soul",
        "/oc/memory.md": "memory",
        "/oc/identity.md": "identity",
      });

      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "IdentityAgent": {
          id: "id-agent",
          identityFiles: {
            soul: "/oc/soul.md",
            memory: "/oc/memory.md",
            identity: "/oc/identity.md",
          },
        },
      });

      await mapper.map(agents);

      expect(fileCopier.copied).toHaveLength(3);

      const soulCopy = fileCopier.copied.find((c) => c.src === "/oc/soul.md");
      expect(soulCopy).toBeDefined();
      expect(soulCopy!.dest).toContain("SOUL.md");

      const memoryCopy = fileCopier.copied.find((c) => c.src === "/oc/memory.md");
      expect(memoryCopy).toBeDefined();
      expect(memoryCopy!.dest).toContain("MEMORY.md");

      const identityCopy = fileCopier.copied.find((c) => c.src === "/oc/identity.md");
      expect(identityCopy).toBeDefined();
      expect(identityCopy!.dest).toContain("IDENTITY.md");
    });

    it("copies custom identity files to agent workspace", async () => {
      const fileCopier = makeMockFileCopier({
        "/oc/GUIDELINES.md": "guidelines",
      });

      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "CustomFiles": {
          id: "custom-files",
          identityFiles: {
            "GUIDELINES.md": "/oc/GUIDELINES.md",
          },
        },
      });

      await mapper.map(agents);

      expect(fileCopier.copied).toHaveLength(1);
      expect(fileCopier.copied[0].dest).toContain("GUIDELINES.md");

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value[0].identityFiles.custom["GUIDELINES.md"]).toBeDefined();
    });

    it("skips identity files that do not exist at source path", async () => {
      const fileCopier = makeMockFileCopier({});

      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "MissingFiles": {
          id: "missing-files",
          identityFiles: {
            soul: "/oc/nonexistent/SOUL.md",
          },
        },
      });

      const result = await mapper.map(agents);

      expect(result.converted).toBe(1);
      expect(fileCopier.copied).toHaveLength(0);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value[0].identityFiles.soul).toBeUndefined();
    });

    it("handles agent with no identity files", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "NoIdentity": { id: "no-identity" },
      });

      const result = await mapper.map(agents);

      expect(result.converted).toBe(1);
      expect(fileCopier.copied).toHaveLength(0);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value[0].identityFiles).toEqual({ custom: {} });
    });
  });

  describe("dry run", () => {
    it("counts agents without creating them", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "DryAgent1": {},
        "DryAgent2": {},
      });

      const result = await mapper.map(agents, { dryRun: true });

      expect(result.converted).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value).toHaveLength(0);
    });

    it("still skips unnamed agents in dry run", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "": {},
        "Valid": {},
      });

      const result = await mapper.map(agents, { dryRun: true });

      expect(result.converted).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe("progress callback", () => {
    it("invokes onProgress for each agent processed", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const agents = makeAgents({
        "Agent1": {},
        "Agent2": {},
        "Agent3": {},
      });

      const progressCalls: Array<{ processed: number; total: number }> = [];

      await mapper.map(agents, {
        onProgress: (processed, total) => {
          progressCalls.push({ processed, total });
        },
      });

      expect(progressCalls).toHaveLength(3);
      expect(progressCalls[0]).toEqual({ processed: 1, total: 3 });
      expect(progressCalls[1]).toEqual({ processed: 2, total: 3 });
      expect(progressCalls[2]).toEqual({ processed: 3, total: 3 });
    });
  });

  describe("empty input", () => {
    it("returns zero counts for empty agent record", async () => {
      const fileCopier = makeMockFileCopier();
      const mapper = new AgentMapper(
        { agentStore: store, workspaceManager, identityManager },
        fileCopier,
      );

      const result = await mapper.map({});

      expect(result.converted).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });
});

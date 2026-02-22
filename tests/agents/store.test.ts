import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentStore } from "../../src/agents/store";
import type { Agent } from "../../src/agents/types";

let tempDir: string;
let store: AgentStore;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "agent-1",
    name: overrides.name ?? "Test Agent",
    role: overrides.role ?? "assistant",
    workspacePath: overrides.workspacePath ?? "/tmp/agents/agent-1",
    modelOverride: overrides.modelOverride,
    skills: overrides.skills ?? [],
    identityFiles: overrides.identityFiles ?? { custom: {} },
    personality: overrides.personality,
    metadata: overrides.metadata ?? {
      createdAt: now,
      updatedAt: now,
    },
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "reins-agent-store-"));
  store = new AgentStore({ filePath: join(tempDir, "agents.json") });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("AgentStore", () => {
  describe("create", () => {
    it("adds an agent and returns it", async () => {
      const agent = makeAgent({ id: "a1", name: "Alice" });
      const result = await store.create(agent);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toBe("a1");
      expect(result.value.name).toBe("Alice");
      expect(result.value.role).toBe("assistant");
    });

    it("rejects duplicate agent id", async () => {
      const agent = makeAgent({ id: "dup" });
      await store.create(agent);

      const duplicate = makeAgent({ id: "dup", name: "Different Name" });
      const result = await store.create(duplicate);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("AGENT_ERROR");
      expect(result.error.message).toContain("already exists");
    });
  });

  describe("get", () => {
    it("finds an existing agent by id", async () => {
      const agent = makeAgent({ id: "find-me", name: "Findable" });
      await store.create(agent);

      const result = await store.get("find-me");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.id).toBe("find-me");
      expect(result.value!.name).toBe("Findable");
    });

    it("returns null for a missing agent", async () => {
      const result = await store.get("nonexistent");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  describe("update", () => {
    it("merges partial updates correctly", async () => {
      const agent = makeAgent({
        id: "upd",
        name: "Original",
        role: "assistant",
        skills: ["skill-a"],
      });
      await store.create(agent);

      const result = await store.update("upd", {
        name: "Updated",
        skills: ["skill-a", "skill-b"],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toBe("upd");
      expect(result.value.name).toBe("Updated");
      expect(result.value.role).toBe("assistant");
      expect(result.value.skills).toEqual(["skill-a", "skill-b"]);
    });

    it("updates metadata.updatedAt timestamp", async () => {
      const earlyDate = "2020-01-01T00:00:00.000Z";
      const agent = makeAgent({
        id: "ts",
        metadata: { createdAt: earlyDate, updatedAt: earlyDate },
      });
      await store.create(agent);

      const result = await store.update("ts", { name: "Refreshed" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.metadata.createdAt).toBe(earlyDate);
      expect(result.value.metadata.updatedAt).not.toBe(earlyDate);
    });

    it("returns error for a missing agent", async () => {
      const result = await store.update("ghost", { name: "Nope" });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("AGENT_ERROR");
      expect(result.error.message).toContain("not found");
    });
  });

  describe("delete", () => {
    it("removes an agent and returns true", async () => {
      const agent = makeAgent({ id: "del" });
      await store.create(agent);

      const result = await store.delete("del");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(true);

      const getResult = await store.get("del");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).toBeNull();
    });

    it("returns false for a non-existent agent", async () => {
      const result = await store.delete("nope");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(false);
    });
  });

  describe("list", () => {
    it("returns all agents sorted by createdAt ascending", async () => {
      const agentC = makeAgent({
        id: "c",
        name: "Charlie",
        metadata: { createdAt: "2025-03-01T00:00:00.000Z", updatedAt: "2025-03-01T00:00:00.000Z" },
      });
      const agentA = makeAgent({
        id: "a",
        name: "Alice",
        metadata: { createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
      });
      const agentB = makeAgent({
        id: "b",
        name: "Bob",
        metadata: { createdAt: "2025-02-01T00:00:00.000Z", updatedAt: "2025-02-01T00:00:00.000Z" },
      });

      await store.create(agentC);
      await store.create(agentA);
      await store.create(agentB);

      const result = await store.list();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(3);
      expect(result.value[0].id).toBe("a");
      expect(result.value[1].id).toBe("b");
      expect(result.value[2].id).toBe("c");
    });

    it("returns empty array when no agents exist", async () => {
      const result = await store.list();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });
  });

  describe("persistence", () => {
    it("survives store re-instantiation with same file path", async () => {
      const filePath = join(tempDir, "agents.json");
      const storeA = new AgentStore({ filePath });

      const agent = makeAgent({ id: "persist", name: "Persistent" });
      await storeA.create(agent);

      const storeB = new AgentStore({ filePath });
      const result = await storeB.get("persist");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.id).toBe("persist");
      expect(result.value!.name).toBe("Persistent");
    });
  });
});

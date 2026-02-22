import { describe, expect, it } from "bun:test";

import type { Result } from "../../../src/result";
import { ok } from "../../../src/result";
import type { Agent } from "../../../src/agents/types";
import type { AgentStore } from "../../../src/agents/store";
import type { KeychainProvider } from "../../../src/security/keychain-provider";
import type { SecurityError } from "../../../src/security/security-error";
import type { AgentError } from "../../../src/agents/errors";
import {
  ConflictDetector,
  ConflictResolver,
  type Conflict,
  type ConflictDetectorFileOps,
  type ConflictStrategy,
  type ConversionPlan,
} from "../../../src/conversion/conflict";

function makeAgent(overrides: Partial<Agent> & { name: string }): Agent {
  return {
    id: overrides.id ?? `agent-${overrides.name}`,
    name: overrides.name,
    role: overrides.role ?? "assistant",
    workspacePath: overrides.workspacePath ?? `/home/user/.reins/agents/${overrides.name}`,
    skills: overrides.skills ?? [],
    identityFiles: overrides.identityFiles ?? { custom: {} },
    metadata: overrides.metadata ?? {
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  };
}

function createMockAgentStore(agents: Agent[]): AgentStore {
  return {
    list: async (): Promise<Result<Agent[], AgentError>> => ok(agents),
    create: async () => ok(agents[0]!),
    get: async () => ok(null),
    update: async () => ok(agents[0]!),
    delete: async () => ok(false),
  } as unknown as AgentStore;
}

function createMockKeychainProvider(
  existingKeys: Map<string, string>,
): KeychainProvider {
  return {
    get: async (
      service: string,
      account: string,
    ): Promise<Result<string | null, SecurityError>> => {
      const key = `${service}:${account}`;
      const value = existingKeys.get(key) ?? null;
      return ok(value);
    },
    set: async (): Promise<Result<void, SecurityError>> => ok(undefined),
    delete: async (): Promise<Result<void, SecurityError>> => ok(undefined),
  };
}

function createMockFileOps(
  channels: Array<{ name: string; [key: string]: unknown }> = [],
): ConflictDetectorFileOps {
  return {
    readChannelsFile: async () => channels,
  };
}

describe("ConflictDetector", () => {
  it("returns empty array when plan has no items", async () => {
    const detector = new ConflictDetector({
      agentStore: createMockAgentStore([]),
      keychainProvider: createMockKeychainProvider(new Map()),
      fileOps: createMockFileOps(),
      channelsFilePath: "/tmp/channels.json",
    });

    const conflicts = await detector.detect({});

    expect(conflicts).toEqual([]);
  });

  it("returns empty array when no existing data matches", async () => {
    const detector = new ConflictDetector({
      agentStore: createMockAgentStore([]),
      keychainProvider: createMockKeychainProvider(new Map()),
      fileOps: createMockFileOps(),
      channelsFilePath: "/tmp/channels.json",
    });

    const plan: ConversionPlan = {
      agents: [{ name: "new-agent" }],
      providerKeys: [{ provider: "openai" }],
      channels: [{ name: "my-bot", type: "telegram" }],
    };

    const conflicts = await detector.detect(plan);

    expect(conflicts).toEqual([]);
  });

  describe("agent collisions", () => {
    it("detects agent name collision", async () => {
      const existingAgent = makeAgent({ name: "coder" });
      const detector = new ConflictDetector({
        agentStore: createMockAgentStore([existingAgent]),
        keychainProvider: createMockKeychainProvider(new Map()),
        fileOps: createMockFileOps(),
        channelsFilePath: "/tmp/channels.json",
      });

      const plan: ConversionPlan = {
        agents: [{ name: "coder", role: "developer" }],
      };

      const conflicts = await detector.detect(plan);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.category).toBe("agents");
      expect(conflicts[0]!.itemName).toBe("coder");
      expect(conflicts[0]!.existingValue).toEqual(existingAgent);
      expect(conflicts[0]!.incomingValue).toEqual({ name: "coder", role: "developer" });
      expect(conflicts[0]!.path).toBe("agents");
    });

    it("detects agent name collision case-insensitively", async () => {
      const existingAgent = makeAgent({ name: "Coder" });
      const detector = new ConflictDetector({
        agentStore: createMockAgentStore([existingAgent]),
        keychainProvider: createMockKeychainProvider(new Map()),
        fileOps: createMockFileOps(),
        channelsFilePath: "/tmp/channels.json",
      });

      const plan: ConversionPlan = {
        agents: [{ name: "coder" }],
      };

      const conflicts = await detector.detect(plan);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.category).toBe("agents");
    });

    it("does not conflict when agent names differ", async () => {
      const existingAgent = makeAgent({ name: "writer" });
      const detector = new ConflictDetector({
        agentStore: createMockAgentStore([existingAgent]),
        keychainProvider: createMockKeychainProvider(new Map()),
        fileOps: createMockFileOps(),
        channelsFilePath: "/tmp/channels.json",
      });

      const plan: ConversionPlan = {
        agents: [{ name: "coder" }],
      };

      const conflicts = await detector.detect(plan);

      expect(conflicts).toEqual([]);
    });
  });

  describe("provider key collisions", () => {
    it("detects existing provider key in keychain", async () => {
      const existingKeys = new Map([["reins-byok:anthropic", "sk-ant-existing"]]);
      const detector = new ConflictDetector({
        agentStore: createMockAgentStore([]),
        keychainProvider: createMockKeychainProvider(existingKeys),
        fileOps: createMockFileOps(),
        channelsFilePath: "/tmp/channels.json",
      });

      const plan: ConversionPlan = {
        providerKeys: [{ provider: "anthropic", key: "sk-ant-new" }],
      };

      const conflicts = await detector.detect(plan);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.category).toBe("auth-profiles");
      expect(conflicts[0]!.itemName).toBe("anthropic");
      expect(conflicts[0]!.existingValue).toBe("[keychain:reins-byok/anthropic]");
      expect(conflicts[0]!.incomingValue).toEqual({ provider: "anthropic", key: "sk-ant-new" });
      expect(conflicts[0]!.path).toBe("keychain/reins-byok/anthropic");
    });

    it("does not conflict when provider key is absent", async () => {
      const detector = new ConflictDetector({
        agentStore: createMockAgentStore([]),
        keychainProvider: createMockKeychainProvider(new Map()),
        fileOps: createMockFileOps(),
        channelsFilePath: "/tmp/channels.json",
      });

      const plan: ConversionPlan = {
        providerKeys: [{ provider: "openai" }],
      };

      const conflicts = await detector.detect(plan);

      expect(conflicts).toEqual([]);
    });
  });

  describe("channel collisions", () => {
    it("detects channel name collision", async () => {
      const existingChannel = { name: "support-bot", type: "telegram", id: "tg-support" };
      const detector = new ConflictDetector({
        agentStore: createMockAgentStore([]),
        keychainProvider: createMockKeychainProvider(new Map()),
        fileOps: createMockFileOps([existingChannel]),
        channelsFilePath: "/tmp/channels.json",
      });

      const plan: ConversionPlan = {
        channels: [{ name: "support-bot", type: "telegram" }],
      };

      const conflicts = await detector.detect(plan);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.category).toBe("channel-credentials");
      expect(conflicts[0]!.itemName).toBe("support-bot");
      expect(conflicts[0]!.existingValue).toEqual(existingChannel);
      expect(conflicts[0]!.incomingValue).toEqual({ name: "support-bot", type: "telegram" });
      expect(conflicts[0]!.path).toBe("/tmp/channels.json");
    });

    it("detects channel name collision case-insensitively", async () => {
      const existingChannel = { name: "My-Bot", type: "discord" };
      const detector = new ConflictDetector({
        agentStore: createMockAgentStore([]),
        keychainProvider: createMockKeychainProvider(new Map()),
        fileOps: createMockFileOps([existingChannel]),
        channelsFilePath: "/tmp/channels.json",
      });

      const plan: ConversionPlan = {
        channels: [{ name: "my-bot", type: "discord" }],
      };

      const conflicts = await detector.detect(plan);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.category).toBe("channel-credentials");
    });

    it("does not conflict when channel names differ", async () => {
      const existingChannel = { name: "alerts-bot", type: "telegram" };
      const detector = new ConflictDetector({
        agentStore: createMockAgentStore([]),
        keychainProvider: createMockKeychainProvider(new Map()),
        fileOps: createMockFileOps([existingChannel]),
        channelsFilePath: "/tmp/channels.json",
      });

      const plan: ConversionPlan = {
        channels: [{ name: "support-bot", type: "telegram" }],
      };

      const conflicts = await detector.detect(plan);

      expect(conflicts).toEqual([]);
    });
  });

  describe("multiple conflicts", () => {
    it("returns all conflicts across categories", async () => {
      const existingAgent = makeAgent({ name: "coder" });
      const existingKeys = new Map([["reins-byok:openai", "sk-existing"]]);
      const existingChannel = { name: "alerts", type: "telegram" };

      const detector = new ConflictDetector({
        agentStore: createMockAgentStore([existingAgent]),
        keychainProvider: createMockKeychainProvider(existingKeys),
        fileOps: createMockFileOps([existingChannel]),
        channelsFilePath: "/tmp/channels.json",
      });

      const plan: ConversionPlan = {
        agents: [{ name: "coder" }, { name: "writer" }],
        providerKeys: [{ provider: "openai" }, { provider: "anthropic" }],
        channels: [{ name: "alerts", type: "telegram" }, { name: "new-bot", type: "discord" }],
      };

      const conflicts = await detector.detect(plan);

      expect(conflicts).toHaveLength(3);

      const agentConflicts = conflicts.filter((c) => c.category === "agents");
      const keyConflicts = conflicts.filter((c) => c.category === "auth-profiles");
      const channelConflicts = conflicts.filter((c) => c.category === "channel-credentials");

      expect(agentConflicts).toHaveLength(1);
      expect(agentConflicts[0]!.itemName).toBe("coder");

      expect(keyConflicts).toHaveLength(1);
      expect(keyConflicts[0]!.itemName).toBe("openai");

      expect(channelConflicts).toHaveLength(1);
      expect(channelConflicts[0]!.itemName).toBe("alerts");
    });

    it("returns multiple conflicts within the same category", async () => {
      const agents = [makeAgent({ name: "coder" }), makeAgent({ name: "writer" })];
      const detector = new ConflictDetector({
        agentStore: createMockAgentStore(agents),
        keychainProvider: createMockKeychainProvider(new Map()),
        fileOps: createMockFileOps(),
        channelsFilePath: "/tmp/channels.json",
      });

      const plan: ConversionPlan = {
        agents: [{ name: "coder" }, { name: "writer" }, { name: "new-agent" }],
      };

      const conflicts = await detector.detect(plan);

      expect(conflicts).toHaveLength(2);
      const names = conflicts.map((c) => c.itemName).sort();
      expect(names).toEqual(["coder", "writer"]);
    });
  });

  describe("edge cases", () => {
    it("handles empty plan arrays gracefully", async () => {
      const detector = new ConflictDetector({
        agentStore: createMockAgentStore([makeAgent({ name: "existing" })]),
        keychainProvider: createMockKeychainProvider(new Map([["reins-byok:openai", "key"]])),
        fileOps: createMockFileOps([{ name: "bot", type: "telegram" }]),
        channelsFilePath: "/tmp/channels.json",
      });

      const plan: ConversionPlan = {
        agents: [],
        providerKeys: [],
        channels: [],
      };

      const conflicts = await detector.detect(plan);

      expect(conflicts).toEqual([]);
    });

    it("handles undefined plan fields gracefully", async () => {
      const detector = new ConflictDetector({
        agentStore: createMockAgentStore([makeAgent({ name: "existing" })]),
        keychainProvider: createMockKeychainProvider(new Map([["reins-byok:openai", "key"]])),
        fileOps: createMockFileOps([{ name: "bot", type: "telegram" }]),
        channelsFilePath: "/tmp/channels.json",
      });

      const conflicts = await detector.detect({
        agents: undefined,
        providerKeys: undefined,
        channels: undefined,
      });

      expect(conflicts).toEqual([]);
    });
  });
});

function makeConflict(overrides: Partial<Conflict> = {}): Conflict {
  return {
    category: overrides.category ?? "agents",
    itemName: overrides.itemName ?? "test-item",
    existingValue: overrides.existingValue ?? "existing",
    incomingValue: overrides.incomingValue ?? "incoming",
    path: overrides.path ?? "agents",
  };
}

describe("ConflictResolver", () => {
  const resolver = new ConflictResolver();

  describe("resolve with overwrite strategy", () => {
    it("returns applied outcome with incoming value", () => {
      const conflict = makeConflict({
        existingValue: { name: "old" },
        incomingValue: { name: "new" },
      });

      const record = resolver.resolve(conflict, "overwrite");

      expect(record.conflict).toBe(conflict);
      expect(record.strategy).toBe("overwrite");
      expect(record.outcome).toBe("applied");
      expect(record.mergedValue).toEqual({ name: "new" });
    });
  });

  describe("resolve with skip strategy", () => {
    it("returns skipped outcome with existing value", () => {
      const conflict = makeConflict({
        existingValue: { name: "old" },
        incomingValue: { name: "new" },
      });

      const record = resolver.resolve(conflict, "skip");

      expect(record.conflict).toBe(conflict);
      expect(record.strategy).toBe("skip");
      expect(record.outcome).toBe("skipped");
      expect(record.mergedValue).toEqual({ name: "old" });
    });
  });

  describe("resolve with merge strategy", () => {
    it("concatenates and deduplicates array values", () => {
      const conflict = makeConflict({
        existingValue: ["python", "javascript"],
        incomingValue: ["javascript", "rust", "go"],
      });

      const record = resolver.resolve(conflict, "merge");

      expect(record.strategy).toBe("merge");
      expect(record.outcome).toBe("merged");
      const merged = record.mergedValue as string[];
      expect(merged).toContain("python");
      expect(merged).toContain("javascript");
      expect(merged).toContain("rust");
      expect(merged).toContain("go");
      expect(merged).toHaveLength(4);
    });

    it("shallow merges object values", () => {
      const conflict = makeConflict({
        existingValue: { model: "gpt-4", temperature: 0.7 },
        incomingValue: { model: "claude-3", maxTokens: 1000 },
      });

      const record = resolver.resolve(conflict, "merge");

      expect(record.strategy).toBe("merge");
      expect(record.outcome).toBe("merged");
      expect(record.mergedValue).toEqual({
        model: "claude-3",
        temperature: 0.7,
        maxTokens: 1000,
      });
    });

    it("falls back to overwrite for scalar values", () => {
      const conflict = makeConflict({
        existingValue: "old-value",
        incomingValue: "new-value",
      });

      const record = resolver.resolve(conflict, "merge");

      expect(record.strategy).toBe("merge");
      expect(record.outcome).toBe("applied");
      expect(record.mergedValue).toBe("new-value");
    });

    it("falls back to overwrite for mismatched types", () => {
      const conflict = makeConflict({
        existingValue: ["a", "b"],
        incomingValue: { key: "value" },
      });

      const record = resolver.resolve(conflict, "merge");

      expect(record.strategy).toBe("merge");
      expect(record.outcome).toBe("applied");
      expect(record.mergedValue).toEqual({ key: "value" });
    });

    it("handles null existing value as scalar fallback", () => {
      const conflict = makeConflict({
        existingValue: null,
        incomingValue: { name: "new" },
      });

      const record = resolver.resolve(conflict, "merge");

      expect(record.outcome).toBe("applied");
      expect(record.mergedValue).toEqual({ name: "new" });
    });
  });

  describe("resolveAll", () => {
    it("applies the same strategy to all conflicts", () => {
      const conflicts = [
        makeConflict({ itemName: "agent-1", existingValue: "a", incomingValue: "b" }),
        makeConflict({ itemName: "agent-2", existingValue: "c", incomingValue: "d" }),
        makeConflict({ itemName: "agent-3", existingValue: "e", incomingValue: "f" }),
      ];

      const records = resolver.resolveAll(conflicts, "skip");

      expect(records).toHaveLength(3);
      for (const record of records) {
        expect(record.strategy).toBe("skip");
        expect(record.outcome).toBe("skipped");
      }
      expect(records[0]!.mergedValue).toBe("a");
      expect(records[1]!.mergedValue).toBe("c");
      expect(records[2]!.mergedValue).toBe("e");
    });

    it("returns empty array for empty conflicts", () => {
      const records = resolver.resolveAll([], "overwrite");

      expect(records).toEqual([]);
    });
  });

  describe("resolveWithCallback", () => {
    it("calls callback for each conflict and applies returned strategy", async () => {
      const conflicts = [
        makeConflict({
          itemName: "skills",
          existingValue: ["python"],
          incomingValue: ["rust"],
        }),
        makeConflict({
          itemName: "config",
          existingValue: { a: 1 },
          incomingValue: { b: 2 },
        }),
      ];

      const records = await resolver.resolveWithCallback(
        conflicts,
        async () => "merge",
      );

      expect(records).toHaveLength(2);
      expect(records[0]!.outcome).toBe("merged");
      expect(records[0]!.mergedValue).toEqual(["python", "rust"]);
      expect(records[1]!.outcome).toBe("merged");
      expect(records[1]!.mergedValue).toEqual({ a: 1, b: 2 });
    });

    it("supports different strategies per conflict", async () => {
      const conflicts = [
        makeConflict({ itemName: "first" }),
        makeConflict({ itemName: "second" }),
        makeConflict({ itemName: "third" }),
      ];

      const strategies: ConflictStrategy[] = ["overwrite", "skip", "merge"];
      let callIndex = 0;

      const records = await resolver.resolveWithCallback(
        conflicts,
        async () => {
          const strategy = strategies[callIndex]!;
          callIndex++;
          return strategy;
        },
      );

      expect(records).toHaveLength(3);
      expect(records[0]!.strategy).toBe("overwrite");
      expect(records[0]!.outcome).toBe("applied");
      expect(records[1]!.strategy).toBe("skip");
      expect(records[1]!.outcome).toBe("skipped");
      expect(records[2]!.strategy).toBe("merge");
      expect(records[2]!.outcome).toBe("applied"); // scalar fallback
    });

    it("returns empty array for empty conflicts", async () => {
      const records = await resolver.resolveWithCallback(
        [],
        async () => "overwrite",
      );

      expect(records).toEqual([]);
    });
  });
});

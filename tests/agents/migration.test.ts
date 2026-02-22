import { describe, expect, it } from "bun:test";

import { createDefaultAgent, migratePersonalityToAgent } from "../../src/agents/migration";
import type { UserConfig } from "../../src/config/user-config";

describe("migratePersonalityToAgent", () => {
  it("returns agent with id default", () => {
    const agent = migratePersonalityToAgent({ preset: "balanced" });

    expect(agent.id).toBe("default");
  });

  it("preserves personality preset", () => {
    const agent = migratePersonalityToAgent({ preset: "technical" });

    expect(agent.personality?.preset).toBe("technical");
  });

  it("preserves customPrompt when present", () => {
    const agent = migratePersonalityToAgent({
      preset: "custom",
      customPrompt: "Always ask clarifying questions first.",
    });

    expect(agent.personality?.preset).toBe("custom");
    expect(agent.personality?.customPrompt).toBe("Always ask clarifying questions first.");
  });

  it("uses workspacePath ending with agents/default", () => {
    const agent = migratePersonalityToAgent(
      { preset: "balanced" },
      { homeDir: "/test/home" },
    );

    expect(agent.workspacePath).toBe("/test/home/.reins/agents/default");
  });

  it("uses provided userName in agent.name", () => {
    const agent = migratePersonalityToAgent(
      { preset: "warm" },
      { userName: "Avery" },
    );

    expect(agent.name).toBe("Avery");
  });

  it("uses custom homeDir option", () => {
    const agent = migratePersonalityToAgent(
      { preset: "concise" },
      { homeDir: "/opt/users/demo" },
    );

    expect(agent.workspacePath).toBe("/opt/users/demo/.reins/agents/default");
  });
});

describe("createDefaultAgent", () => {
  it("returns agent with balanced preset", () => {
    const agent = createDefaultAgent();

    expect(agent.personality?.preset).toBe("balanced");
  });

  it("returns agent with id default", () => {
    const agent = createDefaultAgent();

    expect(agent.id).toBe("default");
  });
});

describe("UserConfig backward compatibility", () => {
  it("allows configs without activeAgentId", () => {
    const config: UserConfig = {
      name: "Test User",
      personality: {
        preset: "balanced",
      },
      provider: {
        mode: "none",
      },
      daemon: {
        host: "127.0.0.1",
        port: 3525,
      },
      setupComplete: true,
    };

    expect(config.activeAgentId).toBeUndefined();
  });
});

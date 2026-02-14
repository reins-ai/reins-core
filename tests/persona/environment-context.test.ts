import { describe, expect, it } from "bun:test";

import { err, ok } from "../../src/result";
import { SystemPromptBuilder } from "../../src/persona/builder";
import { DEFAULT_PERSONA } from "../../src/persona/default";
import { EnvironmentContextProvider } from "../../src/persona/environment-context";
import type { OverlayResolution } from "../../src/environment/types";
import type { EnvironmentSwitchEvent } from "../../src/environment/switch-service";

function createOverlayResolution(
  personality: string,
  user: string,
  environmentName = "work",
): OverlayResolution {
  const now = new Date();

  return {
    activeEnvironment: environmentName,
    fallbackEnvironment: "default",
    documents: {
      PERSONALITY: {
        type: "PERSONALITY",
        source: "active",
        sourceEnvironment: environmentName,
        document: {
          type: "PERSONALITY",
          path: `${environmentName}/PERSONALITY.md`,
          content: personality,
          environmentName,
          loadedAt: now,
        },
      },
      USER: {
        type: "USER",
        source: "active",
        sourceEnvironment: environmentName,
        document: {
          type: "USER",
          path: `${environmentName}/USER.md`,
          content: user,
          environmentName,
          loadedAt: now,
        },
      },
      HEARTBEAT: {
        type: "HEARTBEAT",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "HEARTBEAT",
          path: "default/HEARTBEAT.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
      ROUTINES: {
        type: "ROUTINES",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "ROUTINES",
          path: "default/ROUTINES.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
      GOALS: {
        type: "GOALS",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "GOALS",
          path: "default/GOALS.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
      KNOWLEDGE: {
        type: "KNOWLEDGE",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "KNOWLEDGE",
          path: "default/KNOWLEDGE.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
      TOOLS: {
        type: "TOOLS",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "TOOLS",
          path: "default/TOOLS.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
      BOUNDARIES: {
        type: "BOUNDARIES",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "BOUNDARIES",
          path: "default/BOUNDARIES.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
    },
  };
}

describe("EnvironmentContextProvider", () => {
  it("builds prompt using resolved environment documents", async () => {
    const resolver = {
      getResolvedDocuments: async () =>
        ok(
          createOverlayResolution(
            "You are focused and direct.",
            "User prefers concise responses.",
          ),
        ),
    };

    const provider = new EnvironmentContextProvider(resolver, new SystemPromptBuilder());
    const result = await provider.buildEnvironmentPrompt(DEFAULT_PERSONA);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toContain("## Identity\nYou are focused and direct.");
    expect(result.value).toContain("## User Context\nUser prefers concise responses.");
  });

  it("returns error when environment resolution fails", async () => {
    const provider = new EnvironmentContextProvider(
      {
        getResolvedDocuments: async () => err(new Error("resolution failed")),
      },
      new SystemPromptBuilder(),
    );

    const result = await provider.buildEnvironmentPrompt(DEFAULT_PERSONA);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.message).toBe("resolution failed");
  });

  it("notifies listeners after environment switch events", () => {
    let switchListener: ((event: EnvironmentSwitchEvent) => void) | undefined;

    const provider = new EnvironmentContextProvider(
      {
        getResolvedDocuments: async () => ok(createOverlayResolution("P", "U")),
      },
      new SystemPromptBuilder(),
      {
        onEnvironmentSwitch(callback) {
          switchListener = callback;
          return () => {
            switchListener = undefined;
          };
        },
      },
    );

    let calls = 0;
    const unsubscribe = provider.onEnvironmentSwitch(() => {
      calls += 1;
    });

    switchListener?.({
      previousEnvironment: "default",
      activeEnvironment: "work",
      resolvedDocuments: createOverlayResolution("P", "U"),
      switchedAt: new Date(),
    });
    expect(calls).toBe(1);

    unsubscribe();
    switchListener?.({
      previousEnvironment: "work",
      activeEnvironment: "travel",
      resolvedDocuments: createOverlayResolution("P2", "U2", "travel"),
      switchedAt: new Date(),
    });
    expect(calls).toBe(1);
  });
});

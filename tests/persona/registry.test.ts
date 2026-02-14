import { describe, expect, it } from "bun:test";

import { DEFAULT_PERSONA } from "../../src/persona/default";
import type { Persona } from "../../src/persona/persona";
import { PersonaRegistry } from "../../src/persona/registry";
import type { EnvironmentDocument, OverlayResolution } from "../../src/environment/types";

const makePersona = (id: string): Persona => ({
  id,
  name: `Persona ${id}`,
  description: `Description for ${id}`,
  systemPrompt: `System prompt for ${id}`,
  toolPermissions: { mode: "all" },
});

const buildOverlay = (documents: Partial<Record<EnvironmentDocument, string>>): OverlayResolution => {
  const now = new Date();

  return {
    activeEnvironment: "work",
    fallbackEnvironment: "default",
    documents: {
      PERSONALITY: {
        type: "PERSONALITY",
        source: documents.PERSONALITY ? "active" : "default",
        sourceEnvironment: documents.PERSONALITY ? "work" : "default",
        document: {
          type: "PERSONALITY",
          path: "PERSONALITY.md",
          content: documents.PERSONALITY ?? "",
          environmentName: documents.PERSONALITY ? "work" : "default",
          loadedAt: now,
        },
      },
      USER: {
        type: "USER",
        source: documents.USER ? "active" : "default",
        sourceEnvironment: documents.USER ? "work" : "default",
        document: {
          type: "USER",
          path: "USER.md",
          content: documents.USER ?? "",
          environmentName: documents.USER ? "work" : "default",
          loadedAt: now,
        },
      },
      HEARTBEAT: {
        type: "HEARTBEAT",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "HEARTBEAT",
          path: "HEARTBEAT.md",
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
          path: "ROUTINES.md",
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
          path: "GOALS.md",
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
          path: "KNOWLEDGE.md",
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
          path: "TOOLS.md",
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
          path: "BOUNDARIES.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
    },
  };
};

describe("PersonaRegistry", () => {
  it("auto-registers the default persona", () => {
    const registry = new PersonaRegistry();

    expect(registry.has(DEFAULT_PERSONA.id)).toBe(true);
    expect(registry.get(DEFAULT_PERSONA.id)).toEqual(DEFAULT_PERSONA);
  });

  it("registers a custom persona", () => {
    const registry = new PersonaRegistry();
    const customPersona = makePersona("travel-helper");

    registry.register(customPersona);

    expect(registry.get("travel-helper")).toEqual(customPersona);
  });

  it("throws on duplicate registration", () => {
    const registry = new PersonaRegistry();
    const customPersona = makePersona("duplicate");

    registry.register(customPersona);

    expect(() => registry.register(customPersona)).toThrow(Error);
  });

  it("supports get, getOrThrow, list, has, and remove", () => {
    const registry = new PersonaRegistry();
    const removable = makePersona("temporary");

    registry.register(removable);

    expect(registry.get("temporary")).toEqual(removable);
    expect(registry.getOrThrow("temporary")).toEqual(removable);
    expect(registry.has("temporary")).toBe(true);
    expect(registry.list().map((persona) => persona.id)).toContain("temporary");
    expect(registry.remove("temporary")).toBe(true);
    expect(registry.get("temporary")).toBeUndefined();
    expect(registry.has("temporary")).toBe(false);
  });

  it("setDefault changes the default persona", () => {
    const registry = new PersonaRegistry();
    const alternate = makePersona("alternate-default");

    registry.register(alternate);
    registry.setDefault("alternate-default");

    expect(registry.getDefault()).toEqual(alternate);
  });

  it("getDefault returns the registered default persona", () => {
    const registry = new PersonaRegistry();

    expect(registry.getDefault()).toEqual(DEFAULT_PERSONA);
  });

  it("resolve returns environment-aware persona when PERSONALITY exists", () => {
    const registry = new PersonaRegistry();
    const overlay = buildOverlay({ PERSONALITY: "Custom personality instructions" });

    const persona = registry.resolve(undefined, overlay);

    expect(persona.systemPrompt).toBe("Custom personality instructions");
    expect(persona.metadata).toMatchObject({
      environmentContext: {
        activeEnvironment: "work",
        personalitySource: "work",
      },
    });
  });

  it("resolve preserves base persona when PERSONALITY is empty", () => {
    const registry = new PersonaRegistry();
    const overlay = buildOverlay({ PERSONALITY: "   " });

    const persona = registry.resolve(undefined, overlay);

    expect(persona).toEqual(DEFAULT_PERSONA);
  });
});

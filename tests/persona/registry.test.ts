import { describe, expect, it } from "bun:test";

import { DEFAULT_PERSONA } from "../../src/persona/default";
import type { Persona } from "../../src/persona/persona";
import { PersonaRegistry } from "../../src/persona/registry";

const makePersona = (id: string): Persona => ({
  id,
  name: `Persona ${id}`,
  description: `Description for ${id}`,
  systemPrompt: `System prompt for ${id}`,
  toolPermissions: { mode: "all" },
});

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
});

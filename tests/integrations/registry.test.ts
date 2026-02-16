import { describe, expect, it } from "bun:test";

import { IntegrationError } from "../../src/integrations/errors";
import { IntegrationRegistry } from "../../src/integrations/registry";
import type {
  Integration,
  IntegrationCategory,
  IntegrationConfig,
  IntegrationManifest,
  IntegrationOperation,
  IntegrationStatus,
} from "../../src/integrations/types";
import { IntegrationState } from "../../src/integrations/types";
import { ok } from "../../src/result";

function createIntegration(
  config: Partial<IntegrationConfig> = {},
  category: IntegrationCategory = "productivity",
): Integration {
  const integrationConfig: IntegrationConfig = {
    id: config.id ?? "obsidian-notes",
    enabled: config.enabled ?? true,
    settings: config.settings,
    authConfig: config.authConfig,
  };

  const operation: IntegrationOperation = {
    name: "search-notes",
    description: "Search notes by content",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  };

  const manifest: IntegrationManifest = {
    id: integrationConfig.id,
    name: `Integration ${integrationConfig.id}`,
    description: "Test integration",
    version: "1.0.0",
    author: "Reins Team",
    category,
    auth: { type: "local_path", mustExist: true },
    permissions: ["read"],
    platforms: ["daemon"],
    operations: [operation],
  };

  const status: IntegrationStatus = {
    indicator: "disconnected",
    state: IntegrationState.DISCONNECTED,
    updatedAt: new Date(),
  };

  return {
    config: integrationConfig,
    manifest,
    async connect() {
      return ok(undefined);
    },
    async disconnect() {
      return ok(undefined);
    },
    getStatus() {
      return status;
    },
    getOperations() {
      return [operation];
    },
    async execute(_operationName: string, _args: Record<string, unknown>) {
      return ok({ success: true });
    },
  };
}

describe("IntegrationRegistry", () => {
  it("registers and gets an integration by id", () => {
    const registry = new IntegrationRegistry();
    const integration = createIntegration({ id: "obsidian" });

    registry.register(integration);

    expect(registry.get("obsidian")).toBe(integration);
    expect(registry.has("obsidian")).toBe(true);
  });

  it("normalizes integration ids for register, get, has, and remove", () => {
    const registry = new IntegrationRegistry();
    const integration = createIntegration({ id: "  ObSiDiAn  " });

    registry.register(integration);

    expect(registry.get("obsidian")).toBe(integration);
    expect(registry.get(" OBSIDIAN ")).toBe(integration);
    expect(registry.has(" Obsidian")).toBe(true);
    expect(registry.remove(" obsidian ")).toBe(true);
    expect(registry.has("obsidian")).toBe(false);
  });

  it("throws on duplicate integration id", () => {
    const registry = new IntegrationRegistry();

    registry.register(createIntegration({ id: "adapter-alpha" }));

    expect(() => registry.register(createIntegration({ id: " ADAPTER-ALPHA " }))).toThrow(IntegrationError);
  });

  it("returns all integrations in registration order", () => {
    const registry = new IntegrationRegistry();
    const first = createIntegration({ id: "obsidian" }, "knowledge");
    const second = createIntegration({ id: "adapter-beta" }, "media");

    registry.register(first);
    registry.register(second);

    expect(registry.list()).toEqual([first, second]);
  });

  it("getOrThrow returns integration when present", () => {
    const registry = new IntegrationRegistry();
    const integration = createIntegration({ id: "available" });
    registry.register(integration);

    expect(registry.getOrThrow("available")).toBe(integration);
  });

  it("getOrThrow throws for unknown integration", () => {
    const registry = new IntegrationRegistry();

    expect(() => registry.getOrThrow("missing")).toThrow(IntegrationError);
  });

  it("removes integrations and returns whether integration existed", () => {
    const registry = new IntegrationRegistry();
    registry.register(createIntegration({ id: "temporary" }));

    expect(registry.remove("temporary")).toBe(true);
    expect(registry.remove("temporary")).toBe(false);
    expect(registry.has("temporary")).toBe(false);
  });

  it("clears all integrations", () => {
    const registry = new IntegrationRegistry();
    registry.register(createIntegration({ id: "obsidian" }));
    registry.register(createIntegration({ id: "adapter-alpha" }, "communication"));

    registry.clear();

    expect(registry.list()).toHaveLength(0);
    expect(registry.has("obsidian")).toBe(false);
    expect(registry.has("adapter-alpha")).toBe(false);
  });

  it("enables and disables integrations", () => {
    const registry = new IntegrationRegistry();
    const integration = createIntegration({ id: "adapter-beta", enabled: false }, "media");
    registry.register(integration);

    expect(registry.enable(" ADAPTER-BETA ")).toBe(true);
    expect(integration.config.enabled).toBe(true);

    expect(registry.disable("adapter-beta")).toBe(true);
    expect(integration.config.enabled).toBe(false);
  });

  it("returns false when toggling a missing integration", () => {
    const registry = new IntegrationRegistry();

    expect(registry.enable("missing")).toBe(false);
    expect(registry.disable("missing")).toBe(false);
  });

  it("lists only active integrations", () => {
    const registry = new IntegrationRegistry();
    const active = createIntegration({ id: "obsidian", enabled: true }, "knowledge");
    const inactive = createIntegration({ id: "adapter-alpha", enabled: false }, "communication");

    registry.register(active);
    registry.register(inactive);

    expect(registry.listActive()).toEqual([active]);
  });

  it("lists integrations by category", () => {
    const registry = new IntegrationRegistry();
    const media = createIntegration({ id: "adapter-beta" }, "media");
    const communication = createIntegration({ id: "adapter-alpha" }, "communication");
    const knowledge = createIntegration({ id: "obsidian" }, "knowledge");

    registry.register(media);
    registry.register(communication);
    registry.register(knowledge);

    expect(registry.listByCategory("media")).toEqual([media]);
    expect(registry.listByCategory("communication")).toEqual([communication]);
    expect(registry.listByCategory("developer")).toEqual([]);
  });
});

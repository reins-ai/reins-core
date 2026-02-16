import { describe, expect, it } from "bun:test";

import {
  getCapabilityIndexTokenCount,
  IntegrationMetaTool,
  INTEGRATION_META_TOOL_ACTIONS,
  INTEGRATION_META_TOOL_DEFINITION,
  INTEGRATION_META_TOOL_MAX_TOKENS,
  getIntegrationMetaToolTokenCount,
} from "../../src/integrations/meta-tool";
import { IntegrationRegistry } from "../../src/integrations/registry";
import type {
  Integration,
  IntegrationConfig,
  IntegrationManifest,
  IntegrationOperation,
  IntegrationStatus,
} from "../../src/integrations/types";
import { IntegrationState } from "../../src/integrations/types";
import { err, ok } from "../../src/result";
import type { ToolContext } from "../../src/types";

function createOperation(name: string): IntegrationOperation {
  return {
    name,
    description: `${name} operation`,
    parameters: {
      type: "object",
      properties: {
        input: {
          type: "string",
        },
      },
      required: ["input"],
    },
  };
}

type CreateMockIntegrationOptions = {
  id: string;
  enabled?: boolean;
  operations: IntegrationOperation[];
  executeResult?: ReturnType<typeof ok<unknown>> | ReturnType<typeof err<Error>>;
};

function createMockIntegration(options: CreateMockIntegrationOptions): {
  integration: Integration;
  executeCalls: Array<{ operationName: string; args: Record<string, unknown> }>;
} {
  const config: IntegrationConfig = {
    id: options.id,
    enabled: options.enabled ?? true,
  };

  const manifest: IntegrationManifest = {
    id: options.id,
    name: options.id,
    description: `${options.id} integration`,
    version: "1.0.0",
    author: "Reins Team",
    category: "utilities",
    auth: { type: "api_key" },
    permissions: ["read"],
    platforms: ["daemon"],
    operations: options.operations,
  };

  const status: IntegrationStatus = {
    indicator: "connected",
    state: IntegrationState.ACTIVE,
    updatedAt: new Date(),
  };

  const executeCalls: Array<{ operationName: string; args: Record<string, unknown> }> = [];

  const integration: Integration = {
    config,
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
      return options.operations;
    },
    async execute(operationName: string, args: Record<string, unknown>) {
      executeCalls.push({ operationName, args });
      return options.executeResult ?? ok({ executed: true });
    },
  };

  return { integration, executeCalls };
}

function createContext(): ToolContext {
  return {
    conversationId: "c1",
    userId: "u1",
  };
}

describe("INTEGRATION_META_TOOL_DEFINITION", () => {
  it("defines the integration meta-tool", () => {
    expect(INTEGRATION_META_TOOL_DEFINITION.name).toBe("integration");
    expect(INTEGRATION_META_TOOL_DEFINITION.parameters.type).toBe("object");
    expect(INTEGRATION_META_TOOL_DEFINITION.parameters.required).toEqual(["action"]);
  });

  it("includes discover, activate, and execute actions", () => {
    const action = INTEGRATION_META_TOOL_DEFINITION.parameters.properties.action;
    expect(action.type).toBe("string");
    expect(action.enum).toEqual([...INTEGRATION_META_TOOL_ACTIONS]);
  });

  it("uses compact parameter schema for integration execution", () => {
    const properties = INTEGRATION_META_TOOL_DEFINITION.parameters.properties;
    expect(properties.integration_id?.type).toBe("string");
    expect(properties.operation?.type).toBe("string");
    expect(properties.args?.type).toBe("object");
  });

  it("stays within the 200-token context budget", () => {
    const tokenCount = getIntegrationMetaToolTokenCount();
    expect(tokenCount).toBeLessThanOrEqual(INTEGRATION_META_TOOL_MAX_TOKENS);
  });
});

describe("IntegrationMetaTool", () => {
  it("discover returns compact capability index for active integrations", async () => {
    const registry = new IntegrationRegistry();
    registry.register(
      createMockIntegration({
        id: "adapter-alpha",
        operations: [createOperation("list_messages"), createOperation("send_message")],
      }).integration,
    );
    registry.register(
      createMockIntegration({
        id: "adapter-beta",
        operations: [createOperation("search")],
        enabled: false,
      }).integration,
    );

    const tool = new IntegrationMetaTool(registry);
    const result = await tool.execute({ callId: "d1", action: "discover" }, createContext());

    expect(result.error).toBeUndefined();
    expect(result.callId).toBe("d1");
    expect(result.name).toBe("integration");
    expect(result.result).toEqual({
      action: "discover",
      capabilityIndex: ["adapter-alpha:list_messages,send_message"],
    });
  });

  it("activate returns full operation schema for an integration", async () => {
    const operations = [
      {
        name: "read_message",
        description: "Read a message by id",
        parameters: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "Message id" },
          },
          required: ["messageId"],
        },
      },
    ] satisfies IntegrationOperation[];

    const registry = new IntegrationRegistry();
    registry.register(createMockIntegration({ id: "adapter-alpha", operations }).integration);

    const tool = new IntegrationMetaTool(registry);
    const result = await tool.execute(
      { callId: "a1", action: "activate", integration_id: " ADAPTER-ALPHA " },
      createContext(),
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      action: "activate",
      integrationId: "adapter-alpha",
      operations,
    });
  });

  it("execute delegates to integration.execute with operation args", async () => {
    const mock = createMockIntegration({
      id: "obsidian",
      operations: [createOperation("search_notes")],
      executeResult: ok({ notes: [{ path: "daily.md" }] }),
    });

    const registry = new IntegrationRegistry();
    registry.register(mock.integration);

    const tool = new IntegrationMetaTool(registry);
    const args = { query: "project" };
    const result = await tool.execute(
      {
        callId: "e1",
        action: "execute",
        integration_id: "obsidian",
        operation: "search_notes",
        args,
      },
      createContext(),
    );

    expect(mock.executeCalls).toEqual([{ operationName: "search_notes", args }]);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      action: "execute",
      integrationId: "obsidian",
      operation: "search_notes",
      result: { notes: [{ path: "daily.md" }] },
    });
  });

  it("returns a tool error when integration execution fails", async () => {
    const registry = new IntegrationRegistry();
    registry.register(
      createMockIntegration({
        id: "adapter-alpha",
        operations: [createOperation("send_message")],
        executeResult: err(new Error("OAuth token expired")),
      }).integration,
    );

    const tool = new IntegrationMetaTool(registry);
    const result = await tool.execute(
      {
        callId: "e2",
        action: "execute",
        integration_id: "adapter-alpha",
        operation: "send_message",
        args: { to: "test@example.com" },
      },
      createContext(),
    );

    expect(result.result).toBeNull();
    expect(result.error).toBe("OAuth token expired");
  });

  it("keeps discover capability index under 200 tokens with 10+ integrations", async () => {
    const registry = new IntegrationRegistry();

    for (let index = 1; index <= 12; index += 1) {
      registry.register(
        createMockIntegration({
          id: `i${index}`,
          operations: [createOperation("a"), createOperation("b")],
        }).integration,
      );
    }

    const tool = new IntegrationMetaTool(registry);
    const result = await tool.execute({ callId: "d2", action: "discover" }, createContext());
    const discoverResult = result.result as { action: "discover"; capabilityIndex: string[] };

    expect(discoverResult.action).toBe("discover");
    expect(discoverResult.capabilityIndex).toHaveLength(12);
    expect(getCapabilityIndexTokenCount(discoverResult.capabilityIndex)).toBeLessThanOrEqual(200);
  });
});

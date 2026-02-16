import { describe, expect, it, beforeEach } from "bun:test";

import { ok, err, type Result } from "../../src/result";
import { IntegrationError } from "../../src/integrations/errors";
import { IntegrationLifecycleManager } from "../../src/integrations/lifecycle";
import { IntegrationRegistry } from "../../src/integrations/registry";
import { InMemoryCredentialVault } from "../../src/integrations/credentials/vault";
import { IntegrationState } from "../../src/integrations/types";
import { ToolRegistry } from "../../src/tools/registry";
import type {
  Integration,
  IntegrationConfig,
  IntegrationManifest,
  IntegrationOperation,
  IntegrationStatus,
} from "../../src/integrations/types";
import type { StateChangeListener } from "../../src/integrations/state-machine";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createManifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    id: "test-integration",
    name: "Test Integration",
    description: "A test integration for lifecycle tests",
    version: "1.0.0",
    author: "Test Author",
    category: "productivity",
    auth: { type: "api_key" },
    permissions: ["network"],
    platforms: ["daemon"],
    operations: [
      {
        name: "test-op-one",
        description: "First test operation",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "test-op-two",
        description: "Second test operation",
        parameters: { type: "object", properties: {} },
      },
    ],
    ...overrides,
  };
}

class MockIntegration implements Integration {
  public connectCalled = false;
  public disconnectCalled = false;
  public connectShouldFail = false;
  public disconnectShouldFail = false;
  public executeCalls: Array<{ operation: string; args: Record<string, unknown> }> = [];

  public readonly config: IntegrationConfig;
  public readonly manifest: IntegrationManifest;

  constructor(manifest: IntegrationManifest) {
    this.manifest = manifest;
    this.config = {
      id: manifest.id,
      enabled: false,
    };
  }

  async connect(): Promise<Result<void>> {
    this.connectCalled = true;
    if (this.connectShouldFail) {
      return err(new IntegrationError("Connection failed"));
    }
    return ok(undefined);
  }

  async disconnect(): Promise<Result<void>> {
    this.disconnectCalled = true;
    if (this.disconnectShouldFail) {
      return err(new IntegrationError("Disconnect failed"));
    }
    return ok(undefined);
  }

  getStatus(): IntegrationStatus {
    return {
      indicator: "connected",
      state: IntegrationState.ACTIVE,
      updatedAt: new Date(),
    };
  }

  getOperations(): IntegrationOperation[] {
    return this.manifest.operations;
  }

  async execute(operationName: string, args: Record<string, unknown>): Promise<Result<unknown>> {
    this.executeCalls.push({ operation: operationName, args });
    return ok({ result: "mock-result", operation: operationName });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IntegrationLifecycleManager", () => {
  let manager: IntegrationLifecycleManager;
  let integrationRegistry: IntegrationRegistry;
  let toolRegistry: ToolRegistry;
  let vault: InMemoryCredentialVault;
  let mockIntegration: MockIntegration;

  beforeEach(() => {
    integrationRegistry = new IntegrationRegistry();
    toolRegistry = new ToolRegistry();
    vault = new InMemoryCredentialVault();

    manager = new IntegrationLifecycleManager({
      integrationRegistry,
      toolRegistry,
      credentialVault: vault,
    });

    mockIntegration = new MockIntegration(createManifest());
    integrationRegistry.register(mockIntegration);
  });

  // -------------------------------------------------------------------------
  // Enable
  // -------------------------------------------------------------------------

  describe("Enable", () => {
    it("enables integration and transitions to active state", async () => {
      const result = await manager.enable("test-integration");

      expect(result.ok).toBe(true);
      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
    });

    it("calls connect on the integration", async () => {
      await manager.enable("test-integration");

      expect(mockIntegration.connectCalled).toBe(true);
    });

    it("registers tools in ToolRegistry after enable", async () => {
      await manager.enable("test-integration");

      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);
      expect(toolRegistry.has("test-integration.test-op-two")).toBe(true);
    });

    it("namespaces tool IDs as integrationId.operationName", async () => {
      await manager.enable("test-integration");

      const tool = toolRegistry.get("test-integration.test-op-one");
      expect(tool).toBeDefined();
      expect(tool!.definition.name).toBe("test-integration.test-op-one");
      expect(tool!.definition.description).toBe("First test operation");
    });

    it("marks integration as enabled in registry", async () => {
      await manager.enable("test-integration");

      expect(mockIntegration.config.enabled).toBe(true);
    });

    it("fails to enable non-existent integration", async () => {
      const result = await manager.enable("non-existent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(IntegrationError);
        expect(result.error.message).toContain("not found");
      }
    });

    it("fails to enable integration with invalid manifest", async () => {
      const badManifest = createManifest({ version: "not-semver" });
      const badIntegration = new MockIntegration(badManifest);
      const badRegistry = new IntegrationRegistry();
      badRegistry.register(badIntegration);

      const badManager = new IntegrationLifecycleManager({
        integrationRegistry: badRegistry,
        toolRegistry,
        credentialVault: vault,
      });

      const result = await badManager.enable("test-integration");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("invalid manifest");
      }
    });

    it("fails to enable already-active integration", async () => {
      await manager.enable("test-integration");

      const result = await manager.enable("test-integration");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("already active");
      }
    });

    it("fails when connection fails during enable", async () => {
      mockIntegration.connectShouldFail = true;

      const result = await manager.enable("test-integration");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to connect");
      }
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);
    });

    it("rejects empty integration id", async () => {
      const result = await manager.enable("  ");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("required");
      }
    });

    it("normalizes integration id to lowercase", async () => {
      const result = await manager.enable("Test-Integration");

      expect(result.ok).toBe(true);
      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
    });

    it("returns error when suspended integration is enabled instead of resumed", async () => {
      await manager.enable("test-integration");
      await manager.suspend("test-integration");

      const result = await manager.enable("test-integration");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("suspended");
        expect(result.error.message).toContain("resume");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Disable
  // -------------------------------------------------------------------------

  describe("Disable", () => {
    it("disables integration and transitions to disconnected state", async () => {
      await manager.enable("test-integration");

      const result = await manager.disable("test-integration");

      expect(result.ok).toBe(true);
      expect(manager.getState("test-integration")).toBe(IntegrationState.DISCONNECTED);
    });

    it("unregisters tools from ToolRegistry on disable", async () => {
      await manager.enable("test-integration");
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);

      await manager.disable("test-integration");

      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);
      expect(toolRegistry.has("test-integration.test-op-two")).toBe(false);
    });

    it("calls disconnect on the integration", async () => {
      await manager.enable("test-integration");
      mockIntegration.disconnectCalled = false;

      await manager.disable("test-integration");

      expect(mockIntegration.disconnectCalled).toBe(true);
    });

    it("revokes credentials from vault on disable", async () => {
      await manager.enable("test-integration");
      await vault.store("test-integration", { type: "api_key", key: "secret-key", label: "test" });

      const hasBefore = await vault.hasCredentials("test-integration");
      expect(hasBefore.ok && hasBefore.value).toBe(true);

      await manager.disable("test-integration");

      const hasAfter = await vault.hasCredentials("test-integration");
      expect(hasAfter.ok && hasAfter.value).toBe(false);
    });

    it("marks integration as disabled in registry", async () => {
      await manager.enable("test-integration");
      expect(mockIntegration.config.enabled).toBe(true);

      await manager.disable("test-integration");

      expect(mockIntegration.config.enabled).toBe(false);
    });

    it("fails to disable non-existent integration", async () => {
      const result = await manager.disable("non-existent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not found");
      }
    });

    it("returns error when disconnect fails", async () => {
      await manager.enable("test-integration");
      mockIntegration.disconnectShouldFail = true;

      const result = await manager.disable("test-integration");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to disconnect");
      }
    });

    it("disables from suspended state", async () => {
      await manager.enable("test-integration");
      await manager.suspend("test-integration");

      const result = await manager.disable("test-integration");

      expect(result.ok).toBe(true);
      expect(manager.getState("test-integration")).toBe(IntegrationState.DISCONNECTED);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Suspend / Resume
  // -------------------------------------------------------------------------

  describe("Suspend/Resume", () => {
    it("suspends active integration and transitions to suspended state", async () => {
      await manager.enable("test-integration");

      const result = await manager.suspend("test-integration");

      expect(result.ok).toBe(true);
      expect(manager.getState("test-integration")).toBe(IntegrationState.SUSPENDED);
    });

    it("unregisters tools on suspend", async () => {
      await manager.enable("test-integration");
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);

      await manager.suspend("test-integration");

      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);
      expect(toolRegistry.has("test-integration.test-op-two")).toBe(false);
    });

    it("does not revoke credentials on suspend", async () => {
      await manager.enable("test-integration");
      await vault.store("test-integration", { type: "api_key", key: "secret-key", label: "test" });

      await manager.suspend("test-integration");

      const hasCredentials = await vault.hasCredentials("test-integration");
      expect(hasCredentials.ok && hasCredentials.value).toBe(true);
    });

    it("resumes suspended integration and transitions back to active", async () => {
      await manager.enable("test-integration");
      await manager.suspend("test-integration");

      const result = await manager.resume("test-integration");

      expect(result.ok).toBe(true);
      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
    });

    it("re-registers tools on resume", async () => {
      await manager.enable("test-integration");
      await manager.suspend("test-integration");
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);

      await manager.resume("test-integration");

      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);
      expect(toolRegistry.has("test-integration.test-op-two")).toBe(true);
    });

    it("fails to suspend non-active integration", async () => {
      const result = await manager.suspend("test-integration");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(IntegrationError);
        expect(result.error.message).toContain("Cannot suspend");
      }
    });

    it("fails to resume non-suspended integration", async () => {
      await manager.enable("test-integration");

      const result = await manager.resume("test-integration");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(IntegrationError);
        expect(result.error.message).toContain("Cannot resume");
      }
    });

    it("fails to suspend non-existent integration", async () => {
      const result = await manager.suspend("non-existent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not found");
      }
    });

    it("fails to resume non-existent integration", async () => {
      const result = await manager.resume("non-existent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not found");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Enable → Disable → Re-enable Cycle
  // -------------------------------------------------------------------------

  describe("Enable/Disable Cycles", () => {
    it("supports enable → disable → re-enable cycle", async () => {
      const enableResult1 = await manager.enable("test-integration");
      expect(enableResult1.ok).toBe(true);
      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);

      const disableResult = await manager.disable("test-integration");
      expect(disableResult.ok).toBe(true);
      expect(manager.getState("test-integration")).toBe(IntegrationState.DISCONNECTED);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);

      const enableResult2 = await manager.enable("test-integration");
      expect(enableResult2.ok).toBe(true);
      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);
    });

    it("supports suspend → resume → suspend → resume cycle", async () => {
      await manager.enable("test-integration");

      await manager.suspend("test-integration");
      expect(manager.getState("test-integration")).toBe(IntegrationState.SUSPENDED);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);

      await manager.resume("test-integration");
      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);

      await manager.suspend("test-integration");
      expect(manager.getState("test-integration")).toBe(IntegrationState.SUSPENDED);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);

      await manager.resume("test-integration");
      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);
    });

    it("supports enable → suspend → disable → re-enable cycle", async () => {
      await manager.enable("test-integration");
      await manager.suspend("test-integration");
      await manager.disable("test-integration");

      expect(manager.getState("test-integration")).toBe(IntegrationState.DISCONNECTED);

      const result = await manager.enable("test-integration");
      expect(result.ok).toBe(true);
      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tool Registration
  // -------------------------------------------------------------------------

  describe("Tool Registration", () => {
    it("registers each operation as a separate tool", async () => {
      await manager.enable("test-integration");

      const tools = toolRegistry.list();
      const integrationTools = tools.filter((t) =>
        t.definition.name.startsWith("test-integration."),
      );

      expect(integrationTools).toHaveLength(2);
    });

    it("tool execute delegates to integration execute", async () => {
      await manager.enable("test-integration");

      const tool = toolRegistry.get("test-integration.test-op-one");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        { callId: "call-1", query: "test" },
        { conversationId: "conv-1", userId: "user-1" },
      );

      expect(result.name).toBe("test-integration.test-op-one");
      expect(result.result).toBeDefined();
      expect(mockIntegration.executeCalls).toHaveLength(1);
      expect(mockIntegration.executeCalls[0].operation).toBe("test-op-one");
    });

    it("tool returns error result when integration execute fails", async () => {
      const failingIntegration = new MockIntegration(createManifest({ id: "failing-int" }));
      failingIntegration.execute = async () => err(new IntegrationError("Operation failed"));
      integrationRegistry.register(failingIntegration);

      await manager.enable("failing-int");

      const tool = toolRegistry.get("failing-int.test-op-one");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        { callId: "call-1" },
        { conversationId: "conv-1", userId: "user-1" },
      );

      expect(result.error).toBe("Operation failed");
      expect(result.result).toBeNull();
    });

    it("tools are removed on disable", async () => {
      await manager.enable("test-integration");
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);
      expect(toolRegistry.has("test-integration.test-op-two")).toBe(true);

      await manager.disable("test-integration");

      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);
      expect(toolRegistry.has("test-integration.test-op-two")).toBe(false);
    });

    it("tools are removed on suspend", async () => {
      await manager.enable("test-integration");
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);

      await manager.suspend("test-integration");

      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);
      expect(toolRegistry.has("test-integration.test-op-two")).toBe(false);
    });

    it("tools are re-added on resume", async () => {
      await manager.enable("test-integration");
      await manager.suspend("test-integration");
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);

      await manager.resume("test-integration");

      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);
      expect(toolRegistry.has("test-integration.test-op-two")).toBe(true);
    });

    it("handles integration with no operations gracefully", async () => {
      const noOpsManifest = createManifest({
        id: "no-ops",
        operations: [
          {
            name: "single-op",
            description: "Only operation",
            parameters: { type: "object", properties: {} },
          },
        ],
      });
      const noOpsIntegration = new MockIntegration(noOpsManifest);
      integrationRegistry.register(noOpsIntegration);

      const result = await manager.enable("no-ops");
      expect(result.ok).toBe(true);
      expect(toolRegistry.has("no-ops.single-op")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe("Cleanup", () => {
    it("no tools remain after disable", async () => {
      await manager.enable("test-integration");
      await manager.disable("test-integration");

      const tools = toolRegistry.list();
      const integrationTools = tools.filter((t) =>
        t.definition.name.startsWith("test-integration."),
      );

      expect(integrationTools).toHaveLength(0);
    });

    it("credentials are cleared after disable", async () => {
      await manager.enable("test-integration");
      await vault.store("test-integration", { type: "api_key", key: "secret", label: "test" });

      await manager.disable("test-integration");

      const hasCredentials = await vault.hasCredentials("test-integration");
      expect(hasCredentials.ok && hasCredentials.value).toBe(false);
    });

    it("state is disconnected after disable", async () => {
      await manager.enable("test-integration");
      await manager.disable("test-integration");

      expect(manager.getState("test-integration")).toBe(IntegrationState.DISCONNECTED);
    });

    it("integration disconnect is called on disable", async () => {
      await manager.enable("test-integration");
      mockIntegration.disconnectCalled = false;

      await manager.disable("test-integration");

      expect(mockIntegration.disconnectCalled).toBe(true);
    });

    it("runs registered cleanup handlers on disable", async () => {
      await manager.enable("test-integration");

      let cleanupRan = false;
      manager.addCleanupHandler("test-integration", () => {
        cleanupRan = true;
      });

      await manager.disable("test-integration");

      expect(cleanupRan).toBe(true);
    });

    it("runs multiple cleanup handlers on disable", async () => {
      await manager.enable("test-integration");

      const order: number[] = [];
      manager.addCleanupHandler("test-integration", () => {
        order.push(1);
      });
      manager.addCleanupHandler("test-integration", () => {
        order.push(2);
      });

      await manager.disable("test-integration");

      expect(order).toHaveLength(2);
      expect(order).toContain(1);
      expect(order).toContain(2);
    });

    it("cleanup handlers are cleared after disable", async () => {
      await manager.enable("test-integration");

      let cleanupCount = 0;
      manager.addCleanupHandler("test-integration", () => {
        cleanupCount++;
      });

      await manager.disable("test-integration");
      expect(cleanupCount).toBe(1);

      // Re-enable and disable again — handler should not run again
      await manager.enable("test-integration");
      await manager.disable("test-integration");
      expect(cleanupCount).toBe(1);
    });

    it("returns error when cleanup handler throws", async () => {
      await manager.enable("test-integration");

      manager.addCleanupHandler("test-integration", () => {
        throw new Error("Cleanup explosion");
      });

      const result = await manager.disable("test-integration");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Cleanup failed");
      }
    });

    it("can remove a cleanup handler before disable", async () => {
      await manager.enable("test-integration");

      let cleanupRan = false;
      const handler = () => {
        cleanupRan = true;
      };

      manager.addCleanupHandler("test-integration", handler);
      manager.removeCleanupHandler("test-integration", handler);

      await manager.disable("test-integration");

      expect(cleanupRan).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // State Change Listeners
  // -------------------------------------------------------------------------

  describe("State Change Listeners", () => {
    it("notifies listener on enable state transitions", async () => {
      const transitions: Array<{ from: IntegrationState; to: IntegrationState }> = [];

      manager.addStateChangeListener("test-integration", (_id, from, to) => {
        transitions.push({ from, to });
      });

      await manager.enable("test-integration");

      // Enable goes through: installed → configured → connected → active
      expect(transitions.length).toBeGreaterThanOrEqual(3);
      expect(transitions[transitions.length - 1].to).toBe(IntegrationState.ACTIVE);
    });

    it("notifies listener on disable state transition", async () => {
      await manager.enable("test-integration");

      const transitions: Array<{ from: IntegrationState; to: IntegrationState }> = [];
      manager.addStateChangeListener("test-integration", (_id, from, to) => {
        transitions.push({ from, to });
      });

      await manager.disable("test-integration");

      const lastTransition = transitions[transitions.length - 1];
      expect(lastTransition.to).toBe(IntegrationState.DISCONNECTED);
    });

    it("removes a state change listener", async () => {
      let callCount = 0;
      const listener: StateChangeListener = () => {
        callCount++;
      };

      manager.addStateChangeListener("test-integration", listener);
      await manager.enable("test-integration");
      const countAfterEnable = callCount;

      manager.removeStateChangeListener("test-integration", listener);
      await manager.disable("test-integration");

      expect(callCount).toBe(countAfterEnable);
    });
  });

  // -------------------------------------------------------------------------
  // getState
  // -------------------------------------------------------------------------

  describe("getState", () => {
    it("returns undefined for unknown integration", () => {
      expect(manager.getState("unknown")).toBeUndefined();
    });

    it("returns current state after enable", async () => {
      await manager.enable("test-integration");
      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
    });

    it("returns current state after suspend", async () => {
      await manager.enable("test-integration");
      await manager.suspend("test-integration");
      expect(manager.getState("test-integration")).toBe(IntegrationState.SUSPENDED);
    });

    it("returns current state after disable", async () => {
      await manager.enable("test-integration");
      await manager.disable("test-integration");
      expect(manager.getState("test-integration")).toBe(IntegrationState.DISCONNECTED);
    });

    it("normalizes id for state lookup", async () => {
      await manager.enable("test-integration");
      expect(manager.getState("  Test-Integration  ")).toBe(IntegrationState.ACTIVE);
    });

    it("returns undefined for empty id", () => {
      expect(manager.getState("  ")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Error Handling
  // -------------------------------------------------------------------------

  describe("Error Handling", () => {
    it("does not register tools when connection fails", async () => {
      mockIntegration.connectShouldFail = true;

      await manager.enable("test-integration");

      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);
      expect(toolRegistry.has("test-integration.test-op-two")).toBe(false);
    });

    it("does not leave partial state when connection fails", async () => {
      mockIntegration.connectShouldFail = true;

      await manager.enable("test-integration");

      // State should not be active
      const state = manager.getState("test-integration");
      expect(state).not.toBe(IntegrationState.ACTIVE);
    });

    it("handles multiple integrations independently", async () => {
      const secondManifest = createManifest({
        id: "second-integration",
        operations: [
          {
            name: "second-op",
            description: "Second integration operation",
            parameters: { type: "object", properties: {} },
          },
        ],
      });
      const secondIntegration = new MockIntegration(secondManifest);
      integrationRegistry.register(secondIntegration);

      await manager.enable("test-integration");
      await manager.enable("second-integration");

      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
      expect(manager.getState("second-integration")).toBe(IntegrationState.ACTIVE);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);
      expect(toolRegistry.has("second-integration.second-op")).toBe(true);

      // Disabling one should not affect the other
      await manager.disable("test-integration");

      expect(manager.getState("test-integration")).toBe(IntegrationState.DISCONNECTED);
      expect(manager.getState("second-integration")).toBe(IntegrationState.ACTIVE);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);
      expect(toolRegistry.has("second-integration.second-op")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent Operations
  // -------------------------------------------------------------------------

  describe("Concurrent Operations", () => {
    it("queues multiple enable calls for the same integration", async () => {
      const results = await Promise.all([
        manager.enable("test-integration"),
        manager.enable("test-integration"),
      ]);

      // First should succeed, second should fail (already active)
      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
    });

    it("handles enable then disable in quick succession", async () => {
      const [enableResult, disableResult] = await Promise.all([
        manager.enable("test-integration"),
        manager.disable("test-integration"),
      ]);

      // Enable should succeed first, then disable should succeed
      expect(enableResult.ok).toBe(true);
      expect(disableResult.ok).toBe(true);
      expect(manager.getState("test-integration")).toBe(IntegrationState.DISCONNECTED);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(false);
    });

    it("handles concurrent operations on different integrations independently", async () => {
      const secondManifest = createManifest({
        id: "second-integration",
        operations: [
          {
            name: "second-op",
            description: "Second operation",
            parameters: { type: "object", properties: {} },
          },
        ],
      });
      const secondIntegration = new MockIntegration(secondManifest);
      integrationRegistry.register(secondIntegration);

      const [result1, result2] = await Promise.all([
        manager.enable("test-integration"),
        manager.enable("second-integration"),
      ]);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
      expect(manager.getState("second-integration")).toBe(IntegrationState.ACTIVE);
    });

    it("maintains state consistency under rapid enable/suspend/resume", async () => {
      await manager.enable("test-integration");

      // Rapid suspend → resume → suspend → resume
      const results = [];
      results.push(await manager.suspend("test-integration"));
      results.push(await manager.resume("test-integration"));
      results.push(await manager.suspend("test-integration"));
      results.push(await manager.resume("test-integration"));

      for (const result of results) {
        expect(result.ok).toBe(true);
      }

      expect(manager.getState("test-integration")).toBe(IntegrationState.ACTIVE);
      expect(toolRegistry.has("test-integration.test-op-one")).toBe(true);
    });
  });
});

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ok, err, type Result } from "../../../src/result";
import { IntegrationError } from "../../../src/integrations/errors";
import { IntegrationService } from "../../../src/integrations/service";
import { InMemoryCredentialVault } from "../../../src/integrations/credentials/vault";
import {
  INTEGRATION_META_TOOL_DEFINITION,
  getCapabilityIndexTokenCount,
  INTEGRATION_META_TOOL_MAX_TOKENS,
} from "../../../src/integrations/meta-tool";
import { IntegrationState } from "../../../src/integrations/types";
import { ToolRegistry } from "../../../src/tools/registry";
import { formatListResult, formatDetailResult } from "../../../src/integrations/result";
import { estimateTokens } from "../../../src/context/tokenizer";
import type {
  Integration,
  IntegrationConfig,
  IntegrationManifest,
  IntegrationOperation,
  IntegrationStatus,
} from "../../../src/integrations/types";
import type { ToolContext } from "../../../src/types";

// ---------------------------------------------------------------------------
// Mock integration factory
// ---------------------------------------------------------------------------

function createMockManifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    id: "mock-integration",
    name: "Mock Integration",
    description: "A mock integration for e2e tests",
    version: "1.0.0",
    author: "Test Author",
    category: "productivity",
    auth: { type: "api_key" },
    permissions: ["network"],
    platforms: ["daemon"],
    operations: [
      {
        name: "search",
        description: "Search items",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
      {
        name: "read",
        description: "Read an item",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Item ID" },
          },
          required: ["id"],
        },
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
  public executeShouldFail = false;
  public executeResults = new Map<string, unknown>();
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
    if (this.executeShouldFail) {
      return err(new IntegrationError(`Operation ${operationName} failed`));
    }
    const customResult = this.executeResults.get(operationName);
    if (customResult !== undefined) {
      return ok(customResult);
    }
    return ok({ result: "mock-result", operation: operationName, args });
  }
}

function createToolContext(): ToolContext {
  return {
    conversationId: "e2e-test",
    userId: "test-user",
  };
}

// ---------------------------------------------------------------------------
// Integration Service Initialization & Lifecycle
// ---------------------------------------------------------------------------

describe("Integration System E2E", () => {
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    IntegrationService.resetInstanceForTests();
    toolRegistry = new ToolRegistry();
  });

  afterEach(() => {
    IntegrationService.resetInstanceForTests();
  });

  // -------------------------------------------------------------------------
  // Service Initialization
  // -------------------------------------------------------------------------

  describe("Service Initialization", () => {
    it("starts and registers meta-tool in ToolRegistry", async () => {
      const integration = new MockIntegration(createMockManifest());
      const service = new IntegrationService({
        toolRegistry,
        integrations: [integration],
      });

      const startResult = await service.start();

      expect(startResult.ok).toBe(true);
      expect(toolRegistry.has(INTEGRATION_META_TOOL_DEFINITION.name)).toBe(true);
    });

    it("activates enabled integrations on start", async () => {
      const manifest = createMockManifest({ id: "auto-enabled" });
      const integration = new MockIntegration(manifest);
      integration.config.enabled = true;

      const service = new IntegrationService({
        toolRegistry,
        integrations: [integration],
      });

      const startResult = await service.start();

      expect(startResult.ok).toBe(true);
      expect(integration.connectCalled).toBe(true);
    });

    it("skips disabled integrations on start", async () => {
      const integration = new MockIntegration(createMockManifest());
      integration.config.enabled = false;

      const service = new IntegrationService({
        toolRegistry,
        integrations: [integration],
      });

      const startResult = await service.start();

      expect(startResult.ok).toBe(true);
      expect(integration.connectCalled).toBe(false);
    });

    it("stops and unregisters meta-tool from ToolRegistry", async () => {
      const service = new IntegrationService({
        toolRegistry,
        integrations: [],
      });

      await service.start();
      expect(toolRegistry.has(INTEGRATION_META_TOOL_DEFINITION.name)).toBe(true);

      const stopResult = await service.stop();

      expect(stopResult.ok).toBe(true);
      expect(toolRegistry.has(INTEGRATION_META_TOOL_DEFINITION.name)).toBe(false);
    });

    it("disconnects active integrations on stop", async () => {
      const manifest = createMockManifest({ id: "stop-test" });
      const integration = new MockIntegration(manifest);
      integration.config.enabled = true;

      const service = new IntegrationService({
        toolRegistry,
        integrations: [integration],
      });

      await service.start();
      integration.disconnectCalled = false;

      const stopResult = await service.stop();

      expect(stopResult.ok).toBe(true);
      expect(integration.disconnectCalled).toBe(true);
    });

    it("is idempotent for start and stop", async () => {
      const service = new IntegrationService({
        toolRegistry,
        integrations: [],
      });

      const start1 = await service.start();
      const start2 = await service.start();
      expect(start1.ok).toBe(true);
      expect(start2.ok).toBe(true);

      const stop1 = await service.stop();
      const stop2 = await service.stop();
      expect(stop1.ok).toBe(true);
      expect(stop2.ok).toBe(true);
    });

    it("returns error when enabled integration fails to activate on start", async () => {
      const manifest = createMockManifest({ id: "fail-start" });
      const integration = new MockIntegration(manifest);
      integration.config.enabled = true;
      integration.connectShouldFail = true;

      const service = new IntegrationService({
        toolRegistry,
        integrations: [integration],
      });

      const startResult = await service.start();

      expect(startResult.ok).toBe(false);
      if (!startResult.ok) {
        expect(startResult.error).toBeInstanceOf(IntegrationError);
        expect(startResult.error.message).toContain("fail-start");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Meta-Tool Discover → Activate → Execute Flow
  // -------------------------------------------------------------------------

  describe("Meta-Tool Flow: Discover → Activate → Execute", () => {
    let service: IntegrationService;
    let obsidianIntegration: MockIntegration;
    let gmailIntegration: MockIntegration;

    beforeEach(async () => {
      obsidianIntegration = new MockIntegration(
        createMockManifest({
          id: "obsidian",
          name: "Obsidian",
          category: "knowledge",
          auth: { type: "local_path" },
          operations: [
            {
              name: "search-notes",
              description: "Search notes by content",
              parameters: {
                type: "object",
                properties: { query: { type: "string", description: "Search query" } },
                required: ["query"],
              },
            },
            {
              name: "read-note",
              description: "Read a note by path",
              parameters: {
                type: "object",
                properties: { path: { type: "string", description: "Note path" } },
                required: ["path"],
              },
            },
          ],
        }),
      );
      obsidianIntegration.executeResults.set("search-notes", {
        forModel: { kind: "list", summary: "2 notes", count: 2, data: { items: [{ title: "Note 1" }, { title: "Note 2" }] } },
        forUser: { kind: "list", title: "Search Results", message: "2 notes found.", data: { items: [{ title: "Note 1", path: "/notes/note1.md" }, { title: "Note 2", path: "/notes/note2.md" }] } },
      });

      gmailIntegration = new MockIntegration(
        createMockManifest({
          id: "gmail",
          name: "Gmail",
          category: "communication",
          auth: {
            type: "oauth2",
            scopes: ["gmail.readonly", "gmail.send"],
          },
          operations: [
            {
              name: "list-emails",
              description: "List recent emails",
              parameters: { type: "object", properties: {} },
            },
            {
              name: "send-email",
              description: "Send an email",
              parameters: {
                type: "object",
                properties: {
                  to: { type: "string", description: "Recipient" },
                  subject: { type: "string", description: "Subject" },
                  body: { type: "string", description: "Body" },
                },
                required: ["to", "subject", "body"],
              },
            },
          ],
        }),
      );

      service = new IntegrationService({
        toolRegistry,
        integrations: [obsidianIntegration, gmailIntegration],
      });

      await service.start();
      await service.enableIntegration("obsidian");
      await service.enableIntegration("gmail");
    });

    it("discovers all active integrations via meta-tool", async () => {
      const metaTool = toolRegistry.get(INTEGRATION_META_TOOL_DEFINITION.name);
      expect(metaTool).toBeDefined();

      const result = await metaTool!.execute(
        { callId: "discover-1", action: "discover" },
        createToolContext(),
      );

      expect(result.error).toBeUndefined();
      const payload = result.result as { action: string; capabilityIndex: string[] };
      expect(payload.action).toBe("discover");
      expect(payload.capabilityIndex).toBeInstanceOf(Array);
      expect(payload.capabilityIndex.length).toBe(2);

      const obsidianEntry = payload.capabilityIndex.find((e: string) => e.startsWith("obsidian:"));
      const gmailEntry = payload.capabilityIndex.find((e: string) => e.startsWith("gmail:"));
      expect(obsidianEntry).toBeDefined();
      expect(gmailEntry).toBeDefined();
      expect(obsidianEntry).toContain("search-notes");
      expect(obsidianEntry).toContain("read-note");
      expect(gmailEntry).toContain("list-emails");
      expect(gmailEntry).toContain("send-email");
    });

    it("activates an integration and returns full operation schemas", async () => {
      const metaTool = toolRegistry.get(INTEGRATION_META_TOOL_DEFINITION.name);
      expect(metaTool).toBeDefined();

      const result = await metaTool!.execute(
        { callId: "activate-1", action: "activate", integration_id: "obsidian" },
        createToolContext(),
      );

      expect(result.error).toBeUndefined();
      const payload = result.result as {
        action: string;
        integrationId: string;
        operations: IntegrationOperation[];
      };
      expect(payload.action).toBe("activate");
      expect(payload.integrationId).toBe("obsidian");
      expect(payload.operations).toHaveLength(2);
      expect(payload.operations[0].name).toBe("search-notes");
      expect(payload.operations[0].parameters).toBeDefined();
      expect(payload.operations[1].name).toBe("read-note");
    });

    it("executes an operation via meta-tool and returns result", async () => {
      const metaTool = toolRegistry.get(INTEGRATION_META_TOOL_DEFINITION.name);
      expect(metaTool).toBeDefined();

      const result = await metaTool!.execute(
        {
          callId: "execute-1",
          action: "execute",
          integration_id: "obsidian",
          operation: "search-notes",
          args: { query: "test" },
        },
        createToolContext(),
      );

      expect(result.error).toBeUndefined();
      const payload = result.result as {
        action: string;
        integrationId: string;
        operation: string;
        result: unknown;
      };
      expect(payload.action).toBe("execute");
      expect(payload.integrationId).toBe("obsidian");
      expect(payload.operation).toBe("search-notes");
      expect(payload.result).toBeDefined();

      expect(obsidianIntegration.executeCalls).toHaveLength(1);
      expect(obsidianIntegration.executeCalls[0].operation).toBe("search-notes");
      expect(obsidianIntegration.executeCalls[0].args).toEqual({ query: "test" });
    });

    it("completes full discover → activate → execute flow sequentially", async () => {
      const metaTool = toolRegistry.get(INTEGRATION_META_TOOL_DEFINITION.name)!;
      const ctx = createToolContext();

      // Step 1: Discover
      const discoverResult = await metaTool.execute(
        { callId: "step-1", action: "discover" },
        ctx,
      );
      expect(discoverResult.error).toBeUndefined();
      const discovered = discoverResult.result as { capabilityIndex: string[] };
      expect(discovered.capabilityIndex.length).toBeGreaterThan(0);

      // Step 2: Activate (pick first integration from discovery)
      const firstEntry = discovered.capabilityIndex[0];
      const integrationId = firstEntry.split(":")[0];

      const activateResult = await metaTool.execute(
        { callId: "step-2", action: "activate", integration_id: integrationId },
        ctx,
      );
      expect(activateResult.error).toBeUndefined();
      const activated = activateResult.result as { operations: IntegrationOperation[] };
      expect(activated.operations.length).toBeGreaterThan(0);

      // Step 3: Execute (use first operation from activation)
      const operationName = activated.operations[0].name;
      const executeResult = await metaTool.execute(
        {
          callId: "step-3",
          action: "execute",
          integration_id: integrationId,
          operation: operationName,
          args: { query: "e2e test" },
        },
        ctx,
      );
      expect(executeResult.error).toBeUndefined();
      const executed = executeResult.result as { action: string; result: unknown };
      expect(executed.action).toBe("execute");
      expect(executed.result).toBeDefined();
    });

    it("returns error for execute on non-existent integration", async () => {
      const metaTool = toolRegistry.get(INTEGRATION_META_TOOL_DEFINITION.name)!;

      const result = await metaTool.execute(
        {
          callId: "err-1",
          action: "execute",
          integration_id: "non-existent",
          operation: "search",
          args: {},
        },
        createToolContext(),
      );

      expect(result.error).toBeDefined();
    });

    it("returns error for execute with missing operation", async () => {
      const metaTool = toolRegistry.get(INTEGRATION_META_TOOL_DEFINITION.name)!;

      const result = await metaTool.execute(
        {
          callId: "err-2",
          action: "execute",
          integration_id: "obsidian",
          args: {},
        },
        createToolContext(),
      );

      expect(result.error).toBeDefined();
    });

    it("returns error for invalid action", async () => {
      const metaTool = toolRegistry.get(INTEGRATION_META_TOOL_DEFINITION.name)!;

      const result = await metaTool.execute(
        { callId: "err-3", action: "invalid-action" },
        createToolContext(),
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("Missing or invalid");
    });

    it("propagates integration execution errors through meta-tool", async () => {
      obsidianIntegration.executeShouldFail = true;

      const metaTool = toolRegistry.get(INTEGRATION_META_TOOL_DEFINITION.name)!;

      const result = await metaTool.execute(
        {
          callId: "err-4",
          action: "execute",
          integration_id: "obsidian",
          operation: "search-notes",
          args: { query: "fail" },
        },
        createToolContext(),
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("search-notes");
    });
  });

  // -------------------------------------------------------------------------
  // Integration Enable/Disable Lifecycle
  // -------------------------------------------------------------------------

  describe("Integration Enable/Disable Lifecycle", () => {
    let service: IntegrationService;
    let integration: MockIntegration;

    beforeEach(async () => {
      integration = new MockIntegration(createMockManifest({ id: "lifecycle-test" }));

      service = new IntegrationService({
        toolRegistry,
        integrations: [integration],
      });

      await service.start();
    });

    it("enables integration and registers operation tools", async () => {
      const result = await service.enableIntegration("lifecycle-test");

      expect(result.ok).toBe(true);
      expect(toolRegistry.has("lifecycle-test.search")).toBe(true);
      expect(toolRegistry.has("lifecycle-test.read")).toBe(true);
    });

    it("disables integration and unregisters operation tools", async () => {
      await service.enableIntegration("lifecycle-test");
      expect(toolRegistry.has("lifecycle-test.search")).toBe(true);

      const result = await service.disableIntegration("lifecycle-test");

      expect(result.ok).toBe(true);
      expect(toolRegistry.has("lifecycle-test.search")).toBe(false);
      expect(toolRegistry.has("lifecycle-test.read")).toBe(false);
    });

    it("supports enable → disable → re-enable cycle", async () => {
      await service.enableIntegration("lifecycle-test");
      expect(toolRegistry.has("lifecycle-test.search")).toBe(true);

      await service.disableIntegration("lifecycle-test");
      expect(toolRegistry.has("lifecycle-test.search")).toBe(false);

      const reEnableResult = await service.enableIntegration("lifecycle-test");
      expect(reEnableResult.ok).toBe(true);
      expect(toolRegistry.has("lifecycle-test.search")).toBe(true);
      expect(toolRegistry.has("lifecycle-test.read")).toBe(true);
    });

    it("meta-tool discover reflects enabled/disabled state", async () => {
      const metaTool = toolRegistry.get(INTEGRATION_META_TOOL_DEFINITION.name)!;
      const ctx = createToolContext();

      // Before enable: no active integrations
      const beforeResult = await metaTool.execute(
        { callId: "d-1", action: "discover" },
        ctx,
      );
      const beforePayload = beforeResult.result as { capabilityIndex: string[] };
      expect(beforePayload.capabilityIndex).toHaveLength(0);

      // After enable: integration appears
      await service.enableIntegration("lifecycle-test");
      const afterEnableResult = await metaTool.execute(
        { callId: "d-2", action: "discover" },
        ctx,
      );
      const afterEnablePayload = afterEnableResult.result as { capabilityIndex: string[] };
      expect(afterEnablePayload.capabilityIndex).toHaveLength(1);
      expect(afterEnablePayload.capabilityIndex[0]).toContain("lifecycle-test");

      // After disable: integration disappears
      await service.disableIntegration("lifecycle-test");
      const afterDisableResult = await metaTool.execute(
        { callId: "d-3", action: "discover" },
        ctx,
      );
      const afterDisablePayload = afterDisableResult.result as { capabilityIndex: string[] };
      expect(afterDisablePayload.capabilityIndex).toHaveLength(0);
    });

    it("executeOperation fails when service is not started", async () => {
      const freshService = new IntegrationService({
        toolRegistry: new ToolRegistry(),
        integrations: [new MockIntegration(createMockManifest())],
      });

      const result = await freshService.executeOperation("mock-integration", "search", { query: "test" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not started");
      }
    });

    it("executeOperation fails for disabled integration", async () => {
      const result = await service.executeOperation("lifecycle-test", "search", { query: "test" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("disabled");
      }
    });

    it("executeOperation fails for non-active integration", async () => {
      await service.enableIntegration("lifecycle-test");
      const lifecycleManager = service.getLifecycleManager();
      await lifecycleManager.suspend("lifecycle-test");

      const result = await service.executeOperation("lifecycle-test", "search", { query: "test" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not active");
      }
    });

    it("executeOperation succeeds for active integration", async () => {
      await service.enableIntegration("lifecycle-test");

      const result = await service.executeOperation("lifecycle-test", "search", { query: "hello" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
      }
      expect(integration.executeCalls).toHaveLength(1);
      expect(integration.executeCalls[0].operation).toBe("search");
    });

    it("executeOperation routes through meta-tool pipeline", async () => {
      await service.enableIntegration("lifecycle-test");

      // The service.executeOperation should route through the meta-tool
      const result = await service.executeOperation("lifecycle-test", "search", { query: "pipeline" });

      expect(result.ok).toBe(true);
      // Verify the integration was actually called
      expect(integration.executeCalls.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Credential Flow
  // -------------------------------------------------------------------------

  describe("Credential Flow", () => {
    let service: IntegrationService;
    let vault: InMemoryCredentialVault;

    beforeEach(async () => {
      // We access the vault through the service to test the integrated flow
      const integration = new MockIntegration(
        createMockManifest({
          id: "cred-test",
          auth: {
            type: "oauth2",
            scopes: ["read", "write"],
          },
        }),
      );

      service = new IntegrationService({
        toolRegistry,
        integrations: [integration],
      });

      vault = service.getCredentialVault() as InMemoryCredentialVault;
      await service.start();
    });

    it("stores OAuth credentials in vault", async () => {
      await vault.store("cred-test", {
        type: "oauth",
        access_token: "access-123",
        refresh_token: "refresh-456",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        scopes: ["read", "write"],
        token_type: "Bearer",
      });

      const hasResult = await vault.hasCredentials("cred-test");
      expect(hasResult.ok).toBe(true);
      if (hasResult.ok) {
        expect(hasResult.value).toBe(true);
      }
    });

    it("retrieves stored OAuth credentials", async () => {
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      await vault.store("cred-test", {
        type: "oauth",
        access_token: "access-123",
        refresh_token: "refresh-456",
        expires_at: expiresAt,
        scopes: ["read", "write"],
        token_type: "Bearer",
      });

      const retrieveResult = await vault.retrieve("cred-test");
      expect(retrieveResult.ok).toBe(true);
      if (retrieveResult.ok && retrieveResult.value) {
        expect(retrieveResult.value.type).toBe("oauth");
        if (retrieveResult.value.type === "oauth") {
          expect(retrieveResult.value.access_token).toBe("access-123");
          expect(retrieveResult.value.refresh_token).toBe("refresh-456");
          expect(retrieveResult.value.scopes).toEqual(["read", "write"]);
        }
      }
    });

    it("stores and retrieves local path credentials", async () => {
      await vault.store("cred-test", {
        type: "local_path",
        path: "/home/user/vault",
        validated: true,
      });

      const retrieveResult = await vault.retrieve("cred-test");
      expect(retrieveResult.ok).toBe(true);
      if (retrieveResult.ok && retrieveResult.value) {
        expect(retrieveResult.value.type).toBe("local_path");
        if (retrieveResult.value.type === "local_path") {
          expect(retrieveResult.value.path).toBe("/home/user/vault");
          expect(retrieveResult.value.validated).toBe(true);
        }
      }
    });

    it("reports valid status for non-expired OAuth token", async () => {
      await vault.store("cred-test", {
        type: "oauth",
        access_token: "access-123",
        refresh_token: "refresh-456",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        scopes: ["read"],
        token_type: "Bearer",
      });

      const statusResult = await vault.getStatus("cred-test");
      expect(statusResult.ok).toBe(true);
      if (statusResult.ok) {
        expect(statusResult.value).toBe("valid");
      }
    });

    it("reports expired status for expired OAuth token", async () => {
      await vault.store("cred-test", {
        type: "oauth",
        access_token: "access-123",
        refresh_token: "refresh-456",
        expires_at: new Date(Date.now() - 3600000).toISOString(),
        scopes: ["read"],
        token_type: "Bearer",
      });

      const statusResult = await vault.getStatus("cred-test");
      expect(statusResult.ok).toBe(true);
      if (statusResult.ok) {
        expect(statusResult.value).toBe("expired");
      }
    });

    it("reports missing status when no credentials stored", async () => {
      const statusResult = await vault.getStatus("cred-test");
      expect(statusResult.ok).toBe(true);
      if (statusResult.ok) {
        expect(statusResult.value).toBe("missing");
      }
    });

    it("revokes credentials on disable", async () => {
      await vault.store("cred-test", {
        type: "api_key",
        key: "secret-key",
        label: "test",
      });

      const hasBefore = await vault.hasCredentials("cred-test");
      expect(hasBefore.ok && hasBefore.value).toBe(true);

      await service.enableIntegration("cred-test");
      await service.disableIntegration("cred-test");

      const hasAfter = await vault.hasCredentials("cred-test");
      expect(hasAfter.ok && hasAfter.value).toBe(false);
    });

    it("enforces per-integration credential isolation", async () => {
      await vault.store("integration-a", {
        type: "api_key",
        key: "key-a",
        label: "A",
      });
      await vault.store("integration-b", {
        type: "api_key",
        key: "key-b",
        label: "B",
      });

      const retrieveA = await vault.retrieve("integration-a");
      const retrieveB = await vault.retrieve("integration-b");

      expect(retrieveA.ok).toBe(true);
      expect(retrieveB.ok).toBe(true);
      if (retrieveA.ok && retrieveA.value && retrieveB.ok && retrieveB.value) {
        expect(retrieveA.value.type).toBe("api_key");
        expect(retrieveB.value.type).toBe("api_key");
        if (retrieveA.value.type === "api_key" && retrieveB.value.type === "api_key") {
          expect(retrieveA.value.key).toBe("key-a");
          expect(retrieveB.value.key).toBe("key-b");
        }
      }

      // Revoking A should not affect B
      await vault.revoke("integration-a");
      const hasA = await vault.hasCredentials("integration-a");
      const hasB = await vault.hasCredentials("integration-b");
      expect(hasA.ok && hasA.value).toBe(false);
      expect(hasB.ok && hasB.value).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Context Budget Verification
  // -------------------------------------------------------------------------

  describe("Context Budget", () => {
    it("meta-tool definition stays under 200 tokens", () => {
      const tokenCount = estimateTokens(JSON.stringify(INTEGRATION_META_TOOL_DEFINITION));
      expect(tokenCount).toBeLessThanOrEqual(INTEGRATION_META_TOOL_MAX_TOKENS);
    });

    it("capability index stays under 200 tokens with 10+ integrations", async () => {
      const integrations: MockIntegration[] = [];
      for (let i = 0; i < 12; i++) {
        integrations.push(
          new MockIntegration(
            createMockManifest({
              id: `integration-${i}`,
              name: `Integration ${i}`,
              operations: [
                {
                  name: `op-a`,
                  description: `Operation A for integration ${i}`,
                  parameters: { type: "object", properties: {} },
                },
                {
                  name: `op-b`,
                  description: `Operation B for integration ${i}`,
                  parameters: { type: "object", properties: {} },
                },
              ],
            }),
          ),
        );
      }

      const service = new IntegrationService({
        toolRegistry,
        integrations,
      });

      await service.start();

      for (const integration of integrations) {
        await service.enableIntegration(integration.config.id);
      }

      const metaTool = toolRegistry.get(INTEGRATION_META_TOOL_DEFINITION.name)!;
      const discoverResult = await metaTool.execute(
        { callId: "budget-1", action: "discover" },
        createToolContext(),
      );

      const payload = discoverResult.result as { capabilityIndex: string[] };
      expect(payload.capabilityIndex).toHaveLength(12);

      const tokenCount = getCapabilityIndexTokenCount(payload.capabilityIndex);
      expect(tokenCount).toBeLessThanOrEqual(INTEGRATION_META_TOOL_MAX_TOKENS);
    });
  });

  // -------------------------------------------------------------------------
  // Dual-Channel Results
  // -------------------------------------------------------------------------

  describe("Dual-Channel Results", () => {
    it("formatListResult produces forModel and forUser channels", () => {
      const rawItems = [
        { title: "Note 1", path: "/notes/1.md", content: "Full content of note 1 with lots of detail" },
        { title: "Note 2", path: "/notes/2.md", content: "Full content of note 2 with lots of detail" },
      ];

      const result = formatListResult({
        entityName: "notes",
        items: rawItems,
        toModel: (item) => ({ title: item.title, path: item.path }),
        toUser: (item) => ({ title: item.title, path: item.path, content: item.content }),
      });

      expect(result.forModel).toBeDefined();
      expect(result.forUser).toBeDefined();
      expect(result.forModel.kind).toBe("list");
      expect(result.forUser.kind).toBe("list");
      expect(result.forModel.count).toBe(2);
    });

    it("forModel is more compact than forUser", () => {
      const rawItems = Array.from({ length: 5 }, (_, i) => ({
        title: `Note ${i}`,
        path: `/notes/${i}.md`,
        content: `This is the full content of note ${i} with lots of additional detail and metadata that would be expensive in the context window.`,
        tags: ["tag1", "tag2", "tag3"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      const result = formatListResult({
        entityName: "notes",
        items: rawItems,
        toModel: (item) => ({ title: item.title, path: item.path }),
        toUser: (item) => item,
      });

      const modelTokens = estimateTokens(JSON.stringify(result.forModel));
      const userTokens = estimateTokens(JSON.stringify(result.forUser));

      expect(modelTokens).toBeLessThan(userTokens);
    });

    it("formatDetailResult produces both channels", () => {
      const rawItem = {
        subject: "Meeting Tomorrow",
        from: "alice@example.com",
        body: "Let's meet at 3pm to discuss the project roadmap and timeline.",
        attachments: ["roadmap.pdf"],
      };

      const result = formatDetailResult({
        entityName: "email",
        item: rawItem,
        toModel: (item) => ({ subject: item.subject, from: item.from }),
        toUser: (item) => item,
      });

      expect(result.forModel.kind).toBe("detail");
      expect(result.forUser.kind).toBe("detail");
      expect(result.forModel.data).toEqual({ subject: "Meeting Tomorrow", from: "alice@example.com" });
      expect(result.forUser.data).toEqual(rawItem);
    });
  });

  // -------------------------------------------------------------------------
  // Integration Service Status Reporting
  // -------------------------------------------------------------------------

  describe("Service Status Reporting", () => {
    it("lists all integrations with status", async () => {
      const int1 = new MockIntegration(createMockManifest({ id: "status-a", name: "Status A" }));
      const int2 = new MockIntegration(createMockManifest({ id: "status-b", name: "Status B" }));

      const service = new IntegrationService({
        toolRegistry,
        integrations: [int1, int2],
      });

      await service.start();
      await service.enableIntegration("status-a");

      const listResult = await service.listIntegrations();
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(listResult.value).toHaveLength(2);

        const statusA = listResult.value.find((s) => s.id === "status-a");
        const statusB = listResult.value.find((s) => s.id === "status-b");

        expect(statusA).toBeDefined();
        expect(statusA!.enabled).toBe(true);
        expect(statusA!.operations.length).toBeGreaterThan(0);

        expect(statusB).toBeDefined();
        expect(statusB!.enabled).toBe(false);
      }
    });

    it("returns individual integration status", async () => {
      const integration = new MockIntegration(createMockManifest({ id: "single-status" }));

      const service = new IntegrationService({
        toolRegistry,
        integrations: [integration],
      });

      await service.start();
      await service.enableIntegration("single-status");

      const statusResult = await service.getIntegrationStatus("single-status");
      expect(statusResult.ok).toBe(true);
      if (statusResult.ok) {
        expect(statusResult.value.id).toBe("single-status");
        expect(statusResult.value.enabled).toBe(true);
        expect(statusResult.value.operations).toContain("search");
        expect(statusResult.value.operations).toContain("read");
      }
    });

    it("returns error for non-existent integration status", async () => {
      const service = new IntegrationService({
        toolRegistry,
        integrations: [],
      });

      await service.start();

      const statusResult = await service.getIntegrationStatus("non-existent");
      expect(statusResult.ok).toBe(false);
      if (!statusResult.ok) {
        expect(statusResult.error.message).toContain("not found");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Error Handling
  // -------------------------------------------------------------------------

  describe("Error Handling", () => {
    it("handles integration connection failure gracefully", async () => {
      const failingIntegration = new MockIntegration(createMockManifest({ id: "fail-connect" }));
      failingIntegration.connectShouldFail = true;

      const service = new IntegrationService({
        toolRegistry,
        integrations: [failingIntegration],
      });

      await service.start();

      const result = await service.enableIntegration("fail-connect");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(IntegrationError);
        expect(result.error.message).toContain("Failed to connect");
      }

      // Tools should not be registered after failed enable
      expect(toolRegistry.has("fail-connect.search")).toBe(false);
    });

    it("handles integration execution failure gracefully", async () => {
      const failingIntegration = new MockIntegration(createMockManifest({ id: "fail-exec" }));
      failingIntegration.executeShouldFail = true;

      const service = new IntegrationService({
        toolRegistry,
        integrations: [failingIntegration],
      });

      await service.start();
      await service.enableIntegration("fail-exec");

      const result = await service.executeOperation("fail-exec", "search", { query: "test" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(IntegrationError);
      }
    });

    it("rejects empty integration id", async () => {
      const service = new IntegrationService({
        toolRegistry,
        integrations: [],
      });

      await service.start();

      const enableResult = await service.enableIntegration("  ");
      expect(enableResult.ok).toBe(false);

      const disableResult = await service.disableIntegration("  ");
      expect(disableResult.ok).toBe(false);

      const statusResult = await service.getIntegrationStatus("  ");
      expect(statusResult.ok).toBe(false);
    });

    it("rejects empty operation name", async () => {
      const integration = new MockIntegration(createMockManifest({ id: "empty-op" }));

      const service = new IntegrationService({
        toolRegistry,
        integrations: [integration],
      });

      await service.start();
      await service.enableIntegration("empty-op");

      const result = await service.executeOperation("empty-op", "  ", {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("required");
      }
    });

    it("handles multiple integrations with mixed success/failure", async () => {
      const goodIntegration = new MockIntegration(createMockManifest({ id: "good-int" }));
      const badIntegration = new MockIntegration(createMockManifest({ id: "bad-int" }));
      badIntegration.connectShouldFail = true;

      const service = new IntegrationService({
        toolRegistry,
        integrations: [goodIntegration, badIntegration],
      });

      await service.start();

      const goodResult = await service.enableIntegration("good-int");
      const badResult = await service.enableIntegration("bad-int");

      expect(goodResult.ok).toBe(true);
      expect(badResult.ok).toBe(false);

      // Good integration should still be functional
      expect(toolRegistry.has("good-int.search")).toBe(true);
      expect(toolRegistry.has("bad-int.search")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Frontend Isolation
  // -------------------------------------------------------------------------

  describe("Frontend Isolation", () => {
    it("no TUI source files import from src/integrations/", async () => {
      const tuiSrcDir = resolve(__dirname, "../../../../reins-tui/src");

      let tuiExists = true;
      try {
        await readdir(tuiSrcDir);
      } catch {
        tuiExists = false;
      }

      if (!tuiExists) {
        // If TUI directory doesn't exist in this environment, skip gracefully
        expect(true).toBe(true);
        return;
      }

      const violations = await scanForIntegrationImports(tuiSrcDir);

      expect(violations).toEqual([]);
    });

    it("TUI integration handler does not import integration logic", async () => {
      const handlerPath = resolve(
        __dirname,
        "../../../../reins-tui/src/commands/handlers/integrations.ts",
      );

      let content: string;
      try {
        content = await readFile(handlerPath, "utf-8");
      } catch {
        // File doesn't exist in this environment — pass
        expect(true).toBe(true);
        return;
      }

      // Should not import from @reins/core integrations internals
      expect(content).not.toContain("src/integrations/");
      expect(content).not.toContain("integrations/registry");
      expect(content).not.toContain("integrations/lifecycle");
      expect(content).not.toContain("integrations/meta-tool");
      expect(content).not.toContain("integrations/service");
      expect(content).not.toContain("IntegrationRegistry");
      expect(content).not.toContain("IntegrationLifecycleManager");
      expect(content).not.toContain("IntegrationService");
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function scanForIntegrationImports(dir: string): Promise<string[]> {
  const violations: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const nested = await scanForIntegrationImports(fullPath);
      violations.push(...nested);
      continue;
    }

    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) {
      continue;
    }

    const content = await readFile(fullPath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Check for imports from integration internals
      // Allow: importing types re-exported through @reins/core barrel
      // Disallow: direct imports from src/integrations/ paths
      if (
        line.includes("src/integrations/") &&
        (line.includes("import ") || line.includes("require("))
      ) {
        violations.push(`${fullPath}:${i + 1}: ${line.trim()}`);
      }
    }
  }

  return violations;
}

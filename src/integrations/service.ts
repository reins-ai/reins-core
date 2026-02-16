import { err, ok, type Result } from "../result";
import type { ToolContext } from "../types";
import { ToolRegistry } from "../tools/registry";
import { KeyEncryption } from "../providers/byok/crypto";
import {
  EncryptedCredentialStore,
  resolveCredentialEncryptionSecret,
} from "../providers/credentials/store";
import {
  InMemoryCredentialVault,
  IntegrationCredentialVault,
  type CredentialStatus,
  type CredentialVault,
} from "./credentials";
import { IntegrationError } from "./errors";
import {
  INTEGRATION_META_TOOL_DEFINITION,
  IntegrationMetaTool,
} from "./meta-tool";
import { IntegrationLifecycleManager } from "./lifecycle";
import { IntegrationRegistry } from "./registry";
import {
  IntegrationState,
  type Integration,
  type IntegrationStatusIndicator,
} from "./types";

export interface IntegrationServiceOptions {
  toolRegistry: ToolRegistry;
  integrations?: readonly Integration[];
  credentialStore?: EncryptedCredentialStore;
  keyEncryption?: KeyEncryption;
  toolContextFactory?: () => ToolContext;
}

export interface IntegrationServiceSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  enabled: boolean;
  state: IntegrationState;
  indicator: IntegrationStatusIndicator;
  lastError?: string;
  updatedAt: string;
  credentialStatus: CredentialStatus;
  operations: string[];
}

export interface IntegrationServiceStatus {
  id: string;
  enabled: boolean;
  state: IntegrationState;
  indicator: IntegrationStatusIndicator;
  lastError?: string;
  updatedAt: string;
  credentialStatus: CredentialStatus;
  operations: string[];
}

interface IntegrationMetaExecutePayload {
  action: "execute";
  integrationId: string;
  operation: string;
  result: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeRequired(value: string, field: string): Result<string, IntegrationError> {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return err(new IntegrationError(`${field} is required`));
  }

  return ok(normalized);
}

function normalizeOperation(value: string): Result<string, IntegrationError> {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return err(new IntegrationError("Operation is required"));
  }

  return ok(normalized);
}

function toDefaultToolContext(): ToolContext {
  return {
    conversationId: "integration-service",
    userId: "daemon",
  };
}

function toIntegrationMetaExecutePayload(
  value: unknown,
): Result<IntegrationMetaExecutePayload, IntegrationError> {
  if (!isRecord(value)) {
    return err(new IntegrationError("Integration meta-tool returned malformed execute payload"));
  }

  if (
    value["action"] !== "execute"
    || typeof value["integrationId"] !== "string"
    || typeof value["operation"] !== "string"
  ) {
    return err(new IntegrationError("Integration meta-tool returned unexpected execute response"));
  }

  return ok({
    action: "execute",
    integrationId: value["integrationId"],
    operation: value["operation"],
    result: value["result"],
  });
}

function createCredentialVault(options: IntegrationServiceOptions): CredentialVault {
  if (!options.credentialStore) {
    return new InMemoryCredentialVault();
  }

  const encryption =
    options.keyEncryption
    ?? new KeyEncryption(resolveCredentialEncryptionSecret());

  return new IntegrationCredentialVault({
    store: options.credentialStore,
    encryption,
  });
}

/**
 * Daemon-facing integration orchestration service.
 *
 * Coordinates integration registry, lifecycle manager, credential vault,
 * and integration meta-tool to expose a single API surface for daemon
 * startup and runtime integration operations.
 */
export class IntegrationService {
  private static instance: IntegrationService | null = null;

  public static getInstance(options: IntegrationServiceOptions): IntegrationService {
    if (!IntegrationService.instance) {
      IntegrationService.instance = new IntegrationService(options);
    }

    return IntegrationService.instance;
  }

  public static resetInstanceForTests(): void {
    IntegrationService.instance = null;
  }

  private readonly toolRegistry: ToolRegistry;
  private readonly integrationRegistry: IntegrationRegistry;
  private readonly lifecycleManager: IntegrationLifecycleManager;
  private readonly credentialVault: CredentialVault;
  private readonly integrationMetaTool: IntegrationMetaTool;
  private readonly toolContextFactory: () => ToolContext;
  private started = false;

  constructor(options: IntegrationServiceOptions) {
    this.toolRegistry = options.toolRegistry;
    this.integrationRegistry = new IntegrationRegistry();
    this.credentialVault = createCredentialVault(options);
    this.lifecycleManager = new IntegrationLifecycleManager({
      integrationRegistry: this.integrationRegistry,
      toolRegistry: this.toolRegistry,
      credentialVault: this.credentialVault,
    });
    this.integrationMetaTool = new IntegrationMetaTool(this.integrationRegistry);
    this.toolContextFactory = options.toolContextFactory ?? toDefaultToolContext;

    for (const integration of options.integrations ?? []) {
      this.integrationRegistry.register(integration);
    }
  }

  public getRegistry(): IntegrationRegistry {
    return this.integrationRegistry;
  }

  public getLifecycleManager(): IntegrationLifecycleManager {
    return this.lifecycleManager;
  }

  public getCredentialVault(): CredentialVault {
    return this.credentialVault;
  }

  public getMetaTool(): IntegrationMetaTool {
    return this.integrationMetaTool;
  }

  public async start(): Promise<Result<void, IntegrationError>> {
    if (this.started) {
      return ok(undefined);
    }

    const metaToolName = INTEGRATION_META_TOOL_DEFINITION.name;
    if (this.toolRegistry.has(metaToolName)) {
      this.toolRegistry.remove(metaToolName);
    }

    this.toolRegistry.register(this.integrationMetaTool);

    // Integrations are opt-in only. Startup should register availability but
    // never activate connections or operation tools automatically.
    for (const integration of this.integrationRegistry.list()) {
      this.integrationRegistry.disable(integration.config.id);
    }

    this.started = true;
    return ok(undefined);
  }

  public async stop(): Promise<Result<void, IntegrationError>> {
    if (!this.started) {
      return ok(undefined);
    }

    for (const integration of this.integrationRegistry.list()) {
      const state = this.lifecycleManager.getState(integration.config.id);
      if (state !== IntegrationState.ACTIVE && state !== IntegrationState.SUSPENDED) {
        continue;
      }

      const disableResult = await this.lifecycleManager.disable(integration.config.id);
      if (!disableResult.ok) {
        return disableResult;
      }
    }

    this.toolRegistry.remove(INTEGRATION_META_TOOL_DEFINITION.name);
    this.started = false;
    return ok(undefined);
  }

  public async listIntegrations(): Promise<Result<IntegrationServiceSummary[], IntegrationError>> {
    const integrations = this.integrationRegistry.list();
    const summaries: IntegrationServiceSummary[] = [];

    for (const integration of integrations) {
      const statusResult = await this.getIntegrationStatus(integration.config.id);
      if (!statusResult.ok) {
        return statusResult;
      }

      summaries.push({
        name: integration.manifest.name,
        description: integration.manifest.description,
        category: integration.manifest.category,
        version: integration.manifest.version,
        ...statusResult.value,
      });
    }

    return ok(summaries);
  }

  public async getIntegrationStatus(
    integrationId: string,
  ): Promise<Result<IntegrationServiceStatus, IntegrationError>> {
    const normalizedIdResult = normalizeRequired(integrationId, "Integration id");
    if (!normalizedIdResult.ok) {
      return normalizedIdResult;
    }

    const integration = this.integrationRegistry.get(normalizedIdResult.value);
    if (!integration) {
      return err(new IntegrationError(`Integration not found: ${normalizedIdResult.value}`));
    }

    const credentialStatusResult = await this.credentialVault.getStatus(normalizedIdResult.value);
    if (!credentialStatusResult.ok) {
      return credentialStatusResult;
    }

    const runtimeStatus = integration.getStatus();
    const state = this.lifecycleManager.getState(normalizedIdResult.value) ?? runtimeStatus.state;

    return ok({
      id: integration.manifest.id,
      enabled: integration.config.enabled,
      state,
      indicator: runtimeStatus.indicator,
      lastError: runtimeStatus.lastError,
      updatedAt: runtimeStatus.updatedAt.toISOString(),
      credentialStatus: credentialStatusResult.value,
      operations: integration.getOperations().map((operation) => operation.name),
    });
  }

  public async enableIntegration(integrationId: string): Promise<Result<void, IntegrationError>> {
    const normalizedIdResult = normalizeRequired(integrationId, "Integration id");
    if (!normalizedIdResult.ok) {
      return normalizedIdResult;
    }

    return this.lifecycleManager.enable(normalizedIdResult.value);
  }

  public async disableIntegration(integrationId: string): Promise<Result<void, IntegrationError>> {
    const normalizedIdResult = normalizeRequired(integrationId, "Integration id");
    if (!normalizedIdResult.ok) {
      return normalizedIdResult;
    }

    return this.lifecycleManager.disable(normalizedIdResult.value);
  }

  public async executeOperation(
    integrationId: string,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<Result<unknown, IntegrationError>> {
    const normalizedIdResult = normalizeRequired(integrationId, "Integration id");
    if (!normalizedIdResult.ok) {
      return normalizedIdResult;
    }

    const operationResult = normalizeOperation(operation);
    if (!operationResult.ok) {
      return operationResult;
    }

    if (!this.started) {
      return err(new IntegrationError("Integration service is not started"));
    }

    const integration = this.integrationRegistry.get(normalizedIdResult.value);
    if (!integration) {
      return err(new IntegrationError(`Integration not found: ${normalizedIdResult.value}`));
    }

    if (!integration.config.enabled) {
      return err(new IntegrationError(`Integration ${normalizedIdResult.value} is disabled`));
    }

    const state = this.lifecycleManager.getState(normalizedIdResult.value);
    if (state !== IntegrationState.ACTIVE) {
      return err(
        new IntegrationError(
          `Integration ${normalizedIdResult.value} is not active`,
        ),
      );
    }

    const tool = this.toolRegistry.get(INTEGRATION_META_TOOL_DEFINITION.name);
    if (!tool) {
      return err(new IntegrationError("Integration meta-tool is not registered"));
    }

    const toolResult = await tool.execute(
      {
        callId: `integration-${normalizedIdResult.value}-${operationResult.value}`,
        action: "execute",
        integration_id: normalizedIdResult.value,
        operation: operationResult.value,
        args,
      },
      this.toolContextFactory(),
    );

    if (toolResult.error) {
      return err(
        new IntegrationError(
          `Integration operation failed: ${toolResult.error}`,
        ),
      );
    }

    const payloadResult = toIntegrationMetaExecutePayload(toolResult.result);
    if (!payloadResult.ok) {
      return payloadResult;
    }

    return ok(payloadResult.value.result);
  }
}

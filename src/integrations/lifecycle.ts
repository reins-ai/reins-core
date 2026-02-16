import { err, ok, type Result } from "../result";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../types";
import type { ToolRegistry } from "../tools/registry";
import type { CredentialVault } from "./credentials/types";
import { IntegrationError } from "./errors";
import { validateIntegrationManifest } from "./manifest";
import { IntegrationRegistry } from "./registry";
import { IntegrationStateMachine, type StateChangeListener } from "./state-machine";
import {
  IntegrationState,
  type Integration,
  type IntegrationOperation,
  type IntegrationOperationParameterSchema,
} from "./types";

export interface LifecycleManagerOptions {
  integrationRegistry: IntegrationRegistry;
  toolRegistry: ToolRegistry;
  credentialVault: CredentialVault;
}

type CleanupHandler = () => Promise<void> | void;

function normalizeIntegrationId(integrationId: string): Result<string, IntegrationError> {
  const normalized = integrationId.trim().toLowerCase();
  if (normalized.length === 0) {
    return err(new IntegrationError("Integration id is required"));
  }

  return ok(normalized);
}

function readCallId(args: Record<string, unknown>): string {
  const callId = args["callId"];
  if (typeof callId !== "string") {
    return "unknown-call";
  }

  const trimmed = callId.trim();
  return trimmed.length > 0 ? trimmed : "unknown-call";
}

export class IntegrationLifecycleManager {
  private readonly stateMachines = new Map<string, IntegrationStateMachine>();
  private readonly registeredToolNames = new Map<string, string[]>();
  private readonly cleanupHandlers = new Map<string, Set<CleanupHandler>>();
  private readonly operationQueues = new Map<string, Promise<unknown>>();

  private readonly integrationRegistry: IntegrationRegistry;
  private readonly toolRegistry: ToolRegistry;
  private readonly credentialVault: CredentialVault;

  constructor(options: LifecycleManagerOptions) {
    this.integrationRegistry = options.integrationRegistry;
    this.toolRegistry = options.toolRegistry;
    this.credentialVault = options.credentialVault;
  }

  public async enable(integrationId: string): Promise<Result<void, IntegrationError>> {
    return this.enqueueOperation(integrationId, async (normalizedId) => {
      const integrationResult = this.getIntegration(normalizedId);
      if (!integrationResult.ok) {
        return integrationResult;
      }

      const integration = integrationResult.value;
      const stateMachine = this.getOrCreateStateMachine(normalizedId);

      const manifestValidation = validateIntegrationManifest(integration.manifest);
      if (!manifestValidation.valid) {
        return err(
          new IntegrationError(
            `Integration ${normalizedId} has an invalid manifest: ${manifestValidation.errors.join("; ")}`,
          ),
        );
      }

      if (stateMachine.getState() === IntegrationState.ACTIVE) {
        return err(new IntegrationError(`Integration ${normalizedId} is already active`));
      }

      if (stateMachine.getState() === IntegrationState.SUSPENDED) {
        return err(new IntegrationError(`Integration ${normalizedId} is suspended. Use resume() instead.`));
      }

      if (stateMachine.getState() === IntegrationState.DISCONNECTED) {
        const toInstalled = stateMachine.transition(IntegrationState.INSTALLED);
        if (!toInstalled.ok) {
          return toInstalled;
        }
      }

      if (stateMachine.getState() === IntegrationState.INSTALLED) {
        const toConfigured = stateMachine.transition(IntegrationState.CONFIGURED);
        if (!toConfigured.ok) {
          return toConfigured;
        }
      }

      if (stateMachine.getState() === IntegrationState.CONFIGURED) {
        const connectResult = await integration.connect();
        if (!connectResult.ok) {
          return err(
            new IntegrationError(
              `Failed to connect integration ${normalizedId}: ${connectResult.error.message}`,
              connectResult.error,
            ),
          );
        }

        const toConnected = stateMachine.transition(IntegrationState.CONNECTED);
        if (!toConnected.ok) {
          await this.safeDisconnect(normalizedId, integration);
          return toConnected;
        }
      }

      if (stateMachine.getState() === IntegrationState.CONNECTED) {
        const registerToolsResult = this.registerTools(normalizedId, integration);
        if (!registerToolsResult.ok) {
          await this.safeDisconnect(normalizedId, integration);
          return registerToolsResult;
        }

        const toActive = stateMachine.transition(IntegrationState.ACTIVE);
        if (!toActive.ok) {
          this.unregisterTools(normalizedId);
          await this.safeDisconnect(normalizedId, integration);
          return toActive;
        }
      }

      this.integrationRegistry.enable(normalizedId);

      return ok(undefined);
    });
  }

  public async disable(integrationId: string): Promise<Result<void, IntegrationError>> {
    return this.enqueueOperation(integrationId, async (normalizedId) => {
      const integrationResult = this.getIntegration(normalizedId);
      if (!integrationResult.ok) {
        return integrationResult;
      }

      const integration = integrationResult.value;
      const stateMachine = this.getOrCreateStateMachine(normalizedId);
      const state = stateMachine.getState();

      if (state === IntegrationState.ACTIVE || state === IntegrationState.SUSPENDED) {
        this.unregisterTools(normalizedId);
      }

      const disconnectResult = await integration.disconnect();
      if (!disconnectResult.ok) {
        return err(
          new IntegrationError(
            `Failed to disconnect integration ${normalizedId}: ${disconnectResult.error.message}`,
            disconnectResult.error,
          ),
        );
      }

      const cleanupResult = await this.runCleanupHandlers(normalizedId);
      if (!cleanupResult.ok) {
        return cleanupResult;
      }

      if (stateMachine.getState() !== IntegrationState.DISCONNECTED) {
        const toDisconnected = stateMachine.transition(IntegrationState.DISCONNECTED);
        if (!toDisconnected.ok) {
          return toDisconnected;
        }
      }

      const revokeResult = await this.credentialVault.revoke(normalizedId);
      if (!revokeResult.ok) {
        return revokeResult;
      }

      this.integrationRegistry.disable(normalizedId);
      this.registeredToolNames.delete(normalizedId);
      return ok(undefined);
    });
  }

  public async suspend(integrationId: string): Promise<Result<void, IntegrationError>> {
    return this.enqueueOperation(integrationId, async (normalizedId) => {
      const integrationResult = this.getIntegration(normalizedId);
      if (!integrationResult.ok) {
        return integrationResult;
      }

      const integration = integrationResult.value;
      const stateMachine = this.getOrCreateStateMachine(normalizedId);

      if (stateMachine.getState() !== IntegrationState.ACTIVE) {
        return err(
          new IntegrationError(
            `Cannot suspend integration ${normalizedId} from state ${stateMachine.getState()}`,
          ),
        );
      }

      this.unregisterTools(normalizedId);

      const toSuspended = stateMachine.transition(IntegrationState.SUSPENDED);
      if (!toSuspended.ok) {
        const rollbackResult = this.registerTools(normalizedId, integration);
        if (!rollbackResult.ok) {
          return rollbackResult;
        }

        return toSuspended;
      }

      return ok(undefined);
    });
  }

  public async resume(integrationId: string): Promise<Result<void, IntegrationError>> {
    return this.enqueueOperation(integrationId, async (normalizedId) => {
      const integrationResult = this.getIntegration(normalizedId);
      if (!integrationResult.ok) {
        return integrationResult;
      }

      const integration = integrationResult.value;
      const stateMachine = this.getOrCreateStateMachine(normalizedId);

      if (stateMachine.getState() !== IntegrationState.SUSPENDED) {
        return err(
          new IntegrationError(
            `Cannot resume integration ${normalizedId} from state ${stateMachine.getState()}`,
          ),
        );
      }

      const registerToolsResult = this.registerTools(normalizedId, integration);
      if (!registerToolsResult.ok) {
        return registerToolsResult;
      }

      const toActive = stateMachine.transition(IntegrationState.ACTIVE);
      if (!toActive.ok) {
        this.unregisterTools(normalizedId);
        return toActive;
      }

      return ok(undefined);
    });
  }

  public getState(integrationId: string): IntegrationState | undefined {
    const normalizedResult = normalizeIntegrationId(integrationId);
    if (!normalizedResult.ok) {
      return undefined;
    }

    const stateMachine = this.stateMachines.get(normalizedResult.value);
    return stateMachine?.getState();
  }

  public addStateChangeListener(integrationId: string, listener: StateChangeListener): Result<void, IntegrationError> {
    const normalizedResult = normalizeIntegrationId(integrationId);
    if (!normalizedResult.ok) {
      return normalizedResult;
    }

    const stateMachine = this.getOrCreateStateMachine(normalizedResult.value);
    stateMachine.addListener(listener);
    return ok(undefined);
  }

  public removeStateChangeListener(integrationId: string, listener: StateChangeListener): Result<void, IntegrationError> {
    const normalizedResult = normalizeIntegrationId(integrationId);
    if (!normalizedResult.ok) {
      return normalizedResult;
    }

    const stateMachine = this.stateMachines.get(normalizedResult.value);
    if (!stateMachine) {
      return ok(undefined);
    }

    stateMachine.removeListener(listener);
    return ok(undefined);
  }

  public addCleanupHandler(integrationId: string, handler: CleanupHandler): Result<void, IntegrationError> {
    const normalizedResult = normalizeIntegrationId(integrationId);
    if (!normalizedResult.ok) {
      return normalizedResult;
    }

    const existing = this.cleanupHandlers.get(normalizedResult.value) ?? new Set<CleanupHandler>();
    existing.add(handler);
    this.cleanupHandlers.set(normalizedResult.value, existing);
    return ok(undefined);
  }

  public removeCleanupHandler(integrationId: string, handler: CleanupHandler): Result<void, IntegrationError> {
    const normalizedResult = normalizeIntegrationId(integrationId);
    if (!normalizedResult.ok) {
      return normalizedResult;
    }

    const existing = this.cleanupHandlers.get(normalizedResult.value);
    if (!existing) {
      return ok(undefined);
    }

    existing.delete(handler);
    if (existing.size === 0) {
      this.cleanupHandlers.delete(normalizedResult.value);
    }

    return ok(undefined);
  }

  private getOrCreateStateMachine(normalizedId: string): IntegrationStateMachine {
    const existing = this.stateMachines.get(normalizedId);
    if (existing) {
      return existing;
    }

    const created = new IntegrationStateMachine(normalizedId, IntegrationState.INSTALLED);
    this.stateMachines.set(normalizedId, created);
    return created;
  }

  private getIntegration(normalizedId: string): Result<Integration, IntegrationError> {
    const integration = this.integrationRegistry.get(normalizedId);
    if (!integration) {
      return err(new IntegrationError(`Integration ${normalizedId} not found in registry`));
    }

    return ok(integration);
  }

  private registerTools(normalizedId: string, integration: Integration): Result<void, IntegrationError> {
    const operations = integration.getOperations();
    const registeredInCall: string[] = [];

    try {
      for (const operation of operations) {
        const toolName = this.toToolName(normalizedId, operation.name);
        if (this.toolRegistry.has(toolName)) {
          this.toolRegistry.remove(toolName);
        }

        this.toolRegistry.register(this.createTool(normalizedId, operation, integration));
        registeredInCall.push(toolName);
      }
    } catch (error) {
      this.unregisterToolNames(registeredInCall);
      return err(
        new IntegrationError(
          `Failed to register tools for integration ${normalizedId}: ${this.formatError(error)}`,
          error instanceof Error ? error : undefined,
        ),
      );
    }

    this.registeredToolNames.set(normalizedId, registeredInCall);
    return ok(undefined);
  }

  private unregisterTools(normalizedId: string): void {
    const registered = this.registeredToolNames.get(normalizedId);
    if (registered && registered.length > 0) {
      this.unregisterToolNames(registered);
      this.registeredToolNames.delete(normalizedId);
      return;
    }

    const integration = this.integrationRegistry.get(normalizedId);
    if (!integration) {
      return;
    }

    const fallbackNames = integration
      .getOperations()
      .map((operation) => this.toToolName(normalizedId, operation.name));
    this.unregisterToolNames(fallbackNames);
  }

  private unregisterToolNames(toolNames: string[]): void {
    for (const toolName of toolNames) {
      this.toolRegistry.remove(toolName);
    }
  }

  private createTool(
    normalizedId: string,
    operation: IntegrationOperation,
    integration: Integration,
  ): Tool {
    const toolName = this.toToolName(normalizedId, operation.name);
    const definition: ToolDefinition = {
      name: toolName,
      description: operation.description,
      parameters: this.toToolParameters(operation.parameters),
    };

    return {
      definition,
      execute: async (args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> => {
        const callId = readCallId(args);
        const executionResult = await integration.execute(operation.name, args);

        if (!executionResult.ok) {
          return {
            callId,
            name: toolName,
            result: null,
            error: executionResult.error.message,
          };
        }

        return {
          callId,
          name: toolName,
          result: executionResult.value,
        };
      },
    };
  }

  private toToolName(integrationId: string, operationName: string): string {
    return `${integrationId}.${operationName}`;
  }

  private toToolParameters(
    schema: IntegrationOperationParameterSchema,
  ): ToolDefinition["parameters"] {
    if (schema.type === "object" && schema.properties) {
      return schema as unknown as ToolDefinition["parameters"];
    }

    return {
      type: "object",
      properties: {},
    };
  }

  private async runCleanupHandlers(normalizedId: string): Promise<Result<void, IntegrationError>> {
    const handlers = this.cleanupHandlers.get(normalizedId);
    if (!handlers || handlers.size === 0) {
      return ok(undefined);
    }

    for (const handler of handlers) {
      try {
        await handler();
      } catch (error) {
        return err(
          new IntegrationError(
            `Cleanup failed for integration ${normalizedId}: ${this.formatError(error)}`,
            error instanceof Error ? error : undefined,
          ),
        );
      }
    }

    this.cleanupHandlers.delete(normalizedId);
    return ok(undefined);
  }

  private async safeDisconnect(normalizedId: string, integration: Integration): Promise<void> {
    const disconnectResult = await integration.disconnect();
    if (!disconnectResult.ok) {
      return;
    }

    const stateMachine = this.stateMachines.get(normalizedId);
    if (!stateMachine) {
      return;
    }

    if (stateMachine.getState() !== IntegrationState.DISCONNECTED && stateMachine.canTransition(IntegrationState.DISCONNECTED)) {
      stateMachine.transition(IntegrationState.DISCONNECTED);
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Unknown error";
  }

  private async enqueueOperation<T>(
    integrationId: string,
    operation: (normalizedId: string) => Promise<Result<T, IntegrationError>>,
  ): Promise<Result<T, IntegrationError>> {
    const normalizedResult = normalizeIntegrationId(integrationId);
    if (!normalizedResult.ok) {
      return normalizedResult;
    }

    const normalizedId = normalizedResult.value;
    const previous = this.operationQueues.get(normalizedId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(() => operation(normalizedId));
    const tracked = queued.then(() => undefined, () => undefined);

    this.operationQueues.set(normalizedId, tracked);

    try {
      return await queued;
    } finally {
      if (this.operationQueues.get(normalizedId) === tracked) {
        this.operationQueues.delete(normalizedId);
      }
    }
  }
}

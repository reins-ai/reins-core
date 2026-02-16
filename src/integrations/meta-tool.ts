import { estimateTokens } from "../context/tokenizer";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../types";
import type { Integration, IntegrationOperation } from "./types";
import { IntegrationRegistry } from "./registry";

export const INTEGRATION_META_TOOL_ACTIONS = ["discover", "activate", "execute"] as const;

export type IntegrationMetaToolAction = (typeof INTEGRATION_META_TOOL_ACTIONS)[number];

export const INTEGRATION_META_TOOL_MAX_TOKENS = 200;

export const INTEGRATION_META_TOOL_DEFINITION: ToolDefinition = {
  name: "integration",
  description: "Discover, activate, and execute integrations.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action: discover, activate, or execute.",
        enum: [...INTEGRATION_META_TOOL_ACTIONS],
      },
      integration_id: {
        type: "string",
        description: "Integration id.",
      },
      operation: {
        type: "string",
        description: "Operation name.",
      },
      args: {
        type: "object",
        description: "Operation args.",
      },
    },
    required: ["action"],
  },
};

export function getIntegrationMetaToolTokenCount(): number {
  return estimateTokens(JSON.stringify(INTEGRATION_META_TOOL_DEFINITION));
}

export function getCapabilityIndexTokenCount(capabilityIndex: readonly string[]): number {
  return estimateTokens(JSON.stringify(capabilityIndex));
}

type IntegrationMetaToolDiscoverResult = {
  action: "discover";
  capabilityIndex: string[];
};

type IntegrationMetaToolActivateResult = {
  action: "activate";
  integrationId: string;
  operations: IntegrationOperation[];
};

type IntegrationMetaToolExecuteResult = {
  action: "execute";
  integrationId: string;
  operation: string;
  result: unknown;
};

type IntegrationMetaToolResult =
  | IntegrationMetaToolDiscoverResult
  | IntegrationMetaToolActivateResult
  | IntegrationMetaToolExecuteResult;

export class IntegrationMetaTool implements Tool {
  readonly definition: ToolDefinition = INTEGRATION_META_TOOL_DEFINITION;

  constructor(private readonly integrationRegistry: IntegrationRegistry) {}

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const callId = this.readString(args.callId) ?? "unknown-call";
    const action = this.normalizeAction(args.action);

    if (!action) {
      return this.errorResult(
        callId,
        "Missing or invalid 'action' argument. Expected: discover, activate, or execute.",
      );
    }

    try {
      switch (action) {
        case "discover":
          return this.successResult(callId, this.discover());
        case "activate":
          return this.successResult(callId, this.activate(args));
        case "execute":
          return await this.executeIntegration(callId, args);
      }
    } catch (error) {
      return this.errorResult(callId, this.formatError(error));
    }
  }

  private discover(): IntegrationMetaToolDiscoverResult {
    const capabilityIndex = this.integrationRegistry
      .listActive()
      .map((integration) => this.toCapabilityIndexEntry(integration));

    return {
      action: "discover",
      capabilityIndex,
    };
  }

  private activate(args: Record<string, unknown>): IntegrationMetaToolActivateResult {
    const integrationId = this.requireString(
      args.integration_id,
      "'integration_id' is required for activate action.",
    );

    const integration = this.integrationRegistry.getOrThrow(integrationId);

    return {
      action: "activate",
      integrationId: integration.manifest.id,
      operations: integration.getOperations(),
    };
  }

  private async executeIntegration(
    callId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const integrationId = this.requireString(
      args.integration_id,
      "'integration_id' is required for execute action.",
    );
    const operation = this.requireString(
      args.operation,
      "'operation' is required for execute action.",
    );
    const integrationArgs = this.readObject(args.args, "'args' must be an object when provided.") ?? {};

    const integration = this.integrationRegistry.getOrThrow(integrationId);
    const executionResult = await integration.execute(operation, integrationArgs);

    if (!executionResult.ok) {
      return this.errorResult(callId, this.formatError(executionResult.error));
    }

    const result: IntegrationMetaToolExecuteResult = {
      action: "execute",
      integrationId: integration.manifest.id,
      operation,
      result: executionResult.value,
    };

    return this.successResult(callId, result);
  }

  private toCapabilityIndexEntry(integration: Integration): string {
    const operations = integration.getOperations().map((operation) => operation.name).join(",");
    return `${integration.manifest.id}:${operations}`;
  }

  private normalizeAction(value: unknown): IntegrationMetaToolAction | null {
    const action = this.readString(value);
    if (!action) {
      return null;
    }

    if (action === "discover" || action === "activate" || action === "execute") {
      return action;
    }

    return null;
  }

  private successResult(callId: string, result: IntegrationMetaToolResult): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result,
    };
  }

  private errorResult(callId: string, error: string): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result: null,
      error,
    };
  }

  private readString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private requireString(value: unknown, message: string): string {
    const read = this.readString(value);
    if (!read) {
      throw new Error(message);
    }

    return read;
  }

  private readObject(value: unknown, message: string): Record<string, unknown> | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(message);
    }

    return value as Record<string, unknown>;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Integration meta-tool execution failed.";
  }
}

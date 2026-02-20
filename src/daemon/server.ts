/**
 * Daemon HTTP server exposing provider auth and conversation endpoints.
 * Listens on localhost:7433
 */

import { dirname, join, parse } from "node:path";

import { ConversationManager, type ConversationManagerCompactionOptions } from "../conversation/manager";
import { CompactionService } from "../conversation/compaction";
import { CompactionManager, MemoryPreservationHook } from "../conversation/compaction/index";
import { SessionRepository } from "../conversation/session-repository";
import { SQLiteConversationStore } from "../conversation/sqlite-store";
import { TranscriptStore } from "../conversation/transcript-store";
import { ConfigStore } from "../config/store";
import { ProviderAuthService } from "../providers/auth-service";
import {
  BYOKAnthropicProvider,
  BYOKGoogleProvider,
  BYOKOpenAIProvider,
} from "../providers/byok";
import { AnthropicApiKeyStrategy } from "../providers/byok/anthropic-auth-strategy";
import { EncryptedCredentialStore, resolveCredentialEncryptionSecret } from "../providers/credentials/store";
import type { CredentialRecord } from "../providers/credentials/types";
import { AnthropicOAuthProvider } from "../providers/oauth/anthropic";
import { OAuthProviderRegistry } from "../providers/oauth/provider";
import { CredentialBackedOAuthTokenStore } from "../providers/oauth/token-store";
import { ProviderRegistry } from "../providers/registry";
import { ModelRouter, type AuthenticatedRouteResult } from "../providers/router";
import { AuthError, ConversationError, ProviderError } from "../errors";
import {
  EnvironmentNotFoundError,
  EnvironmentSwitchService,
  FileEnvironmentResolver,
  InvalidEnvironmentNameError,
  bootstrapInstallRoot,
  buildInstallPaths,
  resolveInstallRoot,
} from "../environment";
import { err, ok, type Result } from "../result";
import type { MemoryService, ExplicitMemoryInput, MemoryListOptions, UpdateMemoryInput } from "../memory/services/memory-service";
import type { MemoryRecord } from "../memory/types/memory-record";
import { LocalFileMemoryStore } from "../memory/local-store";
import { SessionExtractor } from "../memory/capture";
import { EnvironmentContextProvider } from "../persona/environment-context";
import { SystemPromptBuilder } from "../persona/builder";
import { PersonaRegistry } from "../persona/registry";
import { ChannelCredentialStorage, ChannelRegistry, ConversationBridge } from "../channels";
import { ConvexDaemonClient, createConvexDaemonClientFromEnv } from "../convex";
import { IntegrationService, INTEGRATION_META_TOOL_DEFINITION } from "../integrations";
import { generateDeviceCode, pollDeviceCode } from "./device-code-auth";
import { ObsidianIntegration, loadObsidianManifest } from "../integrations/adapters/obsidian";
import {
  SKILL_TOOL_DEFINITION,
  ScriptRunner,
  SkillTool,
  type SkillDaemonService,
} from "../skills";
import type { BrowserDaemonService } from "../browser/browser-daemon-service";
import { BrowserTool } from "../browser/tools/browser-tool";
import { BrowserSnapshotTool } from "../browser/tools/browser-snapshot-tool";
import { BrowserActTool } from "../browser/tools/browser-act-tool";
import { BrowserDebugTool } from "../browser/tools/browser-debug-tool";
import { DebugEventBuffer } from "../browser/debug-event-buffer";
import { ElementRefRegistry } from "../browser/element-ref-registry";
import { SnapshotEngine } from "../browser/snapshot";
import { BROWSER_SYSTEM_PROMPT } from "../browser/system-prompt";
import type { CronScheduler } from "../cron/scheduler";
import type { CronJobDefinition } from "../cron/types";

import {
  parseListMemoryQueryParams,
  validateCreateMemoryRequest,
  validateSearchMemoryRequest,
  validateUpdateMemoryRequest,
  type MemoryRecordDto,
} from "./types/memory-routes";
import type { DaemonPathOptions } from "./paths";
import {
  toOverlayResolutionDto,
  type EnvironmentErrorResponse,
  type EnvironmentListResponse,
  type EnvironmentStatusResponse,
  type EnvironmentSummaryDto,
  type EnvironmentSwitchRequest,
  type EnvironmentSwitchResponse,
} from "./environment-api";
import { getTextContent, serializeContent, type Conversation, type Message } from "../types";
import { AgentLoop } from "../harness/agent-loop";
import type { SubAgentPool } from "../harness/sub-agent-pool";
import { ToolExecutor, ToolRegistry } from "../tools";
import { EDIT_DEFINITION, GLOB_DEFINITION, GREP_DEFINITION, READ_DEFINITION, WRITE_DEFINITION } from "../tools/builtins";
import { MemoryTool } from "../tools/memory-tool";
import { DelegateTool } from "../tools/delegate-tool";
import { BashTool } from "../tools/system/bash";
import { executeEdit } from "../tools/system/edit";
import { GlobTool } from "../tools/system/glob";
import { GrepTool } from "../tools/system/grep";
import { LsTool } from "../tools/system/ls";
import { ReadTool } from "../tools/system/read";
import type { SystemToolArgs } from "../tools/system/types";
import { executeWrite } from "../tools/system/write";
import { createWebSearchToolFromCredentials } from "../tools/web-search/runtime";
import type {
  DaemonConversationServiceError,
  DaemonConversationRecordDto,
  DaemonConversationSummaryDto,
  DaemonCreateConversationRequestDto,
  DaemonMessageRecordDto,
  DaemonMessageRole,
  DaemonPostMessageRequestDto,
  DaemonPostMessageResponseDto,
  DaemonStreamSubscribeRequestDto,
} from "../types/conversation";
import type { DaemonError, DaemonManagedService } from "./types";
import { WsStreamRegistry, type StreamRegistrySocketData } from "./ws-stream-registry";
import type { ContentBlock, Provider, TokenUsage, Tool, ToolContext, ToolDefinition, ToolResult } from "../types";
import {
  MemoryCapabilitiesResolver,
  resolveMemoryCapabilities,
  resolveMemoryConfigPath,
} from "./memory-capabilities";
import type { MemoryCapabilities } from "./types/memory-config";
import type { MemoryConfig } from "./types/memory-config";
import { createAuthMiddleware } from "./auth-middleware";
import { MachineAuthService } from "../security/machine-auth";
import { ChannelDaemonService } from "./channel-service";
import { createChannelRouteHandler, type ChannelRouteHandler } from "./channel-routes";

interface ActiveExecution {
  conversationId: string;
  assistantMessageId: string;
  controller: AbortController;
}

/**
 * Stream lifecycle event emitted over WebSocket during provider generation.
 * Events follow a deterministic order per assistant message:
 *   message_start → (thinking_chunk | content_chunk)* → message_complete | error
 *
 * Each event carries a monotonic sequence number for ordering guarantees.
 */
export type StreamLifecycleEvent =
  | {
      type: "message_start";
      conversationId: string;
      messageId: string;
      sequence: number;
      timestamp: string;
    }
  | {
      type: "content_chunk";
      conversationId: string;
      messageId: string;
      delta: string;
      sequence: number;
      timestamp: string;
    }
  | {
      type: "thinking_chunk";
      conversationId: string;
      messageId: string;
      delta: string;
      sequence: number;
      timestamp: string;
    }
  | {
      type: "tool_call_start";
      conversationId: string;
      messageId: string;
      tool_use_id: string;
      name: string;
      input: Record<string, unknown>;
      toolCall: {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      };
      sequence: number;
      timestamp: string;
    }
  | {
      type: "tool_call_end";
      conversationId: string;
      messageId: string;
      tool_use_id: string;
      name: string;
      result_summary: string;
      is_error: boolean;
      result: {
        callId: string;
        name: string;
        result: unknown;
        error?: string;
      };
      sequence: number;
      timestamp: string;
    }
  | {
      type: "message_complete";
      conversationId: string;
      messageId: string;
      content: string;
      sequence: number;
      timestamp: string;
      finishReason?: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    }
  | {
      type: "error";
      conversationId: string;
      messageId: string;
      sequence: number;
      timestamp: string;
      error: {
        code: string;
        message: string;
        retryable: boolean;
      };
    };

/**
 * Callback invoked for each stream lifecycle event.
 * Subscribers receive events wrapped in a `stream-event` envelope.
 */
export type StreamSubscriber = (event: StreamLifecycleEvent) => void;

/**
 * Registry tracking active stream subscriptions per assistant message.
 * Supports multiple concurrent subscribers per stream and multiple
 * concurrent streams (one per assistant message).
 */
export class StreamRegistry {
  private readonly streams = new Map<string, Set<StreamSubscriber>>();

  private streamKey(conversationId: string, messageId: string): string {
    return `${conversationId}:${messageId}`;
  }

  subscribe(conversationId: string, messageId: string, subscriber: StreamSubscriber): void {
    const key = this.streamKey(conversationId, messageId);
    let subscribers = this.streams.get(key);
    if (!subscribers) {
      subscribers = new Set();
      this.streams.set(key, subscribers);
    }
    subscribers.add(subscriber);
  }

  unsubscribe(conversationId: string, messageId: string, subscriber: StreamSubscriber): void {
    const key = this.streamKey(conversationId, messageId);
    const subscribers = this.streams.get(key);
    if (subscribers) {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        this.streams.delete(key);
      }
    }
  }

  emit(event: StreamLifecycleEvent): void {
    const key = this.streamKey(event.conversationId, event.messageId);
    const subscribers = this.streams.get(key);
    if (!subscribers) {
      return;
    }

    for (const subscriber of subscribers) {
      try {
        subscriber(event);
      } catch {
        // Subscriber errors must not break the stream pipeline
      }
    }

    // Clean up subscriptions on terminal events
    if (event.type === "message_complete" || event.type === "error") {
      this.streams.delete(key);
    }
  }

  hasSubscribers(conversationId: string, messageId: string): boolean {
    const key = this.streamKey(conversationId, messageId);
    const subscribers = this.streams.get(key);
    return subscribers !== undefined && subscribers.size > 0;
  }

  clear(): void {
    this.streams.clear();
  }

  get activeStreamCount(): number {
    return this.streams.size;
  }
}

const DEFAULT_PORT = 7433;
const DEFAULT_HOST = "localhost";

// Anthropic OAuth configuration (matches claude.ai OAuth flow)
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_OAUTH_CONFIG = {
  clientId: ANTHROPIC_CLIENT_ID,
  authorizationUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  scopes: ["org:create_api_key", "user:profile", "user:inference"],
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
};

interface DefaultServices {
  authService: ProviderAuthService;
  modelRouter: ModelRouter;
  credentialStore: EncryptedCredentialStore;
  providerRegistry: ProviderRegistry;
}

interface StoredApiKeyPayload {
  key: string;
}

interface StoredDeviceSessionPayload {
  sessionToken: string;
  userId?: string;
  issuedAt: string;
  source: "device_code";
}

const SUPPORTED_BYOK_PROVIDER_IDS = ["anthropic", "openai", "google"] as const;

function isStoredApiKeyPayload(value: unknown): value is StoredApiKeyPayload {
  return typeof value === "object" && value !== null && typeof (value as { key?: unknown }).key === "string";
}

function createByokProvider(providerId: string, apiKey: string): Provider | null {
  switch (providerId) {
    case "anthropic":
      return withProviderIdentity(new BYOKAnthropicProvider(apiKey), {
        id: "anthropic",
        name: "Anthropic BYOK",
      });
    case "openai":
      return withProviderIdentity(new BYOKOpenAIProvider(apiKey), {
        id: "openai",
        name: "OpenAI BYOK",
      });
    case "google":
      return withProviderIdentity(new BYOKGoogleProvider(apiKey), {
        id: "google",
        name: "Google BYOK",
      });
    default:
      return null;
  }
}

function withProviderIdentity(provider: Provider, identity: { id: string; name: string }): Provider {
  return {
    config: {
      ...provider.config,
      id: identity.id,
      name: identity.name,
      type: "byok",
    },
    capabilities: provider.capabilities,
    chat: async (request) => await provider.chat(request),
    stream: (request) => provider.stream(request),
    listModels: async () => {
      const models = await provider.listModels();
      return models.map((model) => ({
        ...model,
        provider: identity.id,
      }));
    },
    validateConnection: async () => await provider.validateConnection(),
  };
}

interface ConversationServiceOptions {
  conversationManager?: ConversationManager;
  sqliteStorePath?: string;
  compactionConfig?: {
    tokenThreshold?: number;
    keepRecentMessages?: number;
    contextWindowTokens?: number;
    summaryMaxTokens?: number;
  };
}

interface MemoryCapabilitiesSaveRequest {
  embedding: {
    provider: string;
    model: string;
  };
}

export interface DaemonHttpServerOptions {
  port?: number;
  host?: string;
  /**
   * Backward-compatible provider auth override.
   * New code should prefer providerAuthService.
   */
  authService?: ProviderAuthService | MachineAuthService;
  providerAuthService?: ProviderAuthService;
  machineAuthService?: MachineAuthService;
  modelRouter?: ModelRouter;
  conversation?: ConversationServiceOptions;
  environment?: {
    daemonPathOptions?: DaemonPathOptions;
  };
  toolDefinitions?: ToolDefinition[];
  toolExecutor?: ToolExecutor;
  memoryService?: MemoryService;
  memoryCapabilitiesResolver?: MemoryCapabilitiesResolver;
  channelService?: ChannelDaemonService;
  skillService?: SkillDaemonService;
  browserService?: BrowserDaemonService;
  cronScheduler?: CronScheduler;
  convexAuthToken?: string;
}

interface ProviderExecutionContext {
  conversationId: string;
  assistantMessageId: string;
  requestedProvider?: string;
  requestedModel?: string;
  thinkingLevel?: "none" | "low" | "medium" | "high";
}

function isProviderAuthService(value: unknown): value is ProviderAuthService {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ProviderAuthService>;
  return (
    typeof candidate.listProviders === "function" &&
    typeof candidate.getProviderAuthStatus === "function" &&
    typeof candidate.handleCommand === "function"
  );
}

function isMachineAuthService(value: unknown): value is MachineAuthService {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<MachineAuthService>;
  return (
    typeof candidate.bootstrap === "function" &&
    typeof candidate.validate === "function" &&
    typeof candidate.getToken === "function"
  );
}

interface ProviderExecutionFailure extends DaemonConversationServiceError {
  diagnostic: string;
}

interface DaemonWebSocketData extends StreamRegistrySocketData {
  connectionId: string;
  lastSeenAt: number;
}

interface DaemonStreamUnsubscribeRequestDto {
  type: "stream.unsubscribe";
  conversationId: string;
  assistantMessageId: string;
}

interface DaemonHeartbeatPingEnvelope {
  type: "heartbeat.ping";
  timestamp: string;
}

interface DaemonHeartbeatPongEnvelope {
  type: "heartbeat.pong";
  timestamp: string;
}

interface DaemonStreamControlAckEnvelope {
  type: "stream.subscribed" | "stream.unsubscribed";
  conversationId: string;
  assistantMessageId: string;
  timestamp: string;
}

interface DaemonWebSocketErrorEnvelope {
  type: "stream.error";
  error: {
    code: "INVALID_REQUEST";
    message: string;
  };
  timestamp: string;
}

type DaemonWebSocketInboundMessage =
  | DaemonStreamSubscribeRequestDto
  | DaemonStreamUnsubscribeRequestDto
  | { type: "heartbeat.ping" }
  | { type: "heartbeat.pong" };

type DaemonStreamLifecycleEnvelope = {
  type: "stream-event";
  event:
    | {
        type: "message_start";
        conversationId: string;
        messageId: string;
        sequence: number;
        timestamp: string;
      }
    | {
        type: "content_chunk";
        conversationId: string;
        messageId: string;
        chunk: string;
        sequence: number;
        timestamp: string;
      }
    | {
        type: "thinking_chunk";
        conversationId: string;
        messageId: string;
        chunk: string;
        sequence: number;
        timestamp: string;
      }
    | {
        type: "tool_call_start";
        conversationId: string;
        messageId: string;
        tool_use_id: string;
        name: string;
        input: Record<string, unknown>;
        toolCall: {
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        };
        sequence: number;
        timestamp: string;
      }
    | {
        type: "tool_call_end";
        conversationId: string;
        messageId: string;
        tool_use_id: string;
        name: string;
        result_summary: string;
        is_error: boolean;
        result: {
          callId: string;
          name: string;
          result: unknown;
          error?: string;
        };
        sequence: number;
        timestamp: string;
      }
    | {
        type: "message_complete";
        conversationId: string;
        messageId: string;
        content: string;
        sequence: number;
        finishReason?: string;
        usage?: {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
        };
        timestamp: string;
      }
    | {
        type: "error";
        conversationId: string;
        messageId: string;
        sequence: number;
        error: {
          code: string;
          message: string;
          retryable: boolean;
        };
        timestamp: string;
      };
};

interface HealthResponse {
  status: "ok";
  timestamp: string;
  version: string;
  contractVersion: string;
  integrations: {
    initialized: boolean;
    registeredCount: number;
    activeCount: number;
    metaToolRegistered: boolean;
    startupError?: string;
  };
  discovery: {
    capabilities: string[];
    routes: {
      message: {
        canonical: string;
        compatibility: string;
      };
      conversations: {
        canonical: string;
        compatibility: string;
      };
      websocket: string;
    };
  };
}

const CONTRACT_VERSION = "2026-02-w1";
const MESSAGE_ROUTE = {
  canonical: "/api/messages",
  compatibility: "/messages",
} as const;

const CONVERSATIONS_ROUTE = {
  canonical: "/api/conversations",
  compatibility: "/conversations",
} as const;

const ENVIRONMENTS_ROUTE = {
  list: "/api/environments",
  switch: "/api/environments/switch",
  status: "/api/environments/status",
} as const;

const WEBSOCKET_ROUTE = "/ws";
const WS_HEARTBEAT_INTERVAL_MS = 15_000;
const WS_HEARTBEAT_TIMEOUT_MS = 45_000;
const STREAM_SUBSCRIPTION_GRACE_MS = 500;
const STREAM_SUBSCRIPTION_POLL_MS = 10;

const RUN_SKILL_SCRIPT_TOOL_DEFINITION: ToolDefinition = {
  name: "run_skill_script",
  description:
    "Execute a script from a trusted or verified skill and return stdout/stderr output. " +
    "IMPORTANT: You must call load_skill first to retrieve the skill's scripts[] array. " +
    "Only use script names that appear in the scripts[] array returned by load_skill. " +
    "Do not guess or infer script names from the skill name or description.",
  parameters: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "Skill name that owns the script.",
      },
      script: {
        type: "string",
        description:
          "Exact script file name from the scripts[] array returned by load_skill. " +
          "Never infer or guess script names.",
      },
      timeout: {
        type: "number",
        description: "Optional timeout in milliseconds for script execution.",
      },
      env: {
        type: "object",
        description: "Optional environment variables passed to the script.",
      },
    },
    required: ["skill", "script"],
  },
};

export const DAEMON_CONTRACT_COMPATIBILITY_NOTES = [
  "HTTP compatibility aliases remain active while TUI transport migrates from /messages and /conversations to /api-prefixed paths.",
  "POST /api/messages canonical acknowledgement includes messageId and timestamp; userMessageId remains accepted as compatibility alias.",
  "stream.subscribe payload shape remains { type, conversationId, assistantMessageId } for both daemon and TUI transports.",
] as const;

export function normalizePostMessageResponse(
  response: DaemonPostMessageResponseDto,
): DaemonPostMessageResponseDto {
  return {
    ...response,
    userMessageId: response.userMessageId ?? response.messageId,
  };
}

export function isStreamSubscribePayload(payload: unknown): payload is DaemonStreamSubscribeRequestDto {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const request = payload as Partial<DaemonStreamSubscribeRequestDto>;
  return (
    request.type === "stream.subscribe" &&
    typeof request.conversationId === "string" &&
    typeof request.assistantMessageId === "string"
  );
}

function isStreamUnsubscribePayload(payload: unknown): payload is DaemonStreamUnsubscribeRequestDto {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const request = payload as Partial<DaemonStreamUnsubscribeRequestDto>;
  return (
    request.type === "stream.unsubscribe" &&
    typeof request.conversationId === "string" &&
    typeof request.assistantMessageId === "string"
  );
}

function parseInboundWebSocketMessage(payload: unknown): DaemonWebSocketInboundMessage | null {
  if (isStreamSubscribePayload(payload) || isStreamUnsubscribePayload(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const message = payload as { type?: unknown };
  if (message.type === "heartbeat.ping" || message.type === "heartbeat.pong") {
    return { type: message.type };
  }

  return null;
}

function summarizeToolResult(result: ToolResult): string {
  const value = typeof result.error === "string" && result.error.length > 0 ? result.error : result.result;
  const serialized = typeof value === "string" ? value : safeSerialize(value);

  if (serialized.length <= 300) {
    return serialized;
  }

  return `${serialized.slice(0, 297)}...`;
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isPostMessagePayload(payload: unknown): payload is DaemonPostMessageRequestDto {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const request = payload as Partial<DaemonPostMessageRequestDto>;
  if (typeof request.content !== "string" || request.content.trim().length === 0) {
    return false;
  }

  if (typeof request.conversationId !== "undefined" && typeof request.conversationId !== "string") {
    return false;
  }

  if (typeof request.role !== "undefined") {
    const allowedRoles = new Set(["system", "user", "assistant"]);
    if (!allowedRoles.has(request.role)) {
      return false;
    }
  }

  if (
    typeof request.thinkingLevel !== "undefined"
    && request.thinkingLevel !== "none"
    && request.thinkingLevel !== "low"
    && request.thinkingLevel !== "medium"
    && request.thinkingLevel !== "high"
  ) {
    return false;
  }

  return true;
}

function log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
  const entry = {
    scope: "daemon-http",
    level,
    message,
    timestamp: new Date().toISOString(),
    ...data,
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

/**
 * Build a fully wired ProviderAuthService with Anthropic BYOK and OAuth registered,
 * plus a ModelRouter for listing available models.
 */
function createDefaultServices(): DefaultServices {
  const encryptionSecret = resolveCredentialEncryptionSecret();
  const store = new EncryptedCredentialStore({
    encryptionSecret,
  });
  const registry = new ProviderRegistry();

  // Register Anthropic OAuth provider
  const oauthRegistry = new OAuthProviderRegistry();
  const tokenStore = new CredentialBackedOAuthTokenStore(store);
  const anthropicOAuth = new AnthropicOAuthProvider({
    oauthConfig: ANTHROPIC_OAUTH_CONFIG,
    tokenStore,
    providerConfig: {
      id: "anthropic",
      name: "Anthropic",
    },
  });
  oauthRegistry.register(anthropicOAuth);

  // Register Anthropic OAuth provider in the ProviderRegistry for model listing
  registry.register(anthropicOAuth);

  // Register Anthropic BYOK strategy
  const anthropicByok = new AnthropicApiKeyStrategy({ store });

  const authService = new ProviderAuthService({
    store,
    registry,
    oauthProviderRegistry: oauthRegistry,
    apiKeyStrategies: { anthropic: anthropicByok },
  });

  const modelRouter = new ModelRouter(registry, authService);

  return {
    authService,
    modelRouter,
    credentialStore: store,
    providerRegistry: registry,
  };
}

function createDefaultToolExecutor(
  memoryService?: MemoryService | null,
  credentialStore?: EncryptedCredentialStore,
): ToolExecutor {
  const sandboxRoot = resolveInstallRoot();
  const toolRegistry = new ToolRegistry();

  toolRegistry.register(new BashTool(sandboxRoot));
  toolRegistry.register(new LsTool(sandboxRoot));

  const readTool = new ReadTool(sandboxRoot);
  toolRegistry.register(createSystemToolAdapter({
    name: READ_DEFINITION.name,
    description: READ_DEFINITION.description,
    parameters: READ_DEFINITION.input_schema,
    execute: async (args, context) => {
      const result = await readTool.execute(args, {
        conversationId: "daemon",
        userId: "daemon",
        abortSignal: context.abortSignal,
      });
      return result.result;
    },
  }));

  const globTool = new GlobTool(sandboxRoot);
  toolRegistry.register(createSystemToolAdapter({
    name: GLOB_DEFINITION.name,
    description: GLOB_DEFINITION.description,
    parameters: GLOB_DEFINITION.input_schema,
    execute: async (args) => await globTool.execute(args),
  }));

  const grepTool = new GrepTool(sandboxRoot);
  toolRegistry.register(createSystemToolAdapter({
    name: GREP_DEFINITION.name,
    description: GREP_DEFINITION.description,
    parameters: GREP_DEFINITION.input_schema,
    execute: async (args) => await grepTool.execute(args),
  }));

  toolRegistry.register(createSystemToolAdapter({
    name: WRITE_DEFINITION.name,
    description: WRITE_DEFINITION.description,
    parameters: WRITE_DEFINITION.input_schema,
    execute: async (args) => await executeWrite(args, sandboxRoot),
  }));

  toolRegistry.register(createSystemToolAdapter({
    name: EDIT_DEFINITION.name,
    description: EDIT_DEFINITION.description,
    parameters: EDIT_DEFINITION.input_schema,
    execute: async (args) => await executeEdit(args, sandboxRoot),
  }));

  if (memoryService) {
    toolRegistry.register(new MemoryTool(memoryService));
  }

  if (credentialStore) {
    toolRegistry.register(createWebSearchToolFromCredentials({ credentialStore }));
  }

  if (!toolRegistry.has("delegate")) {
    toolRegistry.register(new DelegateTool());
  }

  return new ToolExecutor(toolRegistry);
}

function createSystemToolAdapter(options: {
  name: string;
  description: string;
  parameters: ToolDefinition["parameters"];
  execute: (args: SystemToolArgs, context: ToolContext) => Promise<unknown>;
}): Tool {
  return {
    definition: {
      name: options.name,
      description: options.description,
      parameters: options.parameters,
    },
    async execute(args, context): Promise<ToolResult> {
      return {
        callId: "system-tool",
        name: options.name,
        result: await options.execute(args as SystemToolArgs, context),
      };
    },
  };
}

function createSkillScriptTool(scriptRunner: ScriptRunner): Tool {
  return {
    definition: RUN_SKILL_SCRIPT_TOOL_DEFINITION,
    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const skill = readRequiredString(args["skill"]);
      const script = readRequiredString(args["script"]);
      if (!skill || !script) {
        return {
          callId: "run-skill-script",
          name: RUN_SKILL_SCRIPT_TOOL_DEFINITION.name,
          result: null,
          error: "Missing required arguments: skill and script.",
        };
      }

      const timeout = readPositiveNumber(args["timeout"]);
      if (typeof args["timeout"] !== "undefined" && typeof timeout === "undefined") {
        return {
          callId: "run-skill-script",
          name: RUN_SKILL_SCRIPT_TOOL_DEFINITION.name,
          result: null,
          error: "Invalid timeout argument. Expected a positive number.",
        };
      }

      const env = readStringRecord(args["env"]);
      if (typeof args["env"] !== "undefined" && typeof env === "undefined") {
        return {
          callId: "run-skill-script",
          name: RUN_SKILL_SCRIPT_TOOL_DEFINITION.name,
          result: null,
          error: "Invalid env argument. Expected an object with string values.",
        };
      }

      const result = await scriptRunner.execute(skill, script, {
        timeout,
        env,
        signal: context.abortSignal,
      });

      if (!result.ok) {
        return {
          callId: "run-skill-script",
          name: RUN_SKILL_SCRIPT_TOOL_DEFINITION.name,
          result: null,
          error: result.error.message,
        };
      }

      return {
        callId: "run-skill-script",
        name: RUN_SKILL_SCRIPT_TOOL_DEFINITION.name,
        result: result.value,
      };
    },
  };
}

function readRequiredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const env: Record<string, string> = {};

  for (const [key, item] of entries) {
    if (typeof item !== "string") {
      return undefined;
    }
    env[key] = item;
  }

  return env;
}

/**
 * Daemon HTTP server as a managed service.
 */
export class DaemonHttpServer implements DaemonManagedService {
  readonly id = "http-server";
  private server: ReturnType<typeof Bun.serve<DaemonWebSocketData>> | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly authService: ProviderAuthService;
  private readonly machineAuthService: MachineAuthService | null;
  private readonly modelRouter: ModelRouter;
  private readonly wsRegistry = new WsStreamRegistry<DaemonWebSocketData>();
  private wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private conversationManager: ConversationManager | null = null;
  private ownedSqliteStore: SQLiteConversationStore | null = null;
  private readonly conversationOptions: ConversationServiceOptions;
  private readonly streamRegistry = new StreamRegistry();
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private readonly streamSubscriptionsByConnection = new Map<string, Set<string>>();
  private readonly toolDefinitions: ToolDefinition[];
  private readonly toolExecutor: ToolExecutor;
  private readonly memoryService: MemoryService | null;
  private readonly memoryCapabilitiesResolver: MemoryCapabilitiesResolver;
  private readonly credentialStore: EncryptedCredentialStore | null;
  private readonly providerRegistry: ProviderRegistry | null;
  private readonly configuredConvexAuthToken: string | null;
  private readonly providedChannelService: ChannelDaemonService | null;
  private readonly environmentOptions: {
    daemonPathOptions?: DaemonPathOptions;
  };
  private channelService: ChannelDaemonService | null = null;
  private channelRouteHandler: ChannelRouteHandler | null = null;
  private configStore: ConfigStore | null = null;
  private environmentResolver: FileEnvironmentResolver | null = null;
  private environmentSwitchService: EnvironmentSwitchService | null = null;
  private environmentContextProvider: EnvironmentContextProvider | null = null;
  private personaRegistry: PersonaRegistry | null = null;
  private integrationService: IntegrationService | null = null;
  private convexClient: ConvexDaemonClient | null = null;
  private readonly skillService: SkillDaemonService | null;
  private readonly browserService: BrowserDaemonService | null;
  private readonly cronScheduler: CronScheduler | null;
  private activeSubAgentPool: SubAgentPool | null = null;
  private integrationHealth: HealthResponse["integrations"] = {
    initialized: false,
    registeredCount: 0,
    activeCount: 0,
    metaToolRegistered: false,
  };

  constructor(options: DaemonHttpServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.host = options.host ?? DEFAULT_HOST;
    this.conversationOptions = options.conversation ?? {};
    this.environmentOptions = options.environment ?? {};
    this.toolDefinitions = options.toolDefinitions ?? [];
    this.memoryService = options.memoryService ?? null;
    this.memoryCapabilitiesResolver = options.memoryCapabilitiesResolver ?? new MemoryCapabilitiesResolver();
    this.providedChannelService = options.channelService ?? null;
    this.skillService = options.skillService ?? null;
    this.browserService = options.browserService ?? null;
    this.cronScheduler = options.cronScheduler ?? null;
    this.configuredConvexAuthToken = normalizeOptionalToken(options.convexAuthToken);

    // Create auth services first so credential store is available for tool registration
    const legacyService = options.authService;
    const providerAuthService = options.providerAuthService
      ?? (isProviderAuthService(legacyService) ? legacyService : undefined);
    this.machineAuthService = options.machineAuthService
      ?? (isMachineAuthService(legacyService) ? legacyService : null);

    let credentialStore: EncryptedCredentialStore | undefined;
    let providerRegistry: ProviderRegistry | undefined;
    if (providerAuthService) {
      this.authService = providerAuthService;
      if (options.modelRouter) {
        this.modelRouter = options.modelRouter;
      } else {
        providerRegistry = new ProviderRegistry();
        this.modelRouter = new ModelRouter(providerRegistry);
      }
    } else {
      const services = createDefaultServices();
      this.authService = services.authService;
      this.modelRouter = services.modelRouter;
      credentialStore = services.credentialStore;
      providerRegistry = services.providerRegistry;
    }

    this.credentialStore = credentialStore ?? null;
    this.providerRegistry = providerRegistry ?? null;

    this.toolExecutor = options.toolExecutor ?? createDefaultToolExecutor(this.memoryService, credentialStore);

    if (this.providedChannelService) {
      this.channelService = this.providedChannelService;
      this.channelRouteHandler = createChannelRouteHandler({
        channelService: this.providedChannelService,
      });
    }
  }

  /**
   * Returns the conversation manager if conversation services are active.
   */
  getConversationManager(): ConversationManager | null {
    return this.conversationManager;
  }

  /**
   * Sets the active sub-agent pool for status reporting via /api/agents/status.
   * Pass null to clear when no pool is active.
   */
  setActiveSubAgentPool(pool: SubAgentPool | null): void {
    this.activeSubAgentPool = pool;
  }

  /**
   * Returns the active sub-agent pool, if any.
   */
  getActiveSubAgentPool(): SubAgentPool | null {
    return this.activeSubAgentPool;
  }

  /**
   * Returns the memory service if memory services are active.
   */
  getMemoryService(): MemoryService | null {
    return this.memoryService;
  }

  /**
   * Returns the stream registry for subscribing to lifecycle events.
   */
  getStreamRegistry(): StreamRegistry {
    return this.streamRegistry;
  }

  /**
   * Returns the daemon Convex client when configured.
   */
  getConvexClient(): ConvexDaemonClient | null {
    return this.convexClient;
  }

  /**
   * Updates daemon Convex auth token for authenticated mutations.
   */
  setConvexAuthToken(token: string): void {
    const normalized = normalizeOptionalToken(token);
    if (!normalized || !this.convexClient) {
      return;
    }

    this.convexClient.setAuthToken(normalized);
  }

  async start(): Promise<Result<void, DaemonError>> {
    if (this.server) {
      return err({
        name: "DaemonError",
        code: "SERVER_ALREADY_RUNNING",
        message: "HTTP server already running",
      });
    }

    try {
      await this.initializeEnvironmentServices();
    } catch (error) {
      log("warn", "Environment services failed to initialize; daemon will start without them", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.configStore = null;
      this.environmentResolver = null;
      this.environmentSwitchService = null;
      this.environmentContextProvider = null;
      this.personaRegistry = null;
    }

    await this.initializeConvexClient();

    await this.initializeByokProviders();

    try {
      this.initializeConversationServices();
    } catch (error) {
      log("warn", "Conversation services failed to initialize; daemon will start without them", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.initializeChannelServices();
    } catch (error) {
      log("warn", "Channel services failed to initialize; daemon will start without them", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.initializeIntegrationServices();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.integrationService = null;
      this.integrationHealth = {
        initialized: false,
        registeredCount: 0,
        activeCount: 0,
        metaToolRegistered: false,
        startupError: message,
      };
      this.removeToolDefinitionByName(INTEGRATION_META_TOOL_DEFINITION.name);
      log("warn", "Integration system failed to initialize; daemon will start without integrations", {
        error: message,
      });
    }

    this.initializeSkillTools();
    this.initializeBrowserTools();

    try {
      const requestHandler = this.machineAuthService
        ? createAuthMiddleware({
            authService: this.machineAuthService,
            exemptPaths: ["/health"],
            onAuthEvent: (event) => {
              log(event.level, event.message, event.data);
            },
          }).wrapHandler(this.handleRequest.bind(this))
        : this.handleRequest.bind(this);

      this.server = Bun.serve<DaemonWebSocketData>({
        port: this.port,
        hostname: this.host,
        fetch: requestHandler,
        websocket: {
          open: this.handleWebSocketOpen.bind(this),
          message: this.handleWebSocketMessage.bind(this),
          close: this.handleWebSocketClose.bind(this),
        },
      });
      this.startWebSocketHeartbeatLoop();

      const capabilities = this.conversationManager
        ? "with conversation services"
        : "without conversation services";
      log("info", `Daemon HTTP server listening on ${this.host}:${this.port} (${capabilities})`);
      return ok(undefined);
    } catch (error) {
      this.cleanupConversationServices();
      return err({
        name: "DaemonError",
        code: "SERVER_START_FAILED",
        message: `Failed to start HTTP server: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async stop(): Promise<Result<void, DaemonError>> {
    if (!this.server) {
      return ok(undefined);
    }

    try {
      if (this.integrationService) {
        const integrationStopResult = await this.integrationService.stop();
        if (!integrationStopResult.ok) {
          log("warn", "Integration system failed to stop cleanly", {
            error: integrationStopResult.error.message,
          });
        }
        this.integrationService = null;
      }

      this.integrationHealth = {
        initialized: false,
        registeredCount: 0,
        activeCount: 0,
        metaToolRegistered: false,
      };
      this.removeToolDefinitionByName(INTEGRATION_META_TOOL_DEFINITION.name);

      if (this.channelService) {
        await this.channelService.stop();
      }

      if (!this.providedChannelService) {
        this.channelService = null;
        this.channelRouteHandler = null;
      }

      this.stopWebSocketHeartbeatLoop();
      this.wsRegistry.clear();
      for (const execution of this.activeExecutions.values()) {
        if (!execution.controller.signal.aborted) {
          execution.controller.abort("daemon stopping");
        }
      }
      this.activeExecutions.clear();
      this.streamSubscriptionsByConnection.clear();
      this.server.stop();
      this.server = null;
      this.cleanupConversationServices();
      this.convexClient = null;
      log("info", "Daemon HTTP server stopped");
      return ok(undefined);
    } catch (error) {
      return err({
        name: "DaemonError",
        code: "SERVER_STOP_FAILED",
        message: `Failed to stop HTTP server: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async handleRequest(request: Request, server: Bun.Server<DaemonWebSocketData>): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    log("info", `${method} ${url.pathname}`);

    // CORS headers for local development
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Expose-Headers": "X-Reins-Token",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === WEBSOCKET_ROUTE) {
      const upgraded = server.upgrade(request, {
        data: {
          connectionId: crypto.randomUUID(),
          lastSeenAt: Date.now(),
        },
      });

      if (upgraded) {
        return new Response(null);
      }

      return Response.json({ error: "WebSocket upgrade required" }, { status: 426, headers: corsHeaders });
    }

    try {
      // Health check
      if (url.pathname === "/health") {
        const capabilities = ["providers.auth", "providers.models"];
        if (this.conversationManager) {
          capabilities.push("conversations.crud", "messages.send", "stream.subscribe");
        }
        if (this.channelService) {
          capabilities.push("channels.manage");
        }
        if (this.memoryService) {
          capabilities.push("memory.crud", "memory.search", "memory.consolidate");
        }
        if (this.integrationHealth.initialized) {
          capabilities.push("integrations.manage");
        }

        const health: HealthResponse = {
          status: "ok",
          timestamp: new Date().toISOString(),
          version: "0.1.0",
          contractVersion: CONTRACT_VERSION,
          integrations: this.integrationHealth,
          discovery: {
            capabilities,
            routes: {
              message: MESSAGE_ROUTE,
              conversations: CONVERSATIONS_ROUTE,
              websocket: WEBSOCKET_ROUTE,
            },
          },
        };
        return Response.json(health, { headers: corsHeaders });
      }

      // Models endpoint
      if (url.pathname === "/api/models" && method === "GET") {
        return this.handleModelsRequest(corsHeaders);
      }

      // Browser status endpoint
      if (url.pathname === "/api/browser/status" && method === "GET") {
        return this.handleBrowserStatus(corsHeaders);
      }

      // Browser stop endpoint
      if (url.pathname === "/api/browser/stop" && method === "POST") {
        return this.handleBrowserStop(corsHeaders);
      }

      // Browser launch-headed endpoint
      if (url.pathname === "/api/browser/launch-headed" && method === "POST") {
        return this.handleBrowserLaunchHeaded(corsHeaders);
      }

      // Browser launch-headless endpoint
      if (url.pathname === "/api/browser/launch-headless" && method === "POST") {
        return this.handleBrowserLaunchHeadless(corsHeaders);
      }

      // Browser screenshot endpoint
      if (url.pathname === "/api/browser/screenshot" && method === "POST") {
        return this.handleBrowserTakeScreenshot(request, corsHeaders);
      }

      // Agent status endpoint
      if (url.pathname === "/api/agents/status" && method === "GET") {
        return this.handleAgentsStatus(corsHeaders);
      }

      // Schedule list endpoint
      if (url.pathname === "/api/schedule/list" && method === "GET") {
        return this.handleScheduleList(corsHeaders);
      }

      // Schedule cancel endpoint
      if (url.pathname === "/api/schedule/cancel" && method === "POST") {
        return this.handleScheduleCancel(request, corsHeaders);
      }

      const environmentRoute = this.matchEnvironmentRoute(url.pathname);
      if (environmentRoute) {
        return this.handleEnvironmentRequest(environmentRoute, method, request, corsHeaders);
      }

      // Provider auth endpoints
      if (url.pathname.startsWith("/api/providers/auth/")) {
        return this.handleAuthRequest(url, method, request, corsHeaders);
      }

      const deviceCodeResponse = await this.handleDeviceCodeRequest(url, method, corsHeaders);
      if (deviceCodeResponse) {
        return deviceCodeResponse;
      }

      const channelResponse = await this.handleChannelRequest(url, method, request, corsHeaders);
      if (channelResponse) {
        return channelResponse;
      }

      // Message ingest endpoint — canonical (/api/messages) and compatibility (/messages)
      if (this.matchMessageRoute(url.pathname) && method === "POST") {
        return this.handlePostMessage(request, corsHeaders);
      }

      // Conversation CRUD endpoints — canonical (/api/conversations) and compatibility (/conversations)
      const conversationRoute = this.matchConversationRoute(url.pathname);
      if (conversationRoute) {
        return this.handleConversationRequest(conversationRoute, method, request, corsHeaders);
      }

      // Memory CRUD, search, and consolidation endpoints
      if (url.pathname === "/api/memory/capabilities") {
        if (method === "GET") {
          return this.handleMemoryCapabilities(corsHeaders);
        }

        if (method === "POST") {
          return this.handleMemoryCapabilitiesSave(request, corsHeaders);
        }

        return Response.json(
          { error: `Method ${method} not allowed on memory capabilities` },
          { status: 405, headers: corsHeaders },
        );
      }

      const memoryRoute = this.matchMemoryRoute(url.pathname);
      if (memoryRoute) {
        return this.handleMemoryRequest(memoryRoute, method, request, corsHeaders);
      }

      log("warn", `Not found: ${method} ${url.pathname}`);
      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (error) {
      log("error", "Request handler error", {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return Response.json(
        { error: error instanceof Error ? error.message : "Internal server error" },
        { status: 500, headers: corsHeaders }
      );
    }
  }

  private handleWebSocketOpen(socket: Bun.ServerWebSocket<DaemonWebSocketData>): void {
    socket.data.lastSeenAt = Date.now();
    this.streamSubscriptionsByConnection.set(socket.data.connectionId, new Set());
  }

  private handleWebSocketMessage(
    socket: Bun.ServerWebSocket<DaemonWebSocketData>,
    rawMessage: string | Buffer,
  ): void {
    socket.data.lastSeenAt = Date.now();

    const text = typeof rawMessage === "string" ? rawMessage : rawMessage.toString("utf8");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      this.sendWebSocketError(socket, "Malformed JSON payload");
      return;
    }

    const message = parseInboundWebSocketMessage(payload);
    if (!message) {
      this.sendWebSocketError(socket, "Unsupported websocket message type");
      return;
    }

    if (message.type === "stream.subscribe") {
      this.trackConnectionSubscription(socket.data.connectionId, message.conversationId, message.assistantMessageId);
      this.wsRegistry.subscribe(socket, {
        conversationId: message.conversationId,
        assistantMessageId: message.assistantMessageId,
      });
      const ack: DaemonStreamControlAckEnvelope = {
        type: "stream.subscribed",
        conversationId: message.conversationId,
        assistantMessageId: message.assistantMessageId,
        timestamp: new Date().toISOString(),
      };
      socket.send(JSON.stringify(ack));
      return;
    }

    if (message.type === "stream.unsubscribe") {
      this.wsRegistry.unsubscribe(socket, {
        conversationId: message.conversationId,
        assistantMessageId: message.assistantMessageId,
      });
      this.untrackConnectionSubscription(socket.data.connectionId, message.conversationId, message.assistantMessageId);
      const ack: DaemonStreamControlAckEnvelope = {
        type: "stream.unsubscribed",
        conversationId: message.conversationId,
        assistantMessageId: message.assistantMessageId,
        timestamp: new Date().toISOString(),
      };
      socket.send(JSON.stringify(ack));
      return;
    }

    if (message.type === "heartbeat.ping") {
      const pong: DaemonHeartbeatPongEnvelope = {
        type: "heartbeat.pong",
        timestamp: new Date().toISOString(),
      };
      socket.send(JSON.stringify(pong));
      return;
    }
  }

  private handleWebSocketClose(socket: Bun.ServerWebSocket<DaemonWebSocketData>): void {
    const targets = this.listConnectionTargets(socket.data.connectionId);
    this.wsRegistry.removeConnection(socket);
    this.streamSubscriptionsByConnection.delete(socket.data.connectionId);

    for (const target of targets) {
      this.abortExecutionIfUnobserved(target.conversationId, target.assistantMessageId, "stream client disconnected");
    }
  }

  private sendWebSocketError(socket: Bun.ServerWebSocket<DaemonWebSocketData>, message: string): void {
    const errorEnvelope: DaemonWebSocketErrorEnvelope = {
      type: "stream.error",
      error: {
        code: "INVALID_REQUEST",
        message,
      },
      timestamp: new Date().toISOString(),
    };

    socket.send(JSON.stringify(errorEnvelope));
  }

  private trackConnectionSubscription(connectionId: string, conversationId: string, assistantMessageId: string): void {
    const key = this.toExecutionKey(conversationId, assistantMessageId);
    const streamKeys = this.streamSubscriptionsByConnection.get(connectionId) ?? new Set<string>();
    streamKeys.add(key);
    this.streamSubscriptionsByConnection.set(connectionId, streamKeys);
  }

  private untrackConnectionSubscription(connectionId: string, conversationId: string, assistantMessageId: string): void {
    const streamKeys = this.streamSubscriptionsByConnection.get(connectionId);
    if (!streamKeys) {
      return;
    }

    streamKeys.delete(this.toExecutionKey(conversationId, assistantMessageId));
    if (streamKeys.size === 0) {
      this.streamSubscriptionsByConnection.delete(connectionId);
    }
  }

  private listConnectionTargets(connectionId: string): Array<{ conversationId: string; assistantMessageId: string }> {
    const streamKeys = this.streamSubscriptionsByConnection.get(connectionId);
    if (!streamKeys || streamKeys.size === 0) {
      return [];
    }

    const targets: Array<{ conversationId: string; assistantMessageId: string }> = [];
    for (const streamKey of streamKeys) {
      const target = this.fromExecutionKey(streamKey);
      if (target) {
        targets.push(target);
      }
    }

    return targets;
  }

  private abortExecutionIfUnobserved(conversationId: string, assistantMessageId: string, reason: string): void {
    if (this.wsRegistry.getSubscriptionCount({ conversationId, assistantMessageId }) > 0) {
      return;
    }

    this.abortExecution(conversationId, assistantMessageId, reason);
  }

  private abortExecution(conversationId: string, assistantMessageId: string, reason: string): void {
    const key = this.toExecutionKey(conversationId, assistantMessageId);
    const execution = this.activeExecutions.get(key);
    if (!execution || execution.controller.signal.aborted) {
      return;
    }

    execution.controller.abort(reason);
  }

  private toExecutionKey(conversationId: string, assistantMessageId: string): string {
    return `${conversationId}:${assistantMessageId}`;
  }

  private fromExecutionKey(key: string): { conversationId: string; assistantMessageId: string } | null {
    const separatorIndex = key.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === key.length - 1) {
      return null;
    }

    return {
      conversationId: key.slice(0, separatorIndex),
      assistantMessageId: key.slice(separatorIndex + 1),
    };
  }

  private startWebSocketHeartbeatLoop(): void {
    this.stopWebSocketHeartbeatLoop();

    this.wsHeartbeatTimer = setInterval(() => {
      const now = Date.now();
      this.wsRegistry.forEachSocket((socket) => {
        if (now - socket.data.lastSeenAt > WS_HEARTBEAT_TIMEOUT_MS) {
          const connectionId = socket.data.connectionId;
          const targets = this.listConnectionTargets(connectionId);
          try {
            socket.close(4002, "heartbeat-timeout");
          } finally {
            this.wsRegistry.removeConnection(socket);
            this.streamSubscriptionsByConnection.delete(connectionId);
            for (const target of targets) {
              this.abortExecutionIfUnobserved(target.conversationId, target.assistantMessageId, "stream client disconnected");
            }
          }
          return;
        }

        const ping: DaemonHeartbeatPingEnvelope = {
          type: "heartbeat.ping",
          timestamp: new Date().toISOString(),
        };
        socket.send(JSON.stringify(ping));
      });
    }, WS_HEARTBEAT_INTERVAL_MS);
  }

  private stopWebSocketHeartbeatLoop(): void {
    if (this.wsHeartbeatTimer) {
      clearInterval(this.wsHeartbeatTimer);
      this.wsHeartbeatTimer = null;
    }
  }

  private async handleModelsRequest(corsHeaders: Record<string, string>): Promise<Response> {
    try {
      const models = await this.modelRouter.listAllModels();
      const response = models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
      }));
      return Response.json({ models: response }, { headers: corsHeaders });
    } catch (error) {
      log("error", "listModels failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json({ models: [] }, { headers: corsHeaders });
    }
  }

  private handleBrowserStatus(corsHeaders: Record<string, string>): Response {
    if (!this.browserService) {
      return Response.json(
        { status: "stopped", headless: true },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const status = this.browserService.getStatus();

    if (!status.running) {
      return Response.json(
        { status: "stopped", headless: status.headless },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const response: Record<string, unknown> = {
      status: "running",
      headless: status.headless,
    };

    if (status.chrome) {
      response.pid = status.chrome.pid;
      response.profilePath = status.profilePath;
      response.uptimeMs = Date.now() - status.chrome.startedAt;
    }

    response.tabCount = status.tabs.length;

    if (status.memoryUsageMb !== undefined) {
      response.memoryUsageMb = status.memoryUsageMb;
    }

    return Response.json(response, {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  private async handleBrowserStop(corsHeaders: Record<string, string>): Promise<Response> {
    if (!this.browserService) {
      return Response.json(
        { stopped: true, message: "Browser service not running" },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const result = await this.browserService.stop();

    if (!result.ok) {
      return Response.json(
        { stopped: false, error: result.error.message },
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return Response.json(
      { stopped: true },
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  private async handleBrowserLaunchHeaded(corsHeaders: Record<string, string>): Promise<Response> {
    if (!this.browserService) {
      return Response.json(
        { ok: false, error: "Browser service not available" },
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const result = await this.browserService.launchHeaded();

    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.error.message },
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return Response.json(
      { ok: true, message: "Browser relaunched in headed mode" },
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  private async handleBrowserLaunchHeadless(corsHeaders: Record<string, string>): Promise<Response> {
    if (!this.browserService) {
      return Response.json(
        { ok: false, error: "Browser service not available" },
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const result = await this.browserService.launchHeadless();

    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.error.message },
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return Response.json(
      { ok: true, message: "Browser relaunched in headless mode" },
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  private async handleBrowserTakeScreenshot(
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    if (!this.browserService) {
      return Response.json(
        { ok: false, error: "Browser service not available" },
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let quality = 80;
    try {
      const body = (await request.json()) as { quality?: unknown };
      if (typeof body.quality === "number" && body.quality >= 0 && body.quality <= 100) {
        quality = body.quality;
      }
    } catch {
      // Use default quality if body is missing or invalid.
    }

    const result = await this.browserService.takeScreenshot(quality);

    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.error.message },
        { status: result.error.message.includes("not running") ? 409 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return Response.json(
      { ok: true, path: result.value.path, message: `Screenshot saved to ${result.value.path}` },
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  private handleAgentsStatus(corsHeaders: Record<string, string>): Response {
    if (!this.activeSubAgentPool) {
      return Response.json(
        { agents: [] },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const states = this.activeSubAgentPool.getAgentStates();
    const agents = states.map((state) => ({
      id: state.id,
      status: state.status,
      stepsUsed: state.stepsUsed,
      prompt: state.prompt,
    }));

    return Response.json(
      { agents },
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  private async handleScheduleList(corsHeaders: Record<string, string>): Promise<Response> {
    if (!this.cronScheduler) {
      return Response.json(
        { items: [] },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const result = await this.cronScheduler.listJobs();
    if (!result.ok) {
      return Response.json(
        { items: [], error: result.error.message },
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const activeJobs = result.value.filter(
      (job: CronJobDefinition) => job.status === "active" && job.nextRunAt !== null,
    );

    const items = activeJobs
      .map((job: CronJobDefinition) => ({
        id: job.id,
        type: "cron" as const,
        title: job.name,
        schedule: job.schedule,
        nextRunAt: job.nextRunAt,
        humanReadable: job.description || job.schedule,
      }))
      .sort((a, b) => {
        const aTime = a.nextRunAt ? Date.parse(a.nextRunAt) : Infinity;
        const bTime = b.nextRunAt ? Date.parse(b.nextRunAt) : Infinity;
        return aTime - bTime;
      });

    return Response.json(
      { items },
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  private async handleScheduleCancel(
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    let body: { id?: unknown; type?: unknown };
    try {
      body = (await request.json()) as { id?: unknown; type?: unknown };
    } catch {
      return Response.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const id = typeof body.id === "string" ? body.id.trim() : "";
    const itemType = typeof body.type === "string" ? body.type : "";

    if (id.length === 0) {
      return Response.json(
        { success: false, error: "Missing required field: id" },
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (itemType === "cron") {
      if (!this.cronScheduler) {
        return Response.json(
          { success: false, error: "Scheduler not available" },
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const result = await this.cronScheduler.remove(id);
      if (!result.ok) {
        return Response.json(
          { success: false, error: result.error.message },
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return Response.json(
        { success: true },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return Response.json(
      { success: false, error: `Unsupported item type: ${itemType}` },
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  private async initializeByokProviders(): Promise<void> {
    if (!this.providerRegistry || !this.credentialStore) {
      return;
    }

    const credentialResult = await this.credentialStore.list({
      type: "api_key",
      includeRevoked: false,
    });

    if (!credentialResult.ok) {
      log("warn", "Unable to load BYOK credentials for provider bootstrap", {
        error: credentialResult.error.message,
      });
      return;
    }

    const latestCredentialByProvider = new Map<string, CredentialRecord>();
    for (const credential of credentialResult.value) {
      if (!SUPPORTED_BYOK_PROVIDER_IDS.includes(credential.provider as (typeof SUPPORTED_BYOK_PROVIDER_IDS)[number])) {
        continue;
      }

      const current = latestCredentialByProvider.get(credential.provider);
      if (!current || credential.updatedAt > current.updatedAt) {
        latestCredentialByProvider.set(credential.provider, credential);
      }
    }

    if (latestCredentialByProvider.size === 0) {
      return;
    }

    let registeredCount = 0;

    for (const [providerId, credential] of latestCredentialByProvider.entries()) {
      const payloadResult = await this.credentialStore.decryptPayload<unknown>(credential);
      if (!payloadResult.ok) {
        log("warn", "Unable to decrypt BYOK credential payload", {
          provider: providerId,
          credentialId: credential.id,
          error: payloadResult.error.message,
        });
        continue;
      }

      if (!isStoredApiKeyPayload(payloadResult.value)) {
        log("warn", "Skipping non-BYOK API key payload during provider bootstrap", {
          provider: providerId,
          credentialId: credential.id,
        });
        continue;
      }

      const apiKey = payloadResult.value.key.trim();
      if (apiKey.length === 0) {
        log("warn", "Skipping empty API key payload during provider bootstrap", {
          provider: providerId,
          credentialId: credential.id,
        });
        continue;
      }

      const provider = createByokProvider(providerId, apiKey);
      if (!provider) {
        continue;
      }

      if (this.providerRegistry.has(providerId)) {
        this.providerRegistry.remove(providerId);
      }

      try {
        this.providerRegistry.register(provider);
        registeredCount += 1;
      } catch (error) {
        log("warn", "Failed to register BYOK provider during daemon startup", {
          provider: providerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (registeredCount > 0) {
      log("info", "Initialized BYOK providers in daemon registry", {
        registeredCount,
      });
    }
  }

  private async initializeIntegrationServices(): Promise<void> {
    const toolRegistry = this.toolExecutor.getRegistry();
    const integrationService = new IntegrationService({
      toolRegistry,
      credentialStore: this.credentialStore ?? undefined,
    });

    await this.registerBuiltinIntegrations(integrationService);

    const startResult = await integrationService.start();
    if (!startResult.ok) {
      throw startResult.error;
    }

    this.integrationService = integrationService;
    this.ensureToolDefinition(INTEGRATION_META_TOOL_DEFINITION);

    const registeredCount = integrationService.getRegistry().list().length;
    const activeCount = integrationService.getRegistry().listActive().length;
    this.integrationHealth = {
      initialized: true,
      registeredCount,
      activeCount,
      metaToolRegistered: toolRegistry.has(INTEGRATION_META_TOOL_DEFINITION.name),
    };

    log("info", "Integration system initialized", {
      registeredIntegrations: registeredCount,
      activeIntegrations: activeCount,
    });
  }

  private initializeSkillTools(): void {
    if (!this.skillService) {
      return;
    }

    const registry = this.skillService.getRegistry();
    const scanner = this.skillService.getScanner();
    if (!registry || !scanner) {
      log("warn", "Skill service is not ready; skipping skill tool registration");
      return;
    }

    const toolRegistry = this.toolExecutor.getRegistry();

    if (!toolRegistry.has(SKILL_TOOL_DEFINITION.name)) {
      toolRegistry.register(new SkillTool(registry, scanner));
    }
    this.ensureToolDefinition(SKILL_TOOL_DEFINITION);

    if (registry.hasEnabledScriptCapableSkills()) {
      if (!toolRegistry.has(RUN_SKILL_SCRIPT_TOOL_DEFINITION.name)) {
        const scriptRunner = new ScriptRunner(registry);
        toolRegistry.register(createSkillScriptTool(scriptRunner));
      }
      this.ensureToolDefinition(RUN_SKILL_SCRIPT_TOOL_DEFINITION);
    }
  }

  private initializeBrowserTools(): void {
    if (!this.browserService) {
      return;
    }

    const toolRegistry = this.toolExecutor.getRegistry();
    const elementRefRegistry = new ElementRefRegistry();
    const snapshotEngine = new SnapshotEngine(elementRefRegistry);

    if (!toolRegistry.has("browser")) {
      const browserTool = new BrowserTool(this.browserService);
      toolRegistry.register(browserTool);
      this.ensureToolDefinition(browserTool.definition);
    }

    if (!toolRegistry.has("browser_snapshot")) {
      const snapshotTool = new BrowserSnapshotTool(this.browserService, snapshotEngine);
      toolRegistry.register(snapshotTool);
      this.ensureToolDefinition(snapshotTool.definition);
    }

    if (!toolRegistry.has("browser_act")) {
      const actTool = new BrowserActTool(this.browserService, elementRefRegistry);
      toolRegistry.register(actTool);
      this.ensureToolDefinition(actTool.definition);
    }

    if (!toolRegistry.has("browser_debug")) {
      const debugBuffer = new DebugEventBuffer();
      const debugTool = new BrowserDebugTool(this.browserService, debugBuffer);
      toolRegistry.register(debugTool);
      this.ensureToolDefinition(debugTool.definition);
    }

    log("info", "Browser tools registered", {
      tools: ["browser", "browser_snapshot", "browser_act", "browser_debug"],
    });
  }

  private appendBrowserSystemPrompt(base: string | undefined): string {
    if (!base || base.trim().length === 0) {
      return BROWSER_SYSTEM_PROMPT;
    }

    return `${base}\n\n${BROWSER_SYSTEM_PROMPT}`;
  }

  private async registerBuiltinIntegrations(integrationService: IntegrationService): Promise<void> {
    const vault = integrationService.getCredentialVault();
    const registry = integrationService.getRegistry();

    const obsidianManifestResult = await loadObsidianManifest();
    if (obsidianManifestResult.ok) {
      registry.register(new ObsidianIntegration({
        vault,
        manifest: obsidianManifestResult.value,
        config: {
          enabled: false,
        },
      }));
    } else {
      log("warn", "Failed to load Obsidian integration manifest", {
        error: obsidianManifestResult.error.message,
      });
    }

  }

  private ensureToolDefinition(definition: ToolDefinition): void {
    if (this.toolDefinitions.some((toolDefinition) => toolDefinition.name === definition.name)) {
      return;
    }

    this.toolDefinitions.push(definition);
  }

  private removeToolDefinitionByName(name: string): void {
    const index = this.toolDefinitions.findIndex((toolDefinition) => toolDefinition.name === name);
    if (index < 0) {
      return;
    }

    this.toolDefinitions.splice(index, 1);
  }

  private async handleAuthRequest(
    url: URL,
    method: string,
    request: Request,
    corsHeaders: Record<string, string>
  ): Promise<Response> {
    const path = url.pathname;

    // GET /api/providers/auth/list
    if (path === "/api/providers/auth/list" && method === "GET") {
      const result = await this.authService.listProviders();
      if (result.ok) {
        return Response.json(result.value, { headers: corsHeaders });
      }
      log("error", "listProviders failed", { error: result.error.message });
      return Response.json({ error: result.error.message }, { status: 500, headers: corsHeaders });
    }

    // GET /api/providers/auth/status/:providerId
    const statusMatch = path.match(/^\/api\/providers\/auth\/status\/([^/]+)$/);
    if (statusMatch && method === "GET") {
      const providerId = statusMatch[1];
      const result = await this.authService.getProviderAuthStatus(providerId);
      if (result.ok) {
        return Response.json(result.value, { headers: corsHeaders });
      }
      log("error", "getProviderAuthStatus failed", { providerId, error: result.error.message });
      return Response.json({ error: result.error.message }, { status: 500, headers: corsHeaders });
    }

    // POST /api/providers/auth/configure
    if (path === "/api/providers/auth/configure" && method === "POST") {
      const body = await request.json();
      const providerId = body.providerId ?? body.provider;
      const mode = body.mode;
      const apiKey = body.apiKey ?? body.key;
      const source = body.source ?? "tui";
      log("info", "Configure request", { providerId, mode });

      if (!providerId || !mode) {
        return Response.json({ error: "Missing providerId or mode" }, { status: 400, headers: corsHeaders });
      }

      if (mode === "api_key") {
        if (!apiKey) {
          return Response.json({ error: "Missing apiKey for BYOK mode" }, { status: 400, headers: corsHeaders });
        }

        const result = await this.authService.handleCommand({
          provider: providerId,
          source: source as "tui" | "cli" | "desktop",
          mode: "api_key",
          key: apiKey,
        });

        if (result.ok) {
          const configured = result.value.credential !== undefined && result.value.credential !== null;
          if (configured) {
            log("info", "BYOK configured successfully", { providerId });
            return Response.json({
              configured: true,
              valid: true,
              provider: providerId,
              providerId,
            }, { headers: corsHeaders });
          }

          const message = result.value.guidance?.message ?? "Provider configuration failed";
          log("warn", "BYOK configure did not persist credential", {
            providerId,
            guidance: result.value.guidance?.action,
          });
          return Response.json({
            configured: false,
            valid: false,
            provider: providerId,
            providerId,
            error: message,
            message,
            guidance: result.value.guidance,
          }, { headers: corsHeaders });
        }
        log("error", "BYOK configure failed", { providerId, error: result.error.message });
        return Response.json({ error: result.error.message }, { status: 400, headers: corsHeaders });
      }

      return Response.json({ error: `Unsupported mode: ${mode}` }, { status: 400, headers: corsHeaders });
    }

    // POST /api/providers/auth/oauth/initiate
    if (path === "/api/providers/auth/oauth/initiate" && method === "POST") {
      const body = await request.json();
      const providerId = body.providerId ?? body.provider;
      log("info", "OAuth initiate request", { providerId, rawBody: body });

      if (!providerId) {
        return Response.json({ error: "Missing providerId" }, { status: 400, headers: corsHeaders });
      }

      const result = await this.authService.initiateOAuth(providerId);
      if (result.ok) {
        log("info", "OAuth initiated", { providerId, type: result.value.type });
        // Normalize response so TUI can find the URL under authUrl/url
        const response: Record<string, unknown> = { ...result.value, provider: providerId };
        if (result.value.type === "authorization_code") {
          response.authUrl = result.value.authorizationUrl;
          response.url = result.value.authorizationUrl;
        }
        return Response.json(response, { headers: corsHeaders });
      }
      log("error", "OAuth initiate failed", { providerId, error: result.error.message });
      return Response.json({ error: result.error.message }, { status: 500, headers: corsHeaders });
    }

    // POST /api/providers/auth/oauth/callback
    if (path === "/api/providers/auth/oauth/callback" && method === "POST") {
      const body = await request.json();
      const providerId = body.providerId ?? body.provider;
      const { code, state } = body;
      log("info", "OAuth callback received", { providerId, hasCode: !!code, hasState: !!state });

      if (!providerId || !code) {
        return Response.json(
          { error: "Missing required OAuth callback parameters" },
          { status: 400, headers: corsHeaders }
        );
      }

      const result = await this.authService.completeOAuthCallback(providerId, { code, state });
      if (result.ok) {
        log("info", "OAuth callback completed", { providerId });
        return Response.json({ success: true }, { headers: corsHeaders });
      }
      log("error", "OAuth callback failed", { providerId, error: result.error.message });
      return Response.json({ error: result.error.message }, { status: 400, headers: corsHeaders });
    }

    // POST /api/providers/auth/oauth/exchange — exchange pasted auth code for tokens
    if (path === "/api/providers/auth/oauth/exchange" && method === "POST") {
      const body = await request.json();
      const providerId = body.providerId ?? body.provider;
      const code = body.code;
      const state = typeof body.state === "string" ? body.state : undefined;
      const codeVerifier = typeof body.codeVerifier === "string" ? body.codeVerifier : undefined;
      log("info", "OAuth code exchange request", {
        providerId,
        hasCode: !!code,
        hasState: !!state,
        hasVerifier: !!codeVerifier,
      });

      if (!providerId || !code) {
        return Response.json(
          { error: "Missing providerId or code" },
          { status: 400, headers: corsHeaders }
        );
      }

      // The code from Anthropic's callback page may be "code#state"
      // Pass codeVerifier for PKCE flow (required by Anthropic OAuth)
      const result = await this.authService.completeOAuthCallback(providerId, { 
        code, 
        state,
        exchange: codeVerifier ? { codeVerifier } : undefined
      });
      if (result.ok) {
        log("info", "OAuth code exchange completed", { providerId });
        return Response.json({ success: true, provider: providerId }, { headers: corsHeaders });
      }
      const causeMessage = result.error.cause instanceof Error ? result.error.cause.message : undefined;
      log("error", "OAuth code exchange failed", {
        providerId,
        error: result.error.message,
        cause: causeMessage,
        codeLength: typeof code === "string" ? code.length : 0,
        stateLength: typeof state === "string" ? state.length : 0,
        verifierLength: typeof codeVerifier === "string" ? codeVerifier.length : 0,
      });
      const detail = causeMessage ? `${result.error.message} (${causeMessage})` : result.error.message;
      return Response.json({ error: detail }, { status: 400, headers: corsHeaders });
    }

    // GET /api/providers/auth/check-conversation/:providerId
    const checkMatch = path.match(/^\/api\/providers\/auth\/check-conversation\/([^/]+)$/);
    if (checkMatch && method === "GET") {
      const providerId = checkMatch[1];
      const result = await this.authService.checkConversationReady(providerId);
      if (result.ok) {
        return Response.json(result.value, { headers: corsHeaders });
      }
      log("error", "checkConversationReady failed", { providerId, error: result.error.message });
      return Response.json({ error: result.error.message }, { status: 500, headers: corsHeaders });
    }

    log("warn", `Auth endpoint not found: ${method} ${path}`);
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }

  private async handleDeviceCodeRequest(
    url: URL,
    method: string,
    corsHeaders: Record<string, string>,
  ): Promise<Response | null> {
    if (url.pathname === "/auth/device-code") {
      if (method !== "POST") {
        return Response.json(
          { error: `Method ${method} not allowed on /auth/device-code` },
          { status: 405, headers: corsHeaders },
        );
      }

      return await this.handleCreateDeviceCode(corsHeaders);
    }

    const statusMatch = url.pathname.match(/^\/auth\/device-code\/([^/]+)\/status$/);
    if (!statusMatch) {
      return null;
    }

    if (method !== "GET") {
      return Response.json(
        { error: `Method ${method} not allowed on /auth/device-code/:code/status` },
        { status: 405, headers: corsHeaders },
      );
    }

    const code = decodeURIComponent(statusMatch[1]);
    return await this.handleGetDeviceCodeStatus(code, corsHeaders);
  }

  private async handleCreateDeviceCode(corsHeaders: Record<string, string>): Promise<Response> {
    if (!this.convexClient || !this.convexClient.isReady()) {
      return Response.json(
        { error: "Convex client is not available" },
        { status: 503, headers: corsHeaders },
      );
    }

    const generationResult = await generateDeviceCode({
      convexClient: this.convexClient,
    });
    if (!generationResult.ok) {
      log("error", "Device code generation failed", { error: generationResult.error.message });
      return Response.json(
        { error: generationResult.error.message },
        { status: 500, headers: corsHeaders },
      );
    }

    const verificationUrl = this.buildDeviceCodeVerificationUrl(generationResult.value.code);
    return Response.json(
      {
        code: generationResult.value.code,
        verificationUrl,
        expiresAt: generationResult.value.expiresAt,
      },
      { headers: corsHeaders },
    );
  }

  private async handleGetDeviceCodeStatus(
    code: string,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    if (!this.convexClient || !this.convexClient.isReady()) {
      return Response.json(
        { error: "Convex client is not available" },
        { status: 503, headers: corsHeaders },
      );
    }

    const statusResult = await pollDeviceCode({
      convexClient: this.convexClient,
      code,
    });
    if (!statusResult.ok) {
      log("error", "Device code polling failed", { code, error: statusResult.error.message });
      return Response.json(
        { error: statusResult.error.message },
        { status: 500, headers: corsHeaders },
      );
    }

    if (statusResult.value.status !== "verified") {
      return Response.json(
        {
          status: statusResult.value.status,
          expiresAt: statusResult.value.expiresAt,
        },
        { headers: corsHeaders },
      );
    }

    const sessionTokenResult = await this.resolveDeviceCodeSessionToken(
      code,
      statusResult.value.sessionToken,
      statusResult.value.userId,
    );
    if (!sessionTokenResult.ok) {
      log("error", "Failed to resolve device session token", {
        code,
        error: sessionTokenResult.error.message,
      });
      return Response.json(
        { error: sessionTokenResult.error.message },
        { status: 500, headers: corsHeaders },
      );
    }

    this.setConvexAuthToken(sessionTokenResult.value);

    return Response.json(
      {
        status: "verified",
        sessionToken: sessionTokenResult.value,
      },
      { headers: corsHeaders },
    );
  }

  private async resolveDeviceCodeSessionToken(
    code: string,
    providedSessionToken: string | undefined,
    userId: string | undefined,
  ): Promise<Result<string, AuthError>> {
    const normalizedProvidedToken = normalizeOptionalToken(providedSessionToken);
    if (normalizedProvidedToken) {
      await this.persistDeviceSessionToken(code, normalizedProvidedToken, userId);
      return ok(normalizedProvidedToken);
    }

    if (!this.credentialStore) {
      return ok(createDeviceSessionToken());
    }

    const accountId = `device-code:${code}`;
    const existingResult = await this.credentialStore.get({
      provider: "convex",
      type: "token",
      accountId,
    });
    if (!existingResult.ok) {
      return err(existingResult.error);
    }

    const existingRecord = existingResult.value;
    if (existingRecord) {
      const existingPayloadResult = await this.credentialStore.decryptPayload<StoredDeviceSessionPayload>(existingRecord);
      if (existingPayloadResult.ok) {
        const existingToken = normalizeOptionalToken(existingPayloadResult.value.sessionToken);
        if (existingToken) {
          return ok(existingToken);
        }
      }
    }

    const sessionToken = createDeviceSessionToken();
    const persistResult = await this.persistDeviceSessionToken(code, sessionToken, userId);
    if (!persistResult.ok) {
      return persistResult;
    }

    return ok(sessionToken);
  }

  private async persistDeviceSessionToken(
    code: string,
    sessionToken: string,
    userId: string | undefined,
  ): Promise<Result<void, AuthError>> {
    if (!this.credentialStore) {
      return ok(undefined);
    }

    const persistedResult = await this.credentialStore.set({
      provider: "convex",
      type: "token",
      accountId: `device-code:${code}`,
      metadata: userId ? { userId } : undefined,
      payload: {
        sessionToken,
        userId,
        issuedAt: new Date().toISOString(),
        source: "device_code",
      } as StoredDeviceSessionPayload,
    });
    if (!persistedResult.ok) {
      return err(persistedResult.error);
    }

    return ok(undefined);
  }

  private buildDeviceCodeVerificationUrl(code: string): string {
    if (!this.convexClient) {
      return `https://bold-malamute-667.convex.site/device-auth?code=${encodeURIComponent(code)}`;
    }

    const siteOrigin = toConvexSiteOrigin(this.convexClient.getConvexUrl());
    if (!siteOrigin) {
      return `https://bold-malamute-667.convex.site/device-auth?code=${encodeURIComponent(code)}`;
    }

    return `${siteOrigin}/device-auth?code=${encodeURIComponent(code)}`;
  }

  private async handleChannelRequest(
    url: URL,
    method: string,
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response | null> {
    if (!url.pathname.startsWith("/channels")) {
      return null;
    }

    if (!this.channelRouteHandler) {
      return Response.json(
        { error: "Channel services are not available" },
        { status: 503, headers: corsHeaders },
      );
    }

    return await this.channelRouteHandler.handle(url, method, request, corsHeaders);
  }

  /**
   * Match conversation routes for both canonical (/api/conversations) and
   * compatibility (/conversations) paths. Returns null if no match.
   */
  private matchConversationRoute(pathname: string): { type: "list" } | { type: "detail"; id: string } | null {
    // Canonical: /api/conversations or /api/conversations/:id
    if (pathname === "/api/conversations" || pathname === "/conversations") {
      return { type: "list" };
    }

    const canonicalMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (canonicalMatch) {
      return { type: "detail", id: decodeURIComponent(canonicalMatch[1]) };
    }

    const compatMatch = pathname.match(/^\/conversations\/([^/]+)$/);
    if (compatMatch) {
      return { type: "detail", id: decodeURIComponent(compatMatch[1]) };
    }

    return null;
  }

  /**
   * Match message routes for both canonical (/api/messages) and
   * compatibility (/messages) paths.
   */
  private matchMessageRoute(pathname: string): boolean {
    return pathname === MESSAGE_ROUTE.canonical || pathname === MESSAGE_ROUTE.compatibility;
  }

  private matchEnvironmentRoute(pathname: string):
    | { type: "list" }
    | { type: "switch" }
    | { type: "status" }
    | null {
    if (pathname === ENVIRONMENTS_ROUTE.list) {
      return { type: "list" };
    }

    if (pathname === ENVIRONMENTS_ROUTE.switch) {
      return { type: "switch" };
    }

    if (pathname === ENVIRONMENTS_ROUTE.status) {
      return { type: "status" };
    }

    return null;
  }

  private async handleEnvironmentRequest(
    route: { type: "list" } | { type: "switch" } | { type: "status" },
    method: string,
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    if (!this.environmentSwitchService || !this.environmentResolver) {
      return Response.json(
        { error: "Environment services are not available", code: "SWITCH_FAILED" },
        { status: 503, headers: corsHeaders },
      );
    }

    const url = new URL(request.url);

    if (route.type === "list") {
      if (method !== "GET") {
        return Response.json(
          { error: `Method ${method} not allowed on environments collection` },
          { status: 405, headers: corsHeaders },
        );
      }

      return this.handleListEnvironments(url, corsHeaders);
    }

    if (route.type === "switch") {
      if (method !== "POST") {
        return Response.json(
          { error: `Method ${method} not allowed on environment switch` },
          { status: 405, headers: corsHeaders },
        );
      }

      return this.handleSwitchEnvironment(request, corsHeaders);
    }

    if (method !== "GET") {
      return Response.json(
        { error: `Method ${method} not allowed on environment status` },
        { status: 405, headers: corsHeaders },
      );
    }

    return this.handleEnvironmentStatus(url, corsHeaders);
  }

  private async handleListEnvironments(
    url: URL,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const includeDocumentTypes = url.searchParams.get("includeDocumentTypes") === "true";
    const activeEnvironmentResult = await this.environmentSwitchService!.getCurrentEnvironment();
    if (!activeEnvironmentResult.ok) {
      return this.mapEnvironmentInternalErrorToResponse(
        "Unable to determine active environment",
        corsHeaders,
      );
    }

    const environmentsResult = await this.environmentResolver!.listEnvironments();
    if (!environmentsResult.ok) {
      return this.mapEnvironmentErrorToResponse(environmentsResult.error, corsHeaders);
    }

    const environments: EnvironmentSummaryDto[] = environmentsResult.value.map((environment) => ({
      name: environment.name,
      path: environment.path,
      availableDocumentTypes: includeDocumentTypes
        ? Object.keys(environment.documents) as EnvironmentSummaryDto["availableDocumentTypes"]
        : [],
    }));

    const response: EnvironmentListResponse = {
      activeEnvironment: activeEnvironmentResult.value,
      environments,
    };

    return Response.json(response, { headers: corsHeaders });
  }

  private async handleSwitchEnvironment(
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    let body: EnvironmentSwitchRequest;

    try {
      body = (await request.json()) as EnvironmentSwitchRequest;
    } catch {
      const response: EnvironmentErrorResponse = {
        error: "Invalid JSON in request body",
        code: "SWITCH_FAILED",
      };
      return Response.json(response, { status: 400, headers: corsHeaders });
    }

    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      const response: EnvironmentErrorResponse = {
        error: "Environment name is required",
        code: "INVALID_ENVIRONMENT_NAME",
      };
      return Response.json(response, { status: 400, headers: corsHeaders });
    }

    const switchResult = await this.environmentSwitchService!.switchEnvironment(body.name.trim());
    if (!switchResult.ok) {
      return this.mapEnvironmentErrorToResponse(switchResult.error, corsHeaders);
    }

    const response: EnvironmentSwitchResponse = {
      activeEnvironment: switchResult.value.activeEnvironment,
      previousEnvironment: switchResult.value.previousEnvironment,
      switchedAt: switchResult.value.switchedAt.toISOString(),
      resolution: toOverlayResolutionDto(switchResult.value.resolvedDocuments),
    };

    return Response.json(response, { headers: corsHeaders });
  }

  private async handleEnvironmentStatus(
    url: URL,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const requestedEnvironmentName = url.searchParams.get("environmentName")?.trim();
    const resolvedResult = await this.environmentSwitchService!.getResolvedDocuments(
      requestedEnvironmentName && requestedEnvironmentName.length > 0
        ? requestedEnvironmentName
        : undefined,
    );

    if (!resolvedResult.ok) {
      return this.mapEnvironmentErrorToResponse(resolvedResult.error, corsHeaders);
    }

    const response: EnvironmentStatusResponse = {
      activeEnvironment: resolvedResult.value.activeEnvironment,
      resolution: toOverlayResolutionDto(resolvedResult.value),
    };

    return Response.json(response, { headers: corsHeaders });
  }

  private mapEnvironmentErrorToResponse(
    error: unknown,
    corsHeaders: Record<string, string>,
  ): Response {
    if (error instanceof InvalidEnvironmentNameError) {
      const response: EnvironmentErrorResponse = {
        error: error.message,
        code: "INVALID_ENVIRONMENT_NAME",
      };
      return Response.json(response, { status: 400, headers: corsHeaders });
    }

    if (error instanceof EnvironmentNotFoundError) {
      const response: EnvironmentErrorResponse = {
        error: error.message,
        code: "ENVIRONMENT_NOT_FOUND",
      };
      return Response.json(response, { status: 404, headers: corsHeaders });
    }

    return this.mapEnvironmentInternalErrorToResponse(
      error instanceof Error ? error.message : "Environment request failed",
      corsHeaders,
    );
  }

  private mapEnvironmentInternalErrorToResponse(
    message: string,
    corsHeaders: Record<string, string>,
  ): Response {
    const response: EnvironmentErrorResponse = {
      error: message,
      code: "SWITCH_FAILED",
    };

    return Response.json(response, { status: 500, headers: corsHeaders });
  }

  /**
   * POST /api/messages — accept user content, persist immediately, and return
   * stream identifiers while provider completion runs asynchronously.
   *
   * Validates:
   * - `content` is a non-empty string (required)
   * - `role` is absent or "user" (assistant/system roles are rejected)
   * - `conversationId`, if provided, references an existing conversation
   *
   * On success, persists the user message and a placeholder assistant message,
   * then schedules provider execution in the background.
   */
  private async handlePostMessage(
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    if (!this.conversationManager) {
      return Response.json(
        { error: "Conversation services are not available" },
        { status: 503, headers: corsHeaders },
      );
    }

    // Parse request body
    let body: unknown;
    try {
      const text = await request.text();
      if (text.length === 0) {
        return Response.json(
          { error: "Request body is required" },
          { status: 400, headers: corsHeaders },
        );
      }
      body = JSON.parse(text);
    } catch {
      return Response.json(
        { error: "Invalid JSON in request body" },
        { status: 400, headers: corsHeaders },
      );
    }

    // Validate payload shape
    if (!isPostMessagePayload(body)) {
      return Response.json(
        { error: "Invalid request: content is required and must be a non-empty string" },
        { status: 400, headers: corsHeaders },
      );
    }

    const payload = body as DaemonPostMessageRequestDto;

    // Guard against assistant/system roles — only user messages are accepted
    if (payload.role && payload.role !== "user") {
      return Response.json(
        { error: `Role "${payload.role}" is not allowed; only user messages can be submitted` },
        { status: 400, headers: corsHeaders },
      );
    }

    try {
      const result = await this.conversationManager.sendMessage({
        conversationId: payload.conversationId,
        content: payload.content,
        model: payload.model,
        provider: payload.provider,
      });

      const response: DaemonPostMessageResponseDto = {
        conversationId: result.conversationId,
        messageId: result.userMessageId,
        assistantMessageId: result.assistantMessageId,
        timestamp: result.timestamp.toISOString(),
        userMessageId: result.userMessageId,
      };

      log("info", "Message ingested", {
        conversationId: result.conversationId,
        userMessageId: result.userMessageId,
        assistantMessageId: result.assistantMessageId,
      });

      this.scheduleProviderExecution({
        conversationId: result.conversationId,
        assistantMessageId: result.assistantMessageId,
        requestedProvider: payload.provider,
        requestedModel: payload.model,
        thinkingLevel: payload.thinkingLevel,
      });

      return Response.json(response, { status: 201, headers: corsHeaders });
    } catch (error) {
      return this.mapConversationErrorToResponse(error, corsHeaders);
    }
  }

  private scheduleProviderExecution(context: ProviderExecutionContext): void {
    void Promise.resolve()
      .then(async () => {
        await this.waitForStreamSubscriptionWindow(
          context.conversationId,
          context.assistantMessageId,
        );
        await this.executeProviderGeneration(context);
      })
      .catch((error) => {
        log("error", "Provider execution scheduler failed", {
          conversationId: context.conversationId,
          assistantMessageId: context.assistantMessageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async waitForStreamSubscriptionWindow(
    conversationId: string,
    assistantMessageId: string,
  ): Promise<void> {
    const target = { conversationId, assistantMessageId };
    if (this.wsRegistry.getSubscriptionCount(target) > 0) {
      return;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < STREAM_SUBSCRIPTION_GRACE_MS) {
      if (this.wsRegistry.getSubscriptionCount(target) > 0) {
        return;
      }

      if (this.streamSubscriptionsByConnection.size === 0) {
        return;
      }

      await Bun.sleep(STREAM_SUBSCRIPTION_POLL_MS);
    }
  }

  private async executeProviderGeneration(context: ProviderExecutionContext): Promise<void> {
    if (!this.conversationManager) {
      return;
    }

    const abortController = new AbortController();
    const executionKey = this.toExecutionKey(context.conversationId, context.assistantMessageId);
    this.activeExecutions.set(executionKey, {
      conversationId: context.conversationId,
      assistantMessageId: context.assistantMessageId,
      controller: abortController,
    });

    let resolvedProvider = context.requestedProvider;
    let resolvedModel = context.requestedModel;
    let sequence = -1;
    const nextSequence = (): number => {
      sequence += 1;
      return sequence;
    };

    try {
      const conversation = await this.conversationManager.load(context.conversationId);
      const requestedProvider = context.requestedProvider ?? conversation.provider;
      const requestedModel = context.requestedModel ?? conversation.model;
      const baseSystemPrompt = await this.conversationManager.getEnvironmentSystemPrompt(
        conversation.personaId,
      );
      const runtimeSystemPrompt = this.browserService
        ? this.appendBrowserSystemPrompt(baseSystemPrompt)
        : baseSystemPrompt;

      const authResult = await this.authService.checkConversationReady(requestedProvider);
      if (!authResult.ok) {
        throw authResult.error;
      }

      if (!authResult.value.allowed) {
        const failure = this.toProviderExecutionFailure(
          new AuthError(
            authResult.value.guidance?.message ??
              `Provider ${authResult.value.provider} is not ready for conversations.`,
          ),
        );

        await this.persistProviderExecutionFailure(context, failure, {
          provider: authResult.value.provider,
          model: requestedModel,
        });
        return;
      }

      let routeResult: Result<AuthenticatedRouteResult, AuthError>;
      try {
        routeResult = await this.modelRouter.routeWithAuthCheck({
          provider: requestedProvider,
          model: requestedModel,
          capabilities: ["chat", "streaming"],
        });
      } catch (error) {
        const canRetryWithoutModel =
          error instanceof ProviderError
          && typeof requestedModel === "string"
          && requestedModel.trim().length > 0;

        if (!canRetryWithoutModel) {
          throw error;
        }

        log("warn", "Requested model route unavailable, retrying with provider default", {
          conversationId: context.conversationId,
          requestedProvider,
          requestedModel,
        });

        routeResult = await this.modelRouter.routeWithAuthCheck({
          provider: requestedProvider,
          capabilities: ["chat", "streaming"],
        });
      }

      if (!routeResult.ok) {
        throw routeResult.error;
      }

      resolvedProvider = routeResult.value.provider.config.id;
      resolvedModel = routeResult.value.model.id;

      const anthropicContext = this.mapConversationToAnthropicContext(
        conversation.messages,
        context.assistantMessageId,
        runtimeSystemPrompt,
      );

      if (context.thinkingLevel && context.thinkingLevel !== "none") {
        log("info", "Thinking requested for provider generation", {
          conversationId: context.conversationId,
          assistantMessageId: context.assistantMessageId,
          thinkingLevel: context.thinkingLevel,
          provider: routeResult.value.provider.config.id,
          model: routeResult.value.model.id,
        });
      }

      const generation = await this.generateAndStream({
        context,
        providerId: routeResult.value.provider.config.id,
        modelCapabilities: routeResult.value.model.capabilities,
        modelId: routeResult.value.model.id,
        messages: anthropicContext.messages,
        systemPrompt: anthropicContext.systemPrompt,
        nextSequence,
        provider: routeResult.value.provider,
        abortSignal: abortController.signal,
      });

      const assistantContent = generation.content;
      const assistantText = getTextContent(assistantContent);
      const finishReason = generation.finishReason;
      const usage = generation.usage;

      await this.conversationManager.completeAssistantMessage({
        conversationId: context.conversationId,
        assistantMessageId: context.assistantMessageId,
        content: assistantContent,
        provider: resolvedProvider,
        model: resolvedModel,
        finishReason,
        usage,
      });

      this.publishStreamLifecycleEvent({
        type: "stream-event",
        event: {
          type: "message_complete",
          conversationId: context.conversationId,
          messageId: context.assistantMessageId,
          content: assistantText,
          sequence: nextSequence(),
          finishReason,
          usage,
          timestamp: new Date().toISOString(),
        },
      });

      if (this.channelService) {
        try {
          await this.channelService.forwardAssistantResponse(
            context.conversationId,
            assistantText,
            context.assistantMessageId,
          );
        } catch (error) {
          log("warn", "Failed to forward assistant response to channel", {
            conversationId: context.conversationId,
            assistantMessageId: context.assistantMessageId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      log("info", "Provider response persisted", {
        conversationId: context.conversationId,
        assistantMessageId: context.assistantMessageId,
        provider: resolvedProvider,
        model: resolvedModel,
        contentLength: assistantText.length,
      });
    } catch (error) {
      const failure = this.toProviderExecutionFailure(error);
      const errorSequence = nextSequence();
      await this.persistProviderExecutionFailure(context, failure, {
        provider: resolvedProvider,
        model: resolvedModel,
      }, errorSequence);

      if (this.channelService) {
        try {
          await this.channelService.forwardAssistantResponse(
            context.conversationId,
            failure.message,
            context.assistantMessageId,
          );
        } catch (forwardError) {
          log("warn", "Failed to forward provider failure to channel", {
            conversationId: context.conversationId,
            assistantMessageId: context.assistantMessageId,
            error: forwardError instanceof Error ? forwardError.message : String(forwardError),
          });
        }
      }
    } finally {
      this.activeExecutions.delete(executionKey);
    }
  }

  private async generateAndStream(options: {
    context: ProviderExecutionContext;
    providerId: string;
    modelCapabilities: string[];
    modelId: string;
    messages: Message[];
    systemPrompt?: string;
    nextSequence: () => number;
    provider: Provider;
    abortSignal?: AbortSignal;
  }): Promise<{
    content: string | ContentBlock[];
    finishReason?: string;
    usage?: TokenUsage;
  }> {
    const useHarness = this.shouldUseHarness(options.providerId, options.modelCapabilities);

    log("info", "Generation routing decision", {
      providerId: options.providerId,
      modelCapabilities: options.modelCapabilities,
      toolDefinitionsCount: this.toolDefinitions.length,
      useHarness,
    });

    if (useHarness) {
      return await this.generateAndStreamWithHarness(options);
    }

    return await this.generateAndStreamSingleTurn(options);
  }

  private shouldUseHarness(providerId: string, modelCapabilities: string[]): boolean {
    if (this.toolDefinitions.length === 0) {
      return false;
    }

    if (!modelCapabilities.includes("tool_use")) {
      return false;
    }

    // Accept any Anthropic provider variant (anthropic, anthropic-oauth, byok-anthropic)
    return providerId.includes("anthropic");
  }

  private async generateAndStreamWithHarness(options: {
    context: ProviderExecutionContext;
    providerId: string;
    modelCapabilities: string[];
    modelId: string;
    messages: Message[];
    systemPrompt?: string;
    nextSequence: () => number;
    provider: Provider;
    abortSignal?: AbortSignal;
  }): Promise<{
    content: string | ContentBlock[];
    finishReason?: string;
    usage?: TokenUsage;
  }> {
    const loop = new AgentLoop({ signal: options.abortSignal });
    let didEmitStart = false;

    for await (const event of loop.runWithProvider({
      provider: options.provider,
      model: options.modelId,
      messages: options.messages,
      systemPrompt: options.systemPrompt,
      thinkingLevel: options.context.thinkingLevel,
      tools: this.toolDefinitions,
      toolExecutor: this.toolExecutor,
      toolContext: {
        conversationId: options.context.conversationId,
        userId: "daemon",
        abortSignal: options.abortSignal,
      },
      abortSignal: options.abortSignal,
    })) {
      if (!didEmitStart && event.type !== "error") {
        didEmitStart = true;
        this.publishStreamLifecycleEvent({
          type: "stream-event",
          event: {
            type: "message_start",
            conversationId: options.context.conversationId,
            messageId: options.context.assistantMessageId,
            sequence: options.nextSequence(),
            timestamp: new Date().toISOString(),
          },
        });
      }

      if (event.type === "token") {
        this.publishStreamLifecycleEvent({
          type: "stream-event",
          event: {
            type: "content_chunk",
            conversationId: options.context.conversationId,
            messageId: options.context.assistantMessageId,
            chunk: event.content,
            sequence: options.nextSequence(),
            timestamp: new Date().toISOString(),
          },
        });
        continue;
      }

      if (event.type === "thinking") {
        this.publishStreamLifecycleEvent({
          type: "stream-event",
          event: {
            type: "thinking_chunk",
            conversationId: options.context.conversationId,
            messageId: options.context.assistantMessageId,
            chunk: event.content,
            sequence: options.nextSequence(),
            timestamp: new Date().toISOString(),
          },
        });
        continue;
      }

      if (event.type === "tool_call_start") {
        this.publishStreamLifecycleEvent({
          type: "stream-event",
          event: {
            type: "tool_call_start",
            conversationId: options.context.conversationId,
            messageId: options.context.assistantMessageId,
            tool_use_id: event.toolCall.id,
            name: event.toolCall.name,
            input: event.toolCall.arguments,
            toolCall: {
              id: event.toolCall.id,
              name: event.toolCall.name,
              arguments: event.toolCall.arguments,
            },
            sequence: options.nextSequence(),
            timestamp: new Date().toISOString(),
          },
        });
        continue;
      }

      if (event.type === "tool_call_end") {
        const isError = typeof event.result.error === "string" && event.result.error.length > 0;
        this.publishStreamLifecycleEvent({
          type: "stream-event",
          event: {
            type: "tool_call_end",
            conversationId: options.context.conversationId,
            messageId: options.context.assistantMessageId,
            tool_use_id: event.result.callId,
            name: event.result.name,
            result_summary: summarizeToolResult(event.result),
            is_error: isError,
            result: {
              callId: event.result.callId,
              name: event.result.name,
              result: event.result.result,
              error: event.result.error,
            },
            sequence: options.nextSequence(),
            timestamp: new Date().toISOString(),
          },
        });
        continue;
      }

      if (event.type === "error") {
        throw event.error;
      }

      if (event.type === "done") {
        return {
          content: event.content,
          finishReason: event.finishReason,
          usage: event.usage,
        };
      }
    }

    return {
      content: "",
      finishReason: "stop",
    };
  }

  private async generateAndStreamSingleTurn(options: {
    context: ProviderExecutionContext;
    modelCapabilities: string[];
    modelId: string;
    messages: Message[];
    systemPrompt?: string;
    nextSequence: () => number;
    provider: Provider;
    abortSignal?: AbortSignal;
  }): Promise<{
    content: string;
    finishReason?: string;
    usage?: TokenUsage;
  }> {
    let assistantContent = "";
    let finishReason: string | undefined;
    let didEmitStart = false;
    let usage:
      | {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
        }
      | undefined;

    for await (const event of options.provider.stream({
      model: options.modelId,
      messages: options.messages,
      systemPrompt: options.systemPrompt,
      thinkingLevel: options.context.thinkingLevel,
      tools: this.toolDefinitions.length > 0 ? this.toolDefinitions : undefined,
      signal: options.abortSignal,
    })) {
      if (!didEmitStart) {
        didEmitStart = true;
        this.publishStreamLifecycleEvent({
          type: "stream-event",
          event: {
            type: "message_start",
            conversationId: options.context.conversationId,
            messageId: options.context.assistantMessageId,
            sequence: options.nextSequence(),
            timestamp: new Date().toISOString(),
          },
        });
      }

      if (event.type === "token") {
        assistantContent += event.content ?? "";
        this.publishStreamLifecycleEvent({
          type: "stream-event",
          event: {
            type: "content_chunk",
            conversationId: options.context.conversationId,
            messageId: options.context.assistantMessageId,
            chunk: event.content ?? "",
            sequence: options.nextSequence(),
            timestamp: new Date().toISOString(),
          },
        });
        continue;
      }

      if (event.type === "thinking") {
        this.publishStreamLifecycleEvent({
          type: "stream-event",
          event: {
            type: "thinking_chunk",
            conversationId: options.context.conversationId,
            messageId: options.context.assistantMessageId,
            chunk: event.content ?? "",
            sequence: options.nextSequence(),
            timestamp: new Date().toISOString(),
          },
        });
        continue;
      }

      if (event.type === "error") {
        throw event.error ?? new Error("Provider stream failed");
      }

      if (event.type === "done") {
        finishReason = event.finishReason;
        usage = event.usage;
      }
    }

    return {
      content: assistantContent,
      finishReason,
      usage,
    };
  }

  private mapConversationToAnthropicContext(
    messages: Message[],
    assistantMessageId: string,
    runtimeSystemPrompt?: string,
  ): { systemPrompt?: string; messages: Message[] } {
    const orderedMessages = [...messages].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    let latestSystemPrompt: string | undefined;
    const chatMessages: Message[] = [];

    for (const message of orderedMessages) {
      if (message.role === "system") {
        const systemText = getTextContent(message.content).trim();
        if (systemText.length > 0) {
          latestSystemPrompt = systemText;
        }
        continue;
      }

      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }

      if (message.id === assistantMessageId && message.role === "assistant") {
        continue;
      }

      chatMessages.push(message);
    }

    if (chatMessages.length === 0) {
      throw new ConversationError("Conversation has no user or assistant history to send to provider");
    }

    // Expand assistant messages that contain tool_result blocks from the
    // harness agent loop.  The harness stores all accumulated content blocks
    // (text, tool_use, tool_result) as a single assistant message.  Anthropic
    // requires tool_result blocks to be in user messages, so we split them:
    //   assistant: [text?, tool_use blocks]
    //   user:      [tool_result blocks]
    //   assistant: [remaining text blocks]
    const expandedMessages = this.expandToolResultMessages(chatMessages);
    const effectiveSystemPrompt = runtimeSystemPrompt?.trim() || latestSystemPrompt;

    return {
      systemPrompt:
        typeof effectiveSystemPrompt === "string" && effectiveSystemPrompt.length > 0
          ? effectiveSystemPrompt
          : undefined,
      messages: expandedMessages,
    };
  }

  /**
   * Expand assistant messages containing tool_result blocks into the proper
   * Anthropic message sequence: assistant (tool_use) → user (tool_result) →
   * assistant (text).
   *
   * This handles the case where the harness agent loop stores its full
   * multi-turn content (text + tool_use + tool_result + final text) as a
   * single assistant message.
   */
  private expandToolResultMessages(messages: Message[]): Message[] {
    const result: Message[] = [];

    for (const message of messages) {
      if (
        message.role !== "assistant" ||
        typeof message.content === "string" ||
        !message.content.some((block) => block.type === "tool_result")
      ) {
        result.push(message);
        continue;
      }

      // Split content blocks into segments: each segment is a group of blocks
      // that belong to the same message role.
      //   - text, tool_use → assistant
      //   - tool_result    → user
      const blocks = message.content;
      let currentAssistantBlocks: typeof blocks = [];
      let currentToolResultBlocks: typeof blocks = [];

      const flushAssistant = () => {
        if (currentAssistantBlocks.length > 0) {
          result.push({
            ...message,
            id: `${message.id}_asst_${result.length}`,
            role: "assistant",
            content: currentAssistantBlocks,
          });
          currentAssistantBlocks = [];
        }
      };

      const flushToolResults = () => {
        if (currentToolResultBlocks.length > 0) {
          result.push({
            ...message,
            id: `${message.id}_user_${result.length}`,
            role: "user",
            content: currentToolResultBlocks,
          });
          currentToolResultBlocks = [];
        }
      };

      for (const block of blocks) {
        if (block.type === "tool_result") {
          // Flush any pending assistant blocks before starting tool results
          flushAssistant();
          currentToolResultBlocks.push(block);
        } else {
          // Flush any pending tool results before continuing assistant blocks
          flushToolResults();
          currentAssistantBlocks.push(block);
        }
      }

      // Flush remaining blocks
      flushAssistant();
      flushToolResults();
    }

    return result;
  }

  private async persistProviderExecutionFailure(
    context: ProviderExecutionContext,
    failure: ProviderExecutionFailure,
    route: { provider?: string; model?: string },
    sequence?: number,
  ): Promise<void> {
    if (!this.conversationManager) {
      return;
    }

    try {
      await this.conversationManager.failAssistantMessage({
        conversationId: context.conversationId,
        assistantMessageId: context.assistantMessageId,
        errorCode: failure.code,
        errorMessage: failure.message,
        provider: route.provider,
        model: route.model,
      });
    } catch (persistError) {
      log("error", "Failed to persist provider execution failure", {
        conversationId: context.conversationId,
        assistantMessageId: context.assistantMessageId,
        error: persistError instanceof Error ? persistError.message : String(persistError),
      });
    }

    this.emitProviderStreamErrorEvent(context, failure, sequence);
  }

  private emitProviderStreamErrorEvent(
    context: Pick<ProviderExecutionContext, "conversationId" | "assistantMessageId">,
    failure: ProviderExecutionFailure,
    sequence = 0,
  ): void {
    const streamErrorEvent: DaemonStreamLifecycleEnvelope = {
      type: "stream-event",
      event: {
        type: "error",
        conversationId: context.conversationId,
        messageId: context.assistantMessageId,
        sequence,
        error: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
        timestamp: new Date().toISOString(),
      },
    };

    this.publishStreamLifecycleEvent(streamErrorEvent);

    log("error", "Provider generation failed", {
      conversationId: context.conversationId,
      assistantMessageId: context.assistantMessageId,
      daemonErrorCode: failure.code,
      daemonErrorMessage: failure.message,
      retryable: failure.retryable,
      diagnostic: failure.diagnostic,
      streamEvent: streamErrorEvent,
    });
  }

  private publishStreamLifecycleEvent(envelope: DaemonStreamLifecycleEnvelope): void {
    const legacyEvent: StreamLifecycleEvent =
      envelope.event.type === "message_start"
        ? {
            type: "message_start",
            conversationId: envelope.event.conversationId,
            messageId: envelope.event.messageId,
            sequence: envelope.event.sequence,
            timestamp: envelope.event.timestamp,
          }
      : envelope.event.type === "content_chunk"
          ? {
              type: "content_chunk",
              conversationId: envelope.event.conversationId,
              messageId: envelope.event.messageId,
              delta: envelope.event.chunk,
              sequence: envelope.event.sequence,
              timestamp: envelope.event.timestamp,
            }
          : envelope.event.type === "thinking_chunk"
            ? {
                type: "thinking_chunk",
                conversationId: envelope.event.conversationId,
                messageId: envelope.event.messageId,
                delta: envelope.event.chunk,
                sequence: envelope.event.sequence,
                timestamp: envelope.event.timestamp,
              }
          : envelope.event.type === "tool_call_start"
            ? {
                type: "tool_call_start",
                conversationId: envelope.event.conversationId,
                messageId: envelope.event.messageId,
                tool_use_id: envelope.event.tool_use_id,
                name: envelope.event.name,
                input: envelope.event.input,
                toolCall: {
                  id: envelope.event.toolCall.id,
                  name: envelope.event.toolCall.name,
                  arguments: envelope.event.toolCall.arguments,
                },
                sequence: envelope.event.sequence,
                timestamp: envelope.event.timestamp,
              }
            : envelope.event.type === "tool_call_end"
              ? {
                  type: "tool_call_end",
                  conversationId: envelope.event.conversationId,
                  messageId: envelope.event.messageId,
                  tool_use_id: envelope.event.tool_use_id,
                  name: envelope.event.name,
                  result_summary: envelope.event.result_summary,
                  is_error: envelope.event.is_error,
                  result: {
                    callId: envelope.event.result.callId,
                    name: envelope.event.result.name,
                    result: envelope.event.result.result,
                    error: envelope.event.result.error,
                  },
                  sequence: envelope.event.sequence,
                  timestamp: envelope.event.timestamp,
                }
              : envelope.event.type === "message_complete"
            ? {
                type: "message_complete",
                conversationId: envelope.event.conversationId,
                messageId: envelope.event.messageId,
                content: envelope.event.content,
                sequence: envelope.event.sequence,
                timestamp: envelope.event.timestamp,
                finishReason: envelope.event.finishReason,
                usage: envelope.event.usage,
              }
            : {
                type: "error",
                conversationId: envelope.event.conversationId,
                messageId: envelope.event.messageId,
                sequence: envelope.event.sequence,
                timestamp: envelope.event.timestamp,
                error: {
                  code: envelope.event.error.code,
                  message: envelope.event.error.message,
                  retryable: envelope.event.error.retryable,
                },
              };

    this.streamRegistry.emit(legacyEvent);

    const delivered = this.wsRegistry.publish(
      {
        conversationId: envelope.event.conversationId,
        assistantMessageId: envelope.event.messageId,
      },
      envelope,
    );

    log("info", "Stream lifecycle event published", {
      eventType: envelope.event.type,
      conversationId: envelope.event.conversationId,
      assistantMessageId: envelope.event.messageId,
      delivered,
      sequence: envelope.event.sequence,
    });
  }

  private toProviderExecutionFailure(error: unknown): ProviderExecutionFailure {
    if (error instanceof AuthError) {
      return {
        code: "UNAUTHORIZED",
        message: error.message,
        retryable: false,
        diagnostic: error.message,
      };
    }

    if (error instanceof ProviderError) {
      return this.fromProviderErrorMessage(error.message);
    }

    if (error instanceof ConversationError) {
      return {
        code: "NOT_FOUND",
        message: error.message,
        retryable: false,
        diagnostic: error.message,
      };
    }

    if (error instanceof Error) {
      return this.fromProviderErrorMessage(error.message);
    }

    return {
      code: "INTERNAL_ERROR",
      message: "Provider request failed unexpectedly.",
      retryable: false,
      diagnostic: String(error),
    };
  }

  private fromProviderErrorMessage(message: string): ProviderExecutionFailure {
    const normalized = message.toLowerCase();

    if (normalized.includes("429") || normalized.includes("rate limit")) {
      return {
        code: "PROVIDER_UNAVAILABLE",
        message: "Provider rate limit reached. Please retry shortly.",
        retryable: true,
        diagnostic: message,
      };
    }

    if (
      normalized.includes("401") ||
      normalized.includes("403") ||
      normalized.includes("unauthorized") ||
      normalized.includes("forbidden") ||
      normalized.includes("invalid credential")
    ) {
      return {
        code: "UNAUTHORIZED",
        message: "Provider authentication failed. Run /connect to re-authenticate.",
        retryable: false,
        diagnostic: message,
      };
    }

    if (
      normalized.includes("network") ||
      normalized.includes("timed out") ||
      normalized.includes("timeout") ||
      normalized.includes("fetch") ||
      normalized.includes("econn") ||
      normalized.includes("enotfound")
    ) {
      return {
        code: "PROVIDER_UNAVAILABLE",
        message: "Provider network error. Please retry.",
        retryable: true,
        diagnostic: message,
      };
    }

    return {
      code: "PROVIDER_UNAVAILABLE",
      message: message.trim().length > 0 ? message : "Provider failed to generate a response.",
      retryable: true,
      diagnostic: message,
    };
  }

  /**
   * Handle conversation CRUD requests.
   * Routes: POST (create), GET (list/get), DELETE (remove).
   * Maps ConversationManager errors to appropriate HTTP status codes.
   */
  private async handleConversationRequest(
    route: { type: "list" } | { type: "detail"; id: string },
    method: string,
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    // All conversation endpoints require an active conversation manager
    if (!this.conversationManager) {
      return Response.json(
        { error: "Conversation services are not available" },
        { status: 503, headers: corsHeaders },
      );
    }

    try {
      if (route.type === "list") {
        if (method === "POST") {
          return this.handleCreateConversation(request, corsHeaders);
        }
        if (method === "GET") {
          return this.handleListConversations(corsHeaders);
        }
        return Response.json(
          { error: `Method ${method} not allowed on conversations collection` },
          { status: 405, headers: corsHeaders },
        );
      }

      // route.type === "detail"
      if (method === "GET") {
        return this.handleGetConversation(route.id, corsHeaders);
      }
      if (method === "DELETE") {
        return this.handleDeleteConversation(route.id, corsHeaders);
      }
      return Response.json(
        { error: `Method ${method} not allowed on conversation resource` },
        { status: 405, headers: corsHeaders },
      );
    } catch (error) {
      // Map ConversationError "not found" messages to 404, everything else to 500
      return this.mapConversationErrorToResponse(error, corsHeaders);
    }
  }

  /**
   * POST /api/conversations — create a new conversation.
   * Accepts optional title, model, and provider in the request body.
   * Returns the full conversation record as a canonical DTO.
   */
  private async handleCreateConversation(
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    let body: DaemonCreateConversationRequestDto = {};
    try {
      const text = await request.text();
      if (text.length > 0) {
        body = JSON.parse(text) as DaemonCreateConversationRequestDto;
      }
    } catch {
      return Response.json(
        { error: "Invalid JSON in request body" },
        { status: 400, headers: corsHeaders },
      );
    }

    const conversation = await this.conversationManager!.create({
      title: body.title,
      model: body.model ?? "claude-sonnet-4-20250514",
      provider: body.provider ?? "anthropic",
    });

    log("info", "Conversation created", { conversationId: conversation.id });
    return Response.json(
      this.conversationToRecordDto(conversation),
      { status: 201, headers: corsHeaders },
    );
  }

  /**
   * GET /api/conversations — list conversation summaries.
   * Returns metadata for each conversation: id, title, model, provider,
   * messageCount, createdAt, updatedAt.
   */
  private async handleListConversations(
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const summaries = await this.conversationManager!.list();

    const dtos: DaemonConversationSummaryDto[] = summaries.map((summary) => ({
      id: summary.id,
      title: summary.title,
      model: summary.model,
      provider: summary.provider,
      messageCount: summary.messageCount,
      createdAt: summary.createdAt.toISOString(),
      updatedAt: (summary.updatedAt ?? summary.createdAt).toISOString(),
    }));

    return Response.json(dtos, { headers: corsHeaders });
  }

  /**
   * GET /api/conversations/:id — get a conversation with full ordered message history.
   * Returns 404 if the conversation does not exist.
   */
  private async handleGetConversation(
    conversationId: string,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const conversation = await this.conversationManager!.load(conversationId);
    return Response.json(
      this.conversationToRecordDto(conversation),
      { headers: corsHeaders },
    );
  }

  /**
   * DELETE /api/conversations/:id — delete a conversation and its messages.
   * SQLite FK CASCADE handles child message deletion atomically.
   * Returns 204 on success, 404 if the conversation does not exist.
   */
  private async handleDeleteConversation(
    conversationId: string,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const deleted = await this.conversationManager!.delete(conversationId);

    if (!deleted) {
      // Conversation did not exist — return 404 for explicit feedback
      return Response.json(
        { error: `Conversation not found: ${conversationId}` },
        { status: 404, headers: corsHeaders },
      );
    }

    log("info", "Conversation deleted", { conversationId });
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  /**
   * Map a domain Conversation to the canonical wire DTO.
   * Messages are ordered by createdAt (ascending) as stored.
   */
  private conversationToRecordDto(conversation: Conversation): DaemonConversationRecordDto {
    const messages: DaemonMessageRecordDto[] = conversation.messages.map((message) => {
      const metadata = message.metadata as Record<string, unknown> | undefined;
      return {
        id: message.id,
        role: message.role as DaemonMessageRole,
        content: serializeContent(message.content),
        createdAt: message.createdAt.toISOString(),
        provider: typeof metadata?.provider === "string" ? metadata.provider : undefined,
        model: typeof metadata?.model === "string" ? metadata.model : undefined,
      };
    });

    return {
      id: conversation.id,
      title: conversation.title,
      model: conversation.model,
      provider: conversation.provider,
      messageCount: conversation.messages.length,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messages,
    };
  }

  /**
   * Map conversation-layer errors to HTTP responses.
   * ConversationError with "not found" in the message → 404.
   * All other errors → 500 with a safe error message.
   */
  private mapConversationErrorToResponse(
    error: unknown,
    corsHeaders: Record<string, string>,
  ): Response {
    if (error instanceof ConversationError) {
      // ConversationManager.load throws with "Conversation not found: <id>"
      const isNotFound = error.message.toLowerCase().includes("not found");
      const status = isNotFound ? 404 : 500;
      log(isNotFound ? "warn" : "error", "Conversation operation failed", {
        error: error.message,
        status,
      });
      return Response.json(
        { error: error.message },
        { status, headers: corsHeaders },
      );
    }

    const message = error instanceof Error ? error.message : "Internal server error";
    log("error", "Unexpected conversation error", { error: message });
    return Response.json(
      { error: message },
      { status: 500, headers: corsHeaders },
    );
  }

  /**
   * Initialize environment services used for prompt context and /api/environments routes.
   */
  private async initializeEnvironmentServices(): Promise<void> {
    const bootstrapResult = await bootstrapInstallRoot(this.environmentOptions.daemonPathOptions);
    if (!bootstrapResult.ok) {
      throw bootstrapResult.error;
    }

    const paths = buildInstallPaths(this.environmentOptions.daemonPathOptions);

    this.configStore = new ConfigStore(paths.globalConfigPath);
    this.environmentResolver = new FileEnvironmentResolver(paths.environmentsDir);
    this.environmentSwitchService = new EnvironmentSwitchService(
      this.configStore,
      this.environmentResolver,
    );
    this.personaRegistry = new PersonaRegistry();
    this.environmentContextProvider = new EnvironmentContextProvider(
      this.environmentSwitchService,
      new SystemPromptBuilder(),
      this.environmentSwitchService,
    );
  }

  /**
   * Initialize conversation services (SQLite store + manager).
   * If a ConversationManager was injected via options, use it directly.
   * Otherwise, create a SQLiteConversationStore and wrap it in a new manager.
   */
  private initializeConversationServices(): void {
    if (this.conversationOptions.conversationManager) {
      this.conversationManager = this.conversationOptions.conversationManager;
      log("info", "Conversation services initialized (injected manager)");
      return;
    }

    const store = new SQLiteConversationStore({
      path: this.conversationOptions.sqliteStorePath,
    });
    this.ownedSqliteStore = store;

    let compactionOptions;
    try {
      compactionOptions = this.buildCompactionOptions(store.path);
    } catch (error) {
      log("warn", "Failed to initialize compaction dependencies; continuing without write-through", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.conversationManager = new ConversationManager(
      store,
      compactionOptions?.sessionRepository,
      compactionOptions?.options,
      this.personaRegistry && this.environmentContextProvider
        ? {
            personaRegistry: this.personaRegistry,
            environmentContextProvider: this.environmentContextProvider,
            skillSummaryProvider: this.skillService
              ? {
                  getSummaries: () => this.skillService?.getRegistry()?.getSummaries() ?? [],
                }
              : undefined,
          }
        : undefined,
    );
    log("info", "Conversation services initialized (SQLite store)", {
      path: store.path,
    });
  }

  private async initializeChannelServices(): Promise<void> {
    if (!this.channelService && this.providedChannelService) {
      this.channelService = this.providedChannelService;
      this.channelRouteHandler = createChannelRouteHandler({
        channelService: this.providedChannelService,
      });
    }

    if (!this.channelService) {
      if (!this.conversationManager || !this.credentialStore) {
        return;
      }

      const channelRegistry = new ChannelRegistry();
      const credentialStorage = new ChannelCredentialStorage({
        store: this.credentialStore,
      });
      const conversationBridge = new ConversationBridge({
        conversationManager: this.conversationManager,
        channelRegistry,
      });

      this.channelService = new ChannelDaemonService({
        channelRegistry,
        conversationBridge,
        credentialStorage,
        onInboundAssistantPending: (context) => {
          this.scheduleProviderExecution({
            conversationId: context.conversationId,
            assistantMessageId: context.assistantMessageId,
          });
        },
      });
      this.channelRouteHandler = createChannelRouteHandler({
        channelService: this.channelService,
      });
    }

    await this.channelService.start();
  }

  private async initializeConvexClient(): Promise<void> {
    const authToken = this.configuredConvexAuthToken
      ?? normalizeOptionalToken(process.env.CONVEX_AUTH_TOKEN ?? Bun.env.CONVEX_AUTH_TOKEN);
    this.convexClient = createConvexDaemonClientFromEnv(authToken ?? undefined);

    if (!this.convexClient) {
      log("warn", "CONVEX_URL is not configured; daemon will continue without Convex conversation sync");
      return;
    }

    const initialized = await this.convexClient.initialize();
    if (!initialized) {
      log("warn", "Convex client failed to initialize; daemon will continue without Convex conversation sync", {
        error: this.convexClient.getLoadError()?.message,
      });
      return;
    }

    log("info", "Convex client initialized", {
      convexUrl: this.convexClient.getConvexUrl(),
      authenticated: this.convexClient.getAuthToken() !== null,
    });
  }

  private buildCompactionOptions(
    sqliteStorePath: string,
  ): {
    sessionRepository: SessionRepository;
    options: ConversationManagerCompactionOptions;
  } {
    const runtimeRoot = join(
      dirname(sqliteStorePath),
      `.reins-runtime-${parse(sqliteStorePath).name}`,
    );

    const sessionRepository = new SessionRepository({
      sessionsDir: join(runtimeRoot, "sessions"),
    });
    const transcriptStore = new TranscriptStore({
      transcriptsDir: join(runtimeRoot, "transcripts"),
    });

    const compactionService = new CompactionService({
      config: this.conversationOptions.compactionConfig,
    });
    const memoryStore = new LocalFileMemoryStore(join(runtimeRoot, "memory", "compaction-store.json"));

    if (!this.memoryService) {
      return {
        sessionRepository,
        options: {
          compactionService,
          memoryStore,
          transcriptStore,
        },
      };
    }

    const sessionExtractor = new SessionExtractor({
      memoryService: this.memoryService,
    });
    const compactionManager = new CompactionManager();
    compactionManager.addPreCompactionHook(
      new MemoryPreservationHook({
        sessionExtractor,
      }),
    );

    return {
      sessionRepository,
      options: {
        compactionService,
        memoryStore,
        transcriptStore,
        memoryWriteThrough: {
          compactionManager,
          logger: {
            info: (message: string) => log("info", message),
            warn: (message: string) => log("warn", message),
            error: (message: string) => log("error", message),
          },
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Memory route matching and handlers
  // ---------------------------------------------------------------------------

  /**
   * Match memory routes: /api/memory, /api/memory/:id, /api/memory/search,
   * /api/memory/consolidate.
   */
  private matchMemoryRoute(
    pathname: string,
  ): { type: "list" } | { type: "detail"; id: string } | { type: "search" } | { type: "consolidate" } | null {
    if (pathname === "/api/memory/search") {
      return { type: "search" };
    }

    if (pathname === "/api/memory/consolidate") {
      return { type: "consolidate" };
    }

    if (pathname === "/api/memory") {
      return { type: "list" };
    }

    const detailMatch = pathname.match(/^\/api\/memory\/([^/]+)$/);
    if (detailMatch) {
      return { type: "detail", id: decodeURIComponent(detailMatch[1]) };
    }

    return null;
  }

  /**
   * Handle memory CRUD, search, and consolidation requests.
   * Routes: POST (create), GET (list/get), PUT (update), DELETE (remove),
   * POST /search, POST /consolidate.
   *
   * CRUD operations are always available when memory service is ready.
   * Search and consolidation are gated on embedding provider configuration
   * to enforce graceful degradation before setup.
   */
  private async handleMemoryRequest(
    route: { type: "list" } | { type: "detail"; id: string } | { type: "search" } | { type: "consolidate" },
    method: string,
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    if (!this.memoryService) {
      return Response.json(
        { error: "Memory services are not available" },
        { status: 503, headers: corsHeaders },
      );
    }

    if (!this.memoryService.isReady()) {
      return Response.json(
        { error: "Memory service is not ready" },
        { status: 503, headers: corsHeaders },
      );
    }

    try {
      if (route.type === "search") {
        if (method !== "POST") {
          return Response.json(
            { error: `Method ${method} not allowed on memory search` },
            { status: 405, headers: corsHeaders },
          );
        }

        const capabilityGate = await this.checkEmbeddingCapability("semanticSearch", corsHeaders);
        if (capabilityGate) {
          return capabilityGate;
        }

        return this.handleMemorySearch(request, corsHeaders);
      }

      if (route.type === "consolidate") {
        if (method !== "POST") {
          return Response.json(
            { error: `Method ${method} not allowed on memory consolidation` },
            { status: 405, headers: corsHeaders },
          );
        }

        const capabilityGate = await this.checkEmbeddingCapability("consolidation", corsHeaders);
        if (capabilityGate) {
          return capabilityGate;
        }

        return this.handleMemoryConsolidate(corsHeaders);
      }

      if (route.type === "list") {
        if (method === "POST") {
          return this.handleMemoryCreate(request, corsHeaders);
        }
        if (method === "GET") {
          return this.handleMemoryList(request, corsHeaders);
        }
        return Response.json(
          { error: `Method ${method} not allowed on memory collection` },
          { status: 405, headers: corsHeaders },
        );
      }

      // route.type === "detail"
      if (method === "GET") {
        return this.handleMemoryGet(route.id, corsHeaders);
      }
      if (method === "PUT") {
        return this.handleMemoryUpdate(route.id, request, corsHeaders);
      }
      if (method === "DELETE") {
        return this.handleMemoryDelete(route.id, corsHeaders);
      }
      return Response.json(
        { error: `Method ${method} not allowed on memory resource` },
        { status: 405, headers: corsHeaders },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      log("error", "Memory operation failed", { error: message });
      return Response.json(
        { error: message },
        { status: 500, headers: corsHeaders },
      );
    }
  }

  private async resolveMemoryCapabilitiesState(): Promise<MemoryCapabilities> {
    const capabilitiesResult = await this.memoryCapabilitiesResolver.getCapabilities();
    if (capabilitiesResult.ok) {
      return capabilitiesResult.value;
    }

    const configPath = resolveMemoryConfigPath();
    return resolveMemoryCapabilities(null, configPath);
  }

  /**
   * Check whether an embedding-dependent capability is enabled.
   * Returns a 503 response when the feature is gated, or null when allowed.
   */
  private async checkEmbeddingCapability(
    feature: "semanticSearch" | "consolidation",
    corsHeaders: Record<string, string>,
  ): Promise<Response | null> {
    const capabilities = await this.resolveMemoryCapabilitiesState();
    const featureState = capabilities.features[feature];

    if (featureState.enabled) {
      return null;
    }

    const featureLabel = feature === "semanticSearch" ? "Semantic search" : "Consolidation";
    const reason = featureState.reason ?? "Embedding provider setup is required.";

    log("info", `${featureLabel} gated: embedding not configured`, { feature });

    return Response.json(
      {
        error: `${featureLabel} requires embedding provider configuration. Run /memory setup to configure.`,
        code: "EMBEDDING_NOT_CONFIGURED",
        feature,
        reason,
        setupRequired: true,
      },
      { status: 503, headers: corsHeaders },
    );
  }

  private async handleMemoryCapabilities(
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const capabilities = await this.resolveMemoryCapabilitiesState();
    return this.memoryCapabilitiesResponse(capabilities, corsHeaders);
  }

  private async handleMemoryCapabilitiesSave(
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const body = await this.parseJsonBody(request);
    if (!body.ok) {
      return Response.json(
        { error: body.error },
        { status: 400, headers: corsHeaders },
      );
    }

    const validated = this.validateMemoryCapabilitiesSaveRequest(body.value);
    if (!validated.ok) {
      return Response.json(
        { error: validated.error },
        { status: 400, headers: corsHeaders },
      );
    }

    const config: MemoryConfig = {
      embedding: validated.value.embedding,
    };
    const saveResult = await this.memoryCapabilitiesResolver.saveConfig(config);
    if (!saveResult.ok) {
      return Response.json(
        { error: saveResult.error.message },
        { status: 500, headers: corsHeaders },
      );
    }

    const capabilities = await this.resolveMemoryCapabilitiesState();
    return this.memoryCapabilitiesResponse(capabilities, corsHeaders);
  }

  private memoryCapabilitiesResponse(
    capabilities: MemoryCapabilities,
    corsHeaders: Record<string, string>,
  ): Response {
    return Response.json(
      {
        ready: this.memoryService?.isReady() ?? false,
        ...capabilities,
      },
      { headers: corsHeaders },
    );
  }

  private validateMemoryCapabilitiesSaveRequest(
    input: unknown,
  ): { ok: true; value: MemoryCapabilitiesSaveRequest } | { ok: false; error: string } {
    if (!isRecord(input)) {
      return { ok: false, error: "Memory capabilities payload must be a JSON object" };
    }

    const keys = Object.keys(input);
    if (keys.length !== 1 || !keys.includes("embedding")) {
      return { ok: false, error: "Memory capabilities payload must include only an embedding object" };
    }

    if (!isRecord(input.embedding)) {
      return { ok: false, error: "embedding must be an object" };
    }

    const embeddingKeys = Object.keys(input.embedding);
    if (embeddingKeys.length !== 2 || !embeddingKeys.includes("provider") || !embeddingKeys.includes("model")) {
      return { ok: false, error: "embedding must include only provider and model" };
    }

    const provider = typeof input.embedding.provider === "string" ? input.embedding.provider.trim() : "";
    const model = typeof input.embedding.model === "string" ? input.embedding.model.trim() : "";
    if (!provider) {
      return { ok: false, error: "embedding.provider is required" };
    }
    if (!model) {
      return { ok: false, error: "embedding.model is required" };
    }

    return {
      ok: true,
      value: {
        embedding: {
          provider,
          model,
        },
      },
    };
  }

  /**
   * POST /api/memory — create a new memory record.
   * Accepts content, type, tags, entities, conversationId, messageId.
   */
  private async handleMemoryCreate(
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const body = await this.parseJsonBody(request);
    if (!body.ok) {
      return Response.json(
        { error: body.error },
        { status: 400, headers: corsHeaders },
      );
    }

    const validated = validateCreateMemoryRequest(body.value);
    if (!validated.ok) {
      return Response.json(
        { error: validated.error },
        { status: 400, headers: corsHeaders },
      );
    }

    const dto = validated.value;
    const input: ExplicitMemoryInput = {
      content: dto.content,
      type: dto.type,
      tags: dto.tags,
      entities: dto.entities,
      conversationId: dto.conversationId,
      messageId: dto.messageId,
    };

    const result = await this.memoryService!.rememberExplicit(input);
    if (!result.ok) {
      log("error", "Memory create failed", { error: result.error.message });
      return Response.json(
        { error: result.error.message },
        { status: 400, headers: corsHeaders },
      );
    }

    log("info", "Memory created", { memoryId: result.value.id });
    return Response.json(
      this.memoryRecordToDto(result.value),
      { status: 201, headers: corsHeaders },
    );
  }

  /**
   * GET /api/memory — list memory records with optional query params.
   * Supports: type, layer, limit, offset, sortBy, sortOrder.
   */
  private async handleMemoryList(
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const url = new URL(request.url);
    const params = parseListMemoryQueryParams(url);

    const options: MemoryListOptions = {
      type: params.type,
      layer: params.layer,
      limit: params.limit,
      offset: params.offset,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
    };

    const result = await this.memoryService!.list(options);
    if (!result.ok) {
      log("error", "Memory list failed", { error: result.error.message });
      return Response.json(
        { error: result.error.message },
        { status: 500, headers: corsHeaders },
      );
    }

    return Response.json(
      { memories: result.value.map((r) => this.memoryRecordToDto(r)) },
      { headers: corsHeaders },
    );
  }

  /**
   * GET /api/memory/:id — get a memory record by ID.
   */
  private async handleMemoryGet(
    id: string,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const result = await this.memoryService!.getById(id);
    if (!result.ok) {
      log("error", "Memory get failed", { memoryId: id, error: result.error.message });
      return Response.json(
        { error: result.error.message },
        { status: 500, headers: corsHeaders },
      );
    }

    if (!result.value) {
      return Response.json(
        { error: `Memory not found: ${id}` },
        { status: 404, headers: corsHeaders },
      );
    }

    return Response.json(
      this.memoryRecordToDto(result.value),
      { headers: corsHeaders },
    );
  }

  /**
   * PUT /api/memory/:id — update a memory record.
   * Accepts content, importance, confidence, tags, entities.
   */
  private async handleMemoryUpdate(
    id: string,
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const body = await this.parseJsonBody(request);
    if (!body.ok) {
      return Response.json(
        { error: body.error },
        { status: 400, headers: corsHeaders },
      );
    }

    const validated = validateUpdateMemoryRequest(body.value);
    if (!validated.ok) {
      return Response.json(
        { error: validated.error },
        { status: 400, headers: corsHeaders },
      );
    }

    const dto = validated.value;
    const input: UpdateMemoryInput = {
      content: dto.content,
      importance: dto.importance,
      confidence: dto.confidence,
      tags: dto.tags,
      entities: dto.entities,
    };

    const result = await this.memoryService!.update(id, input);
    if (!result.ok) {
      const isNotFound = result.error.message.toLowerCase().includes("not found");
      const status = isNotFound ? 404 : 400;
      log(isNotFound ? "warn" : "error", "Memory update failed", { memoryId: id, error: result.error.message });
      return Response.json(
        { error: result.error.message },
        { status, headers: corsHeaders },
      );
    }

    log("info", "Memory updated", { memoryId: id });
    return Response.json(
      this.memoryRecordToDto(result.value),
      { headers: corsHeaders },
    );
  }

  /**
   * DELETE /api/memory/:id — delete a memory record.
   */
  private async handleMemoryDelete(
    id: string,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    // Check existence first for proper 404 feedback
    const existing = await this.memoryService!.getById(id);
    if (!existing.ok) {
      log("error", "Memory delete lookup failed", { memoryId: id, error: existing.error.message });
      return Response.json(
        { error: existing.error.message },
        { status: 500, headers: corsHeaders },
      );
    }

    if (!existing.value) {
      return Response.json(
        { error: `Memory not found: ${id}` },
        { status: 404, headers: corsHeaders },
      );
    }

    const result = await this.memoryService!.forget(id);
    if (!result.ok) {
      log("error", "Memory delete failed", { memoryId: id, error: result.error.message });
      return Response.json(
        { error: result.error.message },
        { status: 500, headers: corsHeaders },
      );
    }

    log("info", "Memory deleted", { memoryId: id });
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  /**
   * POST /api/memory/search — search memories by query text and optional filters.
   * Uses list-based filtering. Full hybrid search requires embedding setup (Wave 5).
   */
  private async handleMemorySearch(
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const body = await this.parseJsonBody(request);
    if (!body.ok) {
      return Response.json(
        { error: body.error },
        { status: 400, headers: corsHeaders },
      );
    }

    const validated = validateSearchMemoryRequest(body.value);
    if (!validated.ok) {
      return Response.json(
        { error: validated.error },
        { status: 400, headers: corsHeaders },
      );
    }

    const dto = validated.value;
    const query = dto.query ?? "";

    const listOptions: MemoryListOptions = {
      type: dto.type,
      layer: dto.layer,
      limit: dto.limit ?? 50,
    };

    const result = await this.memoryService!.list(listOptions);
    if (!result.ok) {
      log("error", "Memory search failed", { error: result.error.message });
      return Response.json(
        { error: result.error.message },
        { status: 500, headers: corsHeaders },
      );
    }

    let memories = result.value;

    // Client-side text filtering when a query string is provided
    if (query.length > 0) {
      const lowerQuery = query.toLowerCase();
      memories = memories.filter((record) =>
        record.content.toLowerCase().includes(lowerQuery) ||
        record.tags.some((tag) => tag.toLowerCase().includes(lowerQuery)) ||
        record.entities.some((entity) => entity.toLowerCase().includes(lowerQuery))
      );
    }

    return Response.json(
      {
        query,
        results: memories.map((r) => this.memoryRecordToDto(r)),
        total: memories.length,
      },
      { headers: corsHeaders },
    );
  }

  /**
   * POST /api/memory/consolidate — trigger memory consolidation.
   * Returns 202 Accepted. Actual consolidation job wiring is handled separately.
   */
  private handleMemoryConsolidate(
    corsHeaders: Record<string, string>,
  ): Response {
    log("info", "Memory consolidation triggered");
    return Response.json(
      {
        status: "accepted",
        message: "Consolidation triggered",
        timestamp: new Date().toISOString(),
      },
      { status: 202, headers: corsHeaders },
    );
  }

  /**
   * Serialize a MemoryRecord to a JSON-safe DTO with ISO date strings.
   */
  private memoryRecordToDto(record: MemoryRecord): MemoryRecordDto {
    return {
      id: record.id,
      content: record.content,
      type: record.type,
      layer: record.layer,
      tags: record.tags,
      entities: record.entities,
      importance: record.importance,
      confidence: record.confidence,
      provenance: record.provenance,
      supersedes: record.supersedes,
      supersededBy: record.supersededBy,
      embedding: record.embedding,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      accessedAt: record.accessedAt.toISOString(),
    };
  }

  /**
   * Parse JSON request body, returning a Result-like object.
   */
  private async parseJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    try {
      const text = await request.text();
      if (text.length === 0) {
        return { ok: false, error: "Request body is required" };
      }
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, error: "Invalid JSON in request body" };
    }
  }

  /**
   * Clean up conversation services owned by this server instance.
   */
  private cleanupConversationServices(): void {
    this.streamRegistry.clear();

    if (this.ownedSqliteStore) {
      try {
        this.ownedSqliteStore.close();
      } catch (error) {
        log("warn", "Failed to close SQLite conversation store", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.ownedSqliteStore = null;
    }
    this.conversationManager = null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeOptionalToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createDeviceSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `rcs_${Buffer.from(bytes).toString("hex")}`;
}

function toConvexSiteOrigin(convexUrl: string): string | null {
  try {
    const parsed = new URL(convexUrl);
    const cloudSuffix = ".convex.cloud";
    if (parsed.hostname.endsWith(cloudSuffix)) {
      parsed.hostname = `${parsed.hostname.slice(0, -cloudSuffix.length)}.convex.site`;
    }

    return parsed.origin;
  } catch {
    return null;
  }
}

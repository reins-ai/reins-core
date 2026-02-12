/**
 * Daemon HTTP server exposing provider auth and conversation endpoints.
 * Listens on localhost:7433
 */

import { ConversationManager } from "../conversation/manager";
import { SQLiteConversationStore } from "../conversation/sqlite-store";
import { ProviderAuthService } from "../providers/auth-service";
import { AnthropicApiKeyStrategy } from "../providers/byok/anthropic-auth-strategy";
import { EncryptedCredentialStore, resolveCredentialEncryptionSecret } from "../providers/credentials/store";
import { AnthropicOAuthProvider } from "../providers/oauth/anthropic";
import { OAuthProviderRegistry } from "../providers/oauth/provider";
import { CredentialBackedOAuthTokenStore } from "../providers/oauth/token-store";
import { ProviderRegistry } from "../providers/registry";
import { ModelRouter } from "../providers/router";
import { AuthError, ConversationError, ProviderError } from "../errors";
import { err, ok, type Result } from "../result";
import type { Conversation, Message } from "../types";
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
}

interface ConversationServiceOptions {
  conversationManager?: ConversationManager;
  sqliteStorePath?: string;
}

interface ServerOptions {
  port?: number;
  host?: string;
  authService?: ProviderAuthService;
  modelRouter?: ModelRouter;
  conversation?: ConversationServiceOptions;
}

interface ProviderExecutionContext {
  conversationId: string;
  assistantMessageId: string;
  requestedProvider?: string;
  requestedModel?: string;
}

interface ProviderExecutionFailure extends DaemonConversationServiceError {
  diagnostic: string;
}

interface HealthResponse {
  status: "ok";
  timestamp: string;
  version: string;
  contractVersion: string;
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

const WEBSOCKET_ROUTE = "/ws";

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

  return { authService, modelRouter };
}

/**
 * Daemon HTTP server as a managed service.
 */
export class DaemonHttpServer implements DaemonManagedService {
  readonly id = "http-server";
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly authService: ProviderAuthService;
  private readonly modelRouter: ModelRouter;
  private conversationManager: ConversationManager | null = null;
  private ownedSqliteStore: SQLiteConversationStore | null = null;
  private readonly conversationOptions: ConversationServiceOptions;

  constructor(options: ServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.host = options.host ?? DEFAULT_HOST;
    this.conversationOptions = options.conversation ?? {};

    if (options.authService) {
      this.authService = options.authService;
      this.modelRouter = options.modelRouter ?? new ModelRouter(new ProviderRegistry());
    } else {
      const services = createDefaultServices();
      this.authService = services.authService;
      this.modelRouter = services.modelRouter;
    }
  }

  /**
   * Returns the conversation manager if conversation services are active.
   */
  getConversationManager(): ConversationManager | null {
    return this.conversationManager;
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
      this.initializeConversationServices();
    } catch (error) {
      log("warn", "Conversation services failed to initialize; daemon will start without them", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      this.server = Bun.serve({
        port: this.port,
        hostname: this.host,
        fetch: this.handleRequest.bind(this),
      });

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
      this.server.stop();
      this.server = null;
      this.cleanupConversationServices();
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

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    log("info", `${method} ${url.pathname}`);

    // CORS headers for local development
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // Health check
      if (url.pathname === "/health") {
        const capabilities = ["providers.auth", "providers.models"];
        if (this.conversationManager) {
          capabilities.push("conversations.crud", "messages.send", "stream.subscribe");
        }

        const health: HealthResponse = {
          status: "ok",
          timestamp: new Date().toISOString(),
          version: "0.1.0",
          contractVersion: CONTRACT_VERSION,
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

      // Provider auth endpoints
      if (url.pathname.startsWith("/api/providers/auth/")) {
        return this.handleAuthRequest(url, method, request, corsHeaders);
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
          log("info", "BYOK configured successfully", { providerId });
          return Response.json({ success: true }, { headers: corsHeaders });
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
      log("info", "OAuth code exchange request", { providerId, hasCode: !!code });

      if (!providerId || !code) {
        return Response.json(
          { error: "Missing providerId or code" },
          { status: 400, headers: corsHeaders }
        );
      }

      // The code from Anthropic's callback page may be "code#state"
      const result = await this.authService.completeOAuthCallback(providerId, { code, state: undefined });
      if (result.ok) {
        log("info", "OAuth code exchange completed", { providerId });
        return Response.json({ success: true, provider: providerId }, { headers: corsHeaders });
      }
      log("error", "OAuth code exchange failed", { providerId, error: result.error.message });
      return Response.json({ error: result.error.message }, { status: 400, headers: corsHeaders });
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
      });

      return Response.json(response, { status: 201, headers: corsHeaders });
    } catch (error) {
      return this.mapConversationErrorToResponse(error, corsHeaders);
    }
  }

  private scheduleProviderExecution(context: ProviderExecutionContext): void {
    void Promise.resolve()
      .then(() => this.executeProviderGeneration(context))
      .catch((error) => {
        log("error", "Provider execution scheduler failed", {
          conversationId: context.conversationId,
          assistantMessageId: context.assistantMessageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async executeProviderGeneration(context: ProviderExecutionContext): Promise<void> {
    if (!this.conversationManager) {
      return;
    }

    let resolvedProvider = context.requestedProvider;
    let resolvedModel = context.requestedModel;

    try {
      const conversation = await this.conversationManager.load(context.conversationId);
      const requestedProvider = context.requestedProvider ?? conversation.provider;
      const requestedModel = context.requestedModel ?? conversation.model;

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

      const routeResult = await this.modelRouter.routeWithAuthCheck({
        provider: requestedProvider,
        model: requestedModel,
        capabilities: ["chat", "streaming"],
      });

      if (!routeResult.ok) {
        throw routeResult.error;
      }

      resolvedProvider = routeResult.value.provider.config.id;
      resolvedModel = routeResult.value.model.id;

      const anthropicContext = this.mapConversationToAnthropicContext(
        conversation.messages,
        context.assistantMessageId,
      );

      let assistantContent = "";
      let finishReason: string | undefined;
      let usage:
        | {
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
          }
        | undefined;

      for await (const event of routeResult.value.provider.stream({
        model: routeResult.value.model.id,
        messages: anthropicContext.messages,
        systemPrompt: anthropicContext.systemPrompt,
      })) {
        if (event.type === "token") {
          assistantContent += event.content;
          continue;
        }

        if (event.type === "error") {
          throw event.error;
        }

        if (event.type === "done") {
          finishReason = event.finishReason;
          usage = event.usage;
        }
      }

      await this.conversationManager.completeAssistantMessage({
        conversationId: context.conversationId,
        assistantMessageId: context.assistantMessageId,
        content: assistantContent,
        provider: resolvedProvider,
        model: resolvedModel,
        finishReason,
        usage,
      });

      log("info", "Provider response persisted", {
        conversationId: context.conversationId,
        assistantMessageId: context.assistantMessageId,
        provider: resolvedProvider,
        model: resolvedModel,
        contentLength: assistantContent.length,
      });
    } catch (error) {
      const failure = this.toProviderExecutionFailure(error);
      await this.persistProviderExecutionFailure(context, failure, {
        provider: resolvedProvider,
        model: resolvedModel,
      });
    }
  }

  private mapConversationToAnthropicContext(
    messages: Message[],
    assistantMessageId: string,
  ): { systemPrompt?: string; messages: Message[] } {
    const orderedMessages = [...messages].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    const systemParts: string[] = [];
    const chatMessages: Message[] = [];

    for (const message of orderedMessages) {
      if (message.role === "system") {
        const systemText = message.content.trim();
        if (systemText.length > 0) {
          systemParts.push(systemText);
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

    return {
      systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
      messages: chatMessages,
    };
  }

  private async persistProviderExecutionFailure(
    context: ProviderExecutionContext,
    failure: ProviderExecutionFailure,
    route: { provider?: string; model?: string },
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

    this.emitProviderStreamErrorEvent(context, failure);
  }

  private emitProviderStreamErrorEvent(
    context: Pick<ProviderExecutionContext, "conversationId" | "assistantMessageId">,
    failure: ProviderExecutionFailure,
  ): void {
    const streamErrorEvent = {
      type: "stream-event",
      event: {
        type: "error",
        conversationId: context.conversationId,
        messageId: context.assistantMessageId,
        error: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
        timestamp: new Date().toISOString(),
      },
    };

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
      message: "Provider failed to generate a response.",
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
        content: message.content,
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
    this.conversationManager = new ConversationManager(store);
    log("info", "Conversation services initialized (SQLite store)", {
      path: store.path,
    });
  }

  /**
   * Clean up conversation services owned by this server instance.
   */
  private cleanupConversationServices(): void {
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

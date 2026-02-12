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
import { err, ok, type Result } from "../result";
import type {
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

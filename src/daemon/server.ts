/**
 * Daemon HTTP server exposing provider auth and conversation endpoints.
 * Listens on localhost:7433
 */

import { ProviderAuthService } from "../providers/auth-service";
import { AnthropicApiKeyStrategy } from "../providers/byok/anthropic-auth-strategy";
import { EncryptedCredentialStore } from "../providers/credentials/store";
import { AnthropicOAuthProvider } from "../providers/oauth/anthropic";
import { OAuthProviderRegistry } from "../providers/oauth/provider";
import { CredentialBackedOAuthTokenStore } from "../providers/oauth/token-store";
import { ProviderRegistry } from "../providers/registry";
import { err, ok, type Result } from "../result";
import type { DaemonError, DaemonManagedService } from "./types";

const DEFAULT_PORT = 7433;
const DEFAULT_HOST = "localhost";
const DEFAULT_ENCRYPTION_SECRET = "reins-daemon-default-secret"; // TODO: Use machine-specific secret

// Anthropic OAuth configuration
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_OAUTH_CONFIG = {
  clientId: ANTHROPIC_CLIENT_ID,
  authorizationUrl: "https://console.anthropic.com/oauth/authorize",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  scopes: ["user:inference"],
  redirectUri: "http://localhost:7433/oauth/callback",
};

interface ServerOptions {
  port?: number;
  host?: string;
  authService?: ProviderAuthService;
}

interface HealthResponse {
  status: "ok";
  timestamp: string;
  version: string;
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
 * Build a fully wired ProviderAuthService with Anthropic BYOK and OAuth registered.
 */
function createDefaultAuthService(): ProviderAuthService {
  const store = new EncryptedCredentialStore({
    encryptionSecret: DEFAULT_ENCRYPTION_SECRET,
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

  // Register Anthropic BYOK strategy
  const anthropicByok = new AnthropicApiKeyStrategy({ store });

  return new ProviderAuthService({
    store,
    registry,
    oauthProviderRegistry: oauthRegistry,
    apiKeyStrategies: { anthropic: anthropicByok },
  });
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

  constructor(options: ServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
    this.host = options.host ?? DEFAULT_HOST;
    this.authService = options.authService ?? createDefaultAuthService();
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
      this.server = Bun.serve({
        port: this.port,
        hostname: this.host,
        fetch: this.handleRequest.bind(this),
      });

      log("info", `Daemon HTTP server listening on ${this.host}:${this.port}`);
      return ok(undefined);
    } catch (error) {
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
        const health: HealthResponse = {
          status: "ok",
          timestamp: new Date().toISOString(),
          version: "0.1.0",
        };
        return Response.json(health, { headers: corsHeaders });
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

      if (!providerId || !code || !state) {
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
}

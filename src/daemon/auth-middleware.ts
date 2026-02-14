import type { MachineAuthService } from "../security/machine-auth";

interface AuthFailurePayload {
  error: string;
  code: string;
}

interface AuthEvent {
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface AuthMiddlewareOptions {
  authService: MachineAuthService;
  /** Paths exempt from auth (e.g., ["/health"]) */
  exemptPaths?: string[];
  /** Whether to enable localhost auto-bootstrap (default: true) */
  localhostAutoBootstrap?: boolean;
  /** Optional auth event hook for daemon logging */
  onAuthEvent?: (event: AuthEvent) => void;
}

export interface AuthMiddlewareResult {
  /** Wrap an existing fetch handler with auth enforcement */
  wrapHandler(
    handler: (request: Request, server: any) => Promise<Response>,
  ): (request: Request, server: any) => Promise<Response>;
}

const LOCALHOST_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function createAuthMiddleware(options: AuthMiddlewareOptions): AuthMiddlewareResult {
  const exemptPaths = new Set(options.exemptPaths ?? []);
  const localhostAutoBootstrap = options.localhostAutoBootstrap ?? true;

  return {
    wrapHandler(
      handler: (request: Request, server: any) => Promise<Response>,
    ): (request: Request, server: any) => Promise<Response> {
      return async (request: Request, server: any): Promise<Response> => {
        const url = new URL(request.url);

        if (request.method === "OPTIONS" || exemptPaths.has(url.pathname)) {
          return handler(request, server);
        }

        const token = extractBearerToken(request);
        const isLocalhost = isLocalhostRequest(request, server);

        if (!token) {
          if (isLocalhost && localhostAutoBootstrap) {
            const bootstrapResult = await options.authService.bootstrap();
            if (!bootstrapResult.ok) {
              options.onAuthEvent?.({
                level: "error",
                message: "Failed to bootstrap localhost daemon token",
                data: {
                  path: url.pathname,
                  code: bootstrapResult.error.code,
                  error: bootstrapResult.error.message,
                },
              });
              return createAuthErrorResponse(
                {
                  error: "Authentication bootstrap failed",
                  code: "AUTH_BOOTSTRAP_FAILED",
                },
                500,
              );
            }

            options.onAuthEvent?.({
              level: "info",
              message: "Localhost request auto-bootstrapped daemon token",
              data: { path: url.pathname },
            });

            const response = await handler(request, server);
            return withBootstrapTokenHeader(response, bootstrapResult.value);
          }

          options.onAuthEvent?.({
            level: "warn",
            message: "Rejected unauthenticated remote daemon request",
            data: { path: url.pathname },
          });

          return createAuthErrorResponse(
            {
              error: "Authentication required",
              code: "AUTH_REQUIRED",
            },
            401,
          );
        }

        const validationResult = await options.authService.validate(token);
        if (!validationResult.ok) {
          options.onAuthEvent?.({
            level: "error",
            message: "Daemon token validation failed",
            data: {
              path: url.pathname,
              code: validationResult.error.code,
              error: validationResult.error.message,
            },
          });
          return createAuthErrorResponse(
            {
              error: "Authentication validation failed",
              code: "AUTH_VALIDATION_FAILED",
            },
            500,
          );
        }

        if (!validationResult.value) {
          options.onAuthEvent?.({
            level: "warn",
            message: "Rejected daemon request with invalid token",
            data: { path: url.pathname },
          });
          return createAuthErrorResponse(
            {
              error: "Invalid authentication token",
              code: "AUTH_INVALID",
            },
            401,
          );
        }

        return handler(request, server);
      };
    },
  };
}

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function isLocalhostRequest(request: Request, server: any): boolean {
  const requestIp = resolveRequestIp(request, server);
  if (requestIp && LOCALHOST_IPS.has(requestIp)) {
    return true;
  }

  const hostname = resolveServerHostname(server);
  if (hostname && LOCALHOST_HOSTS.has(hostname)) {
    return true;
  }

  return false;
}

function resolveRequestIp(request: Request, server: any): string | null {
  if (!server || typeof server.requestIP !== "function") {
    return null;
  }

  try {
    const info = server.requestIP(request);
    if (!info || typeof info !== "object") {
      return null;
    }

    const address = (info as { address?: unknown }).address;
    return typeof address === "string" ? normalizeIp(address) : null;
  } catch {
    return null;
  }
}

function resolveServerHostname(server: any): string | null {
  if (!server || typeof server !== "object") {
    return null;
  }

  const hostname = (server as { hostname?: unknown }).hostname;
  if (typeof hostname !== "string") {
    return null;
  }

  return hostname.trim().toLowerCase();
}

function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
}

function createAuthErrorResponse(payload: AuthFailurePayload, status: number): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Expose-Headers": "X-Reins-Token",
    },
  });
}

function withBootstrapTokenHeader(response: Response, token: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Reins-Token", token);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

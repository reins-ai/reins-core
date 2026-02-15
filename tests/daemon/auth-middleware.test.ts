import { describe, expect, it, beforeEach } from "bun:test";

import { ok, err } from "../../src/result";
import { SecurityError } from "../../src/security/security-error";
import {
  createAuthMiddleware,
  type AuthMiddlewareOptions,
  type AuthMiddlewareResult,
} from "../../src/daemon/auth-middleware";
import type { MachineAuthService } from "../../src/security/machine-auth";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory mock of MachineAuthService that stores a single token
 * and validates against it. Supports bootstrap, validate, rotate, and revoke.
 */
function createMockAuthService(token: string = "rm_" + "a".repeat(64)) {
  let storedToken: string | null = token;

  const service = {
    async bootstrap() {
      if (storedToken) return ok(storedToken);
      storedToken = "rm_" + "b".repeat(64);
      return ok(storedToken);
    },
    async validate(t: string) {
      if (!storedToken) return ok(false);
      return ok(t === storedToken);
    },
    async getToken() {
      if (!storedToken) {
        return err(new SecurityError("Not bootstrapped", "MACHINE_AUTH_NOT_BOOTSTRAPPED"));
      }
      return ok(storedToken);
    },
    async rotate() {
      storedToken = "rm_" + crypto.randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64);
      return ok(storedToken);
    },
    async revoke() {
      storedToken = null;
      return ok(undefined);
    },
    async handshake() {
      return ok({ authenticated: true, daemonVersion: "1.0", contractVersion: "1.0", capabilities: [] });
    },
    get currentToken() {
      return storedToken;
    },
  } as unknown as MachineAuthService & { currentToken: string | null };

  return service;
}

/**
 * Creates a mock Bun server object that returns a fixed client IP
 * from requestIP(). Matches the shape Bun.serve() provides.
 */
function createMockServer(clientIp: string = "127.0.0.1") {
  return {
    requestIP(_req: Request) {
      return {
        address: clientIp,
        family: clientIp.includes(":") ? "IPv6" : "IPv4",
        port: 12345,
      };
    },
  };
}

/**
 * Helper to create test requests against the daemon.
 */
function createRequest(
  path: string,
  options: { token?: string; method?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  return new Request(`http://localhost:7433${path}`, {
    method: options.method ?? "GET",
    headers,
  });
}

/**
 * Simple inner handler that returns 200 JSON for all requests.
 * Used as the "protected" handler wrapped by auth middleware.
 */
async function successHandler(_req: Request): Promise<Response> {
  return Response.json({ ok: true });
}

/**
 * Parse the flat error body from an auth failure response.
 * The middleware returns `{ error: string, code: string }`.
 */
async function parseAuthError(response: Response): Promise<{ error: string; code: string }> {
  return response.json() as Promise<{ error: string; code: string }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuthMiddleware", () => {
  let authService: MachineAuthService & { currentToken: string | null };
  let middleware: AuthMiddlewareResult;
  let protectedHandler: (req: Request, server: any) => Promise<Response>;

  beforeEach(() => {
    authService = createMockAuthService();
    middleware = createAuthMiddleware({
      authService,
      exemptPaths: ["/health"],
    });
    protectedHandler = middleware.wrapHandler(successHandler);
  });

  // -------------------------------------------------------------------------
  // Valid token
  // -------------------------------------------------------------------------

  describe("valid token", () => {
    it("allows request with valid rm_ token and returns 200", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations", { token: authService.currentToken! }),
        createMockServer("10.0.0.5"),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true });
    });

    it("extracts token from Authorization: Bearer header", async () => {
      const response = await protectedHandler(
        createRequest("/api/models", { token: authService.currentToken! }),
        createMockServer("192.168.1.100"),
      );

      expect(response.status).toBe(200);
    });

    it("allows localhost request with valid token without auto-bootstrap header", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations", { token: authService.currentToken! }),
        createMockServer("127.0.0.1"),
      );

      expect(response.status).toBe(200);
      // When a valid token is provided, no X-Reins-Token header is set
      expect(response.headers.get("X-Reins-Token")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Invalid token
  // -------------------------------------------------------------------------

  describe("invalid token", () => {
    it("rejects request with wrong token and returns 401", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations", { token: "rm_" + "f".repeat(64) }),
        createMockServer("10.0.0.5"),
      );

      expect(response.status).toBe(401);
    });

    it("rejects request with malformed token (not rm_ prefix) and returns 401", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations", { token: "sk_not_a_valid_token" }),
        createMockServer("10.0.0.5"),
      );

      expect(response.status).toBe(401);
    });

    it("returns JSON error body with code AUTH_INVALID for wrong token", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations", { token: "rm_" + "f".repeat(64) }),
        createMockServer("10.0.0.5"),
      );

      const body = await parseAuthError(response);
      expect(body.code).toBe("AUTH_INVALID");
      expect(body.error).toBeDefined();
      expect(typeof body.error).toBe("string");
    });

    it("returns JSON content-type on auth failure", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations", { token: "rm_" + "f".repeat(64) }),
        createMockServer("10.0.0.5"),
      );

      expect(response.headers.get("content-type")).toContain("application/json");
    });
  });

  // -------------------------------------------------------------------------
  // Missing token on remote
  // -------------------------------------------------------------------------

  describe("missing token on remote", () => {
    it("rejects remote request without Authorization header and returns 401", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations"),
        createMockServer("10.0.0.5"),
      );

      expect(response.status).toBe(401);
    });

    it("returns JSON error body with code AUTH_REQUIRED", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations"),
        createMockServer("10.0.0.5"),
      );

      const body = await parseAuthError(response);
      expect(body.code).toBe("AUTH_REQUIRED");
      expect(body.error).toContain("required");
    });
  });

  // -------------------------------------------------------------------------
  // Localhost auto-bootstrap
  // -------------------------------------------------------------------------

  describe("localhost auto-bootstrap", () => {
    it("allows localhost request without token via auto-bootstrap", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations"),
        createMockServer("127.0.0.1"),
      );

      expect(response.status).toBe(200);
    });

    it("returns X-Reins-Token header with bootstrapped token", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations"),
        createMockServer("127.0.0.1"),
      );

      const tokenHeader = response.headers.get("X-Reins-Token");
      expect(tokenHeader).not.toBeNull();
      expect(tokenHeader!.startsWith("rm_")).toBe(true);
      expect(tokenHeader!.length).toBe(67); // "rm_" + 64 hex chars
    });

    it("works with 127.0.0.1 (IPv4)", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations"),
        createMockServer("127.0.0.1"),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Reins-Token")).not.toBeNull();
    });

    it("works with ::1 (IPv6)", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations"),
        createMockServer("::1"),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Reins-Token")).not.toBeNull();
    });

    it("works with ::ffff:127.0.0.1 (IPv4-mapped IPv6)", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations"),
        createMockServer("::ffff:127.0.0.1"),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Reins-Token")).not.toBeNull();
    });

    it("preserves inner handler response body on auto-bootstrap", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations"),
        createMockServer("127.0.0.1"),
      );

      const body = await response.json();
      expect(body).toEqual({ ok: true });
    });
  });

  // -------------------------------------------------------------------------
  // Exempt paths
  // -------------------------------------------------------------------------

  describe("exempt paths", () => {
    it("/health endpoint bypasses auth entirely", async () => {
      const response = await protectedHandler(
        createRequest("/health"),
        createMockServer("10.0.0.5"),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true });
    });

    it("/health endpoint works without token from remote", async () => {
      const response = await protectedHandler(
        createRequest("/health"),
        createMockServer("203.0.113.50"),
      );

      expect(response.status).toBe(200);
    });

    it("OPTIONS requests bypass auth (CORS preflight)", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations", { method: "OPTIONS" }),
        createMockServer("10.0.0.5"),
      );

      expect(response.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // WebSocket upgrade
  // -------------------------------------------------------------------------

  describe("WebSocket upgrade", () => {
    it("WebSocket upgrade with valid token proceeds", async () => {
      const response = await protectedHandler(
        createRequest("/ws", {
          token: authService.currentToken!,
          headers: { "Upgrade": "websocket" },
        }),
        createMockServer("10.0.0.5"),
      );

      expect(response.status).toBe(200);
    });

    it("WebSocket upgrade without token on remote returns 401", async () => {
      const response = await protectedHandler(
        createRequest("/ws", {
          headers: { "Upgrade": "websocket" },
        }),
        createMockServer("10.0.0.5"),
      );

      expect(response.status).toBe(401);
      const body = await parseAuthError(response);
      expect(body.code).toBe("AUTH_REQUIRED");
    });

    it("WebSocket upgrade on localhost without token auto-bootstraps", async () => {
      const response = await protectedHandler(
        createRequest("/ws", {
          headers: { "Upgrade": "websocket" },
        }),
        createMockServer("127.0.0.1"),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Reins-Token")).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Token rotation
  // -------------------------------------------------------------------------

  describe("token rotation", () => {
    it("old token rejected after rotation", async () => {
      const oldToken = authService.currentToken!;

      // Rotate to a new token
      await authService.rotate();

      const response = await protectedHandler(
        createRequest("/api/conversations", { token: oldToken }),
        createMockServer("10.0.0.5"),
      );

      expect(response.status).toBe(401);
    });

    it("new token accepted after rotation", async () => {
      // Rotate to a new token
      const rotateResult = await authService.rotate();
      expect(rotateResult.ok).toBe(true);

      const newToken = rotateResult.ok ? rotateResult.value : "";

      const response = await protectedHandler(
        createRequest("/api/conversations", { token: newToken }),
        createMockServer("10.0.0.5"),
      );

      expect(response.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Backwards compatibility (no middleware)
  // -------------------------------------------------------------------------

  describe("backwards compatibility", () => {
    it("no middleware configured means requests pass through unmodified", async () => {
      // When no middleware wraps the handler, the inner handler is called directly
      const response = await successHandler(
        createRequest("/api/conversations"),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true });
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("empty Authorization header is treated as missing token", async () => {
      const req = new Request("http://localhost:7433/api/conversations", {
        headers: { "Authorization": "" },
      });

      const response = await protectedHandler(req, createMockServer("10.0.0.5"));
      expect(response.status).toBe(401);
    });

    it("Authorization header without Bearer prefix is treated as missing", async () => {
      const req = new Request("http://localhost:7433/api/conversations", {
        headers: { "Authorization": `Token ${authService.currentToken}` },
      });

      const response = await protectedHandler(req, createMockServer("10.0.0.5"));
      expect(response.status).toBe(401);
    });

    it("non-localhost private IP is treated as remote", async () => {
      const response = await protectedHandler(
        createRequest("/api/conversations"),
        createMockServer("192.168.1.1"),
      );

      expect(response.status).toBe(401);
    });

    it("null requestIP is treated as remote", async () => {
      const nullIpServer = {
        requestIP() {
          return null;
        },
      };

      const response = await protectedHandler(
        createRequest("/api/conversations"),
        nullIpServer,
      );

      expect(response.status).toBe(401);
    });

    it("multiple exempt paths are all honored", async () => {
      const multiExemptMiddleware = createAuthMiddleware({
        authService,
        exemptPaths: ["/health", "/version", "/ready"],
      });
      const multiHandler = multiExemptMiddleware.wrapHandler(successHandler);

      for (const path of ["/health", "/version", "/ready"]) {
        const response = await multiHandler(
          createRequest(path),
          createMockServer("10.0.0.5"),
        );
        expect(response.status).toBe(200);
      }
    });

    it("server without requestIP function falls back to remote", async () => {
      const bareServer = {};

      const response = await protectedHandler(
        createRequest("/api/conversations"),
        bareServer,
      );

      expect(response.status).toBe(401);
    });
  });
});

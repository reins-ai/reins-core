import { AuthError } from "../../errors";
import { createHash } from "node:crypto";
import type { OAuthConfig, OAuthTokens } from "./types";

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface OAuthAuthorizationUrlOptions {
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
  redirectUri?: string;
  extraParams?: Record<string, string>;
}

export interface OAuthExchangeCodeOptions {
  codeVerifier?: string;
  redirectUri?: string;
  state?: string;
}

export interface OAuthRefreshOptions {
  scope?: string;
}

export interface OAuthPkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export interface OAuthCallbackParameters {
  code: string;
  state: string;
}

export interface OAuthLocalCallbackServerOptions {
  host?: string;
  port?: number;
  callbackPath?: string;
  timeoutMs?: number;
}

export interface OAuthLocalCallbackSession {
  redirectUri: string;
  waitForCallback(expectedState?: string): Promise<OAuthCallbackParameters>;
  stop(): void;
}

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toOAuthTokenResponse(value: unknown): OAuthTokenResponse {
  if (!isRecord(value)) {
    throw new AuthError("OAuth token response is not an object");
  }

  const accessToken = value.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new AuthError("OAuth token response missing access_token");
  }

  const refreshToken = value.refresh_token;
  const expiresIn = value.expires_in;
  const scope = value.scope;
  const tokenType = value.token_type;

  if (refreshToken !== undefined && typeof refreshToken !== "string") {
    throw new AuthError("OAuth token response refresh_token must be a string");
  }

  if (expiresIn !== undefined && typeof expiresIn !== "number") {
    throw new AuthError("OAuth token response expires_in must be a number");
  }

  if (scope !== undefined && typeof scope !== "string") {
    throw new AuthError("OAuth token response scope must be a string");
  }

  if (tokenType !== undefined && typeof tokenType !== "string") {
    throw new AuthError("OAuth token response token_type must be a string");
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    scope,
    token_type: tokenType,
  };
}

export class OAuthFlowHandler {
  constructor(private readonly config: OAuthConfig) {}

  private static parseCallbackParametersFromSearchParams(
    params: URLSearchParams,
    expectedState?: string,
  ): OAuthCallbackParameters {
    const error = params.get("error");
    if (error) {
      const description = params.get("error_description") ?? "OAuth authorization failed";
      throw new AuthError(`OAuth callback returned error: ${error}. ${description}`);
    }

    const code = params.get("code")?.trim() ?? "";
    const state = params.get("state")?.trim() ?? "";

    if (!code) {
      throw new AuthError("OAuth callback is missing authorization code");
    }

    if (!state) {
      throw new AuthError("OAuth callback is missing state parameter");
    }

    if (expectedState && state !== expectedState) {
      throw new AuthError("OAuth callback state mismatch. Restart sign-in and try again.");
    }

    return { code, state };
  }

  public generatePkcePair(): OAuthPkcePair {
    const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
    const verifier = base64UrlEncode(verifierBytes);
    const challenge = OAuthFlowHandler.computePkceChallenge(verifier);

    return {
      verifier,
      challenge,
      method: "S256",
    };
  }

  public static computePkceChallenge(verifier: string): string {
    const digest = createHash("sha256").update(verifier).digest();
    return base64UrlEncode(digest);
  }

  public parseCallbackParameters(
    input: string | URL | URLSearchParams,
    expectedState?: string,
  ): OAuthCallbackParameters {
    const params =
      input instanceof URLSearchParams
        ? input
        : input instanceof URL
          ? input.searchParams
          : new URL(input).searchParams;

    return OAuthFlowHandler.parseCallbackParametersFromSearchParams(params, expectedState);
  }

  public startLocalCallbackServer(options: OAuthLocalCallbackServerOptions = {}): OAuthLocalCallbackSession {
    return OAuthFlowHandler.startLocalCallbackServer(options);
  }

  public static startLocalCallbackServer(options: OAuthLocalCallbackServerOptions = {}): OAuthLocalCallbackSession {
    const host = options.host ?? "127.0.0.1";
    const callbackPath = options.callbackPath ?? "/oauth/callback";
    const timeoutMs = options.timeoutMs ?? 2 * 60 * 1000;

    let expectedState: string | undefined;
    let callbackUrl: URL | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveWait: ((value: OAuthCallbackParameters) => void) | null = null;
    let rejectWait: ((reason?: unknown) => void) | null = null;

    const resolveFromUrl = (url: URL): void => {
      if (!resolveWait || settled) {
        return;
      }

      settled = true;
      if (timer) {
        clearTimeout(timer);
      }

      try {
        resolveWait(OAuthFlowHandler.parseCallbackParametersFromSearchParams(url.searchParams, expectedState));
      } catch (error) {
        rejectWait?.(error);
      }
    };

    const server = Bun.serve({
      hostname: host,
      port: options.port ?? 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname !== callbackPath) {
          return new Response("Not Found", { status: 404 });
        }

        callbackUrl = url;
        resolveFromUrl(url);

        return new Response("OAuth callback received. You can return to Reins.", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    });

    return {
      redirectUri: `http://${host}:${server.port}${callbackPath}`,
      waitForCallback: (state?: string) => {
        if (settled) {
          return Promise.reject(new AuthError("OAuth callback session already completed"));
        }

        expectedState = state;

        return new Promise<OAuthCallbackParameters>((resolve, reject) => {
          resolveWait = resolve;
          rejectWait = reject;
          timer = setTimeout(() => {
            if (settled) {
              return;
            }

            settled = true;
            reject(new AuthError("Timed out waiting for OAuth callback. Restart sign-in and try again."));
          }, timeoutMs);

          if (callbackUrl) {
            resolveFromUrl(callbackUrl);
          }
        });
      },
      stop: () => {
        if (timer) {
          clearTimeout(timer);
        }
        if (!settled && rejectWait) {
          rejectWait(new AuthError("OAuth callback server stopped before callback was received"));
        }
        settled = true;
        server.stop(false);
      },
    };
  }

  public getAuthorizationUrl(state: string, options: OAuthAuthorizationUrlOptions = {}): string {
    const url = new URL(this.config.authorizationUrl);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", options.redirectUri ?? this.config.redirectUri);
    url.searchParams.set("scope", this.config.scopes.join(" "));

    if (options.codeChallenge) {
      url.searchParams.set("code_challenge", options.codeChallenge);
      url.searchParams.set("code_challenge_method", options.codeChallengeMethod ?? "S256");
    }

    url.searchParams.set("state", state);

    if (options.extraParams) {
      for (const [key, value] of Object.entries(options.extraParams)) {
        url.searchParams.set(key, value);
      }
    }

    return url.toString();
  }

  public async exchangeCode(code: string, options: OAuthExchangeCodeOptions = {}): Promise<OAuthTokens> {
    // Anthropic's callback page returns "code#state" — split them apart
    const splits = code.split("#");
    const actualCode = splits[0];
    const callbackState = splits[1] ?? options.state;

    const jsonBody: Record<string, string> = {
      grant_type: "authorization_code",
      code: actualCode,
      client_id: this.config.clientId,
      redirect_uri: options.redirectUri ?? this.config.redirectUri,
    };

    if (callbackState) {
      jsonBody.state = callbackState;
    }

    if (this.config.clientSecret) {
      jsonBody.client_secret = this.config.clientSecret;
    }

    if (options.codeVerifier) {
      jsonBody.code_verifier = options.codeVerifier;
    }

    return this.requestTokensJson(jsonBody);
  }

  public async refreshTokens(refreshToken: string, options: OAuthRefreshOptions = {}): Promise<OAuthTokens> {
    const jsonBody: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
    };

    if (this.config.clientSecret) {
      jsonBody.client_secret = this.config.clientSecret;
    }

    if (options.scope) {
      jsonBody.scope = options.scope;
    }

    return this.requestTokensJson(jsonBody, refreshToken);
  }

  public isExpired(tokens: OAuthTokens): boolean {
    const expiresWithBuffer = tokens.expiresAt.getTime() - EXPIRY_BUFFER_MS;
    return Date.now() >= expiresWithBuffer;
  }

  private async requestTokensJson(jsonBody: Record<string, string>, currentRefreshToken?: string): Promise<OAuthTokens> {
    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(jsonBody),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new AuthError(
        `OAuth token request failed (${response.status}): ${message || response.statusText}`,
      );
    }

    const data = toOAuthTokenResponse(await response.json());
    const expiresInMs = (data.expires_in ?? 3600) * 1000;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? currentRefreshToken,
      expiresAt: new Date(Date.now() + expiresInMs),
      scope: data.scope ?? this.config.scopes.join(" "),
      tokenType: data.token_type ?? "Bearer",
    };
  }


}

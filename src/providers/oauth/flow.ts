import { AuthError } from "../../errors";
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
  extraParams?: Record<string, string>;
}

export interface OAuthExchangeCodeOptions {
  codeVerifier?: string;
  redirectUri?: string;
}

export interface OAuthRefreshOptions {
  scope?: string;
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

  public getAuthorizationUrl(state: string, options: OAuthAuthorizationUrlOptions = {}): string {
    const url = new URL(this.config.authorizationUrl);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");

    if (options.codeChallenge) {
      url.searchParams.set("code_challenge", options.codeChallenge);
      url.searchParams.set("code_challenge_method", options.codeChallengeMethod ?? "S256");
    }

    if (options.extraParams) {
      for (const [key, value] of Object.entries(options.extraParams)) {
        url.searchParams.set(key, value);
      }
    }

    return url.toString();
  }

  public async exchangeCode(code: string, options: OAuthExchangeCodeOptions = {}): Promise<OAuthTokens> {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("client_id", this.config.clientId);
    body.set("redirect_uri", options.redirectUri ?? this.config.redirectUri);

    if (this.config.clientSecret) {
      body.set("client_secret", this.config.clientSecret);
    }

    if (options.codeVerifier) {
      body.set("code_verifier", options.codeVerifier);
    }

    return this.requestTokens(body);
  }

  public async refreshTokens(refreshToken: string, options: OAuthRefreshOptions = {}): Promise<OAuthTokens> {
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refreshToken);
    body.set("client_id", this.config.clientId);

    if (this.config.clientSecret) {
      body.set("client_secret", this.config.clientSecret);
    }

    if (options.scope) {
      body.set("scope", options.scope);
    }

    return this.requestTokens(body, refreshToken);
  }

  public isExpired(tokens: OAuthTokens): boolean {
    const expiresWithBuffer = tokens.expiresAt.getTime() - EXPIRY_BUFFER_MS;
    return Date.now() >= expiresWithBuffer;
  }

  private async requestTokens(body: URLSearchParams, currentRefreshToken?: string): Promise<OAuthTokens> {
    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
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

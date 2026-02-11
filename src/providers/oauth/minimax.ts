import { AuthError } from "../../errors";
import { OAuthFlowHandler } from "./flow";
import { OAuthProvider } from "./provider";
import type {
  AuthorizationResult,
  OAuthConfig,
  OAuthExchangeContext,
  OAuthProviderDefinition,
  OAuthRegisterContext,
  OAuthTokens,
  ProviderMetadata,
} from "./types";
import type { OAuthTokenStore } from "./token-store";

const MINIMAX_CLIENT_ID = "78257093-7e40-4613-99e0-527b14b39113";
const MINIMAX_SCOPE = "group_id profile model.completion";
const MINIMAX_USER_CODE_GRANT = "urn:ietf:params:oauth:grant-type:user_code";
const DEFAULT_BASE_URL = "https://api.minimax.io";

interface MiniMaxOAuthProviderOptions {
  oauthConfig: OAuthConfig;
  tokenStore: OAuthTokenStore;
  baseUrl?: string;
}

interface MiniMaxAuthorizationPayload {
  user_code: string;
  verification_uri: string;
  expired_in: number;
  interval?: number;
  state: string;
}

interface MiniMaxTokenPayload {
  status?: string;
  access_token?: string;
  refresh_token?: string;
  expired_in?: number;
  token_type?: string;
  scope?: string;
  base_resp?: {
    status_msg?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createCodeVerifier(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

function resolveExpiresAt(expiresIn: number): Date {
  if (expiresIn > 1_000_000_000_000) {
    return new Date(expiresIn);
  }

  return new Date(Date.now() + expiresIn * 1000);
}

function parseAuthorizationPayload(payload: unknown): MiniMaxAuthorizationPayload {
  if (!isRecord(payload)) {
    throw new AuthError("MiniMax OAuth authorization response is invalid");
  }

  const userCode = payload.user_code;
  const verificationUri = payload.verification_uri;
  const expiredIn = payload.expired_in;
  const state = payload.state;
  const interval = payload.interval;

  if (
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof expiredIn !== "number" ||
    typeof state !== "string" ||
    (interval !== undefined && typeof interval !== "number")
  ) {
    throw new AuthError("MiniMax OAuth authorization response fields are invalid");
  }

  return {
    user_code: userCode,
    verification_uri: verificationUri,
    expired_in: expiredIn,
    interval,
    state,
  };
}

function parseTokenPayload(payload: unknown): MiniMaxTokenPayload {
  if (!isRecord(payload)) {
    throw new AuthError("MiniMax OAuth token response is invalid");
  }

  return payload as MiniMaxTokenPayload;
}

function toFormBody(values: Record<string, string>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    body.set(key, value);
  }
  return body.toString();
}

export class MiniMaxOAuthProvider extends OAuthProvider implements OAuthProviderDefinition {
  protected readonly providerType = "minimax" as const;

  public readonly id = "minimax";

  public readonly authModes = ["oauth", "api_key"] as const;

  public readonly metadata: ProviderMetadata;

  private readonly baseUrl: string;

  constructor(options: MiniMaxOAuthProviderOptions) {
    super(options.oauthConfig, options.tokenStore, new OAuthFlowHandler(options.oauthConfig));

    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.metadata = {
      name: "MiniMax",
      description: "MiniMax provider supporting OAuth device-code and API key credentials",
      authModes: [...this.authModes],
      oauth: {
        authUrl: `${this.baseUrl}/oauth/code`,
        tokenUrl: `${this.baseUrl}/oauth/token`,
        scopes: [MINIMAX_SCOPE],
        pkce: true,
      },
      apiKey: {
        envVar: "MINIMAX_API_KEY",
        baseUrl: this.baseUrl,
      },
      endpoints: [this.baseUrl],
      icon: "minimax",
    };
  }

  public async register(_config: OAuthConfig, context: OAuthRegisterContext = {}): Promise<AuthorizationResult> {
    const codeVerifier = context.codeVerifier ?? createCodeVerifier();
    const codeChallenge = await createCodeChallenge(codeVerifier);
    const state = context.state ?? crypto.randomUUID().replace(/-/g, "");

    const response = await fetch(`${this.baseUrl}/oauth/code`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: toFormBody({
        response_type: "code",
        client_id: MINIMAX_CLIENT_ID,
        scope: MINIMAX_SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new AuthError(`MiniMax OAuth authorization failed (${response.status}): ${message || response.statusText}`);
    }

    const payload = parseAuthorizationPayload(await response.json());
    if (payload.state !== state) {
      throw new AuthError("MiniMax OAuth authorization state mismatch");
    }

    const intervalSeconds = payload.interval !== undefined ? payload.interval : 2;

    return {
      type: "device_code",
      verificationUri: payload.verification_uri,
      userCode: payload.user_code,
      deviceCode: payload.user_code,
      expiresAt: resolveExpiresAt(payload.expired_in),
      intervalSeconds,
      state,
      codeVerifier,
    };
  }

  public async authorize(config: OAuthConfig, context?: OAuthRegisterContext): Promise<AuthorizationResult> {
    return this.register(config, context);
  }

  public async exchange(code: string, _config: OAuthConfig, context?: OAuthExchangeContext): Promise<OAuthTokens> {
    if (!context?.codeVerifier) {
      throw new AuthError("MiniMax OAuth exchange requires a PKCE code verifier");
    }

    const response = await fetch(`${this.baseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: toFormBody({
        grant_type: MINIMAX_USER_CODE_GRANT,
        client_id: MINIMAX_CLIENT_ID,
        user_code: code,
        code_verifier: context.codeVerifier,
      }),
    });

    const payload = parseTokenPayload(await response.json());
    if (!response.ok) {
      const message = payload.base_resp?.status_msg ?? response.statusText;
      throw new AuthError(`MiniMax OAuth token exchange failed (${response.status}): ${message}`);
    }

    if (payload.status !== "success") {
      const message = payload.base_resp?.status_msg ?? "MiniMax OAuth authorization is pending";
      throw new AuthError(message);
    }

    if (
      typeof payload.access_token !== "string" ||
      typeof payload.refresh_token !== "string" ||
      typeof payload.expired_in !== "number"
    ) {
      throw new AuthError("MiniMax OAuth token response is missing required fields");
    }

    const tokens: OAuthTokens = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: resolveExpiresAt(payload.expired_in),
      scope: payload.scope ?? MINIMAX_SCOPE,
      tokenType: payload.token_type ?? "Bearer",
    };

    await this.tokenStore.save(this.providerType, tokens);
    return tokens;
  }

  public async refresh(
    refreshToken: string,
    _config: OAuthConfig,
    _context?: OAuthExchangeContext,
  ): Promise<OAuthTokens> {
    const response = await fetch(`${this.baseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: toFormBody({
        grant_type: "refresh_token",
        client_id: MINIMAX_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    const payload = parseTokenPayload(await response.json());
    if (!response.ok) {
      const message = payload.base_resp?.status_msg ?? response.statusText;
      throw new AuthError(`MiniMax OAuth refresh failed (${response.status}): ${message}`);
    }

    if (
      typeof payload.access_token !== "string" ||
      typeof payload.refresh_token !== "string" ||
      typeof payload.expired_in !== "number"
    ) {
      throw new AuthError("MiniMax OAuth refresh response is missing required fields");
    }

    const tokens: OAuthTokens = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: resolveExpiresAt(payload.expired_in),
      scope: payload.scope ?? MINIMAX_SCOPE,
      tokenType: payload.token_type ?? "Bearer",
    };

    await this.tokenStore.save(this.providerType, tokens);
    return tokens;
  }

  public async revoke(_token: string, _config: OAuthConfig): Promise<void> {
    await this.disconnect();
  }
}

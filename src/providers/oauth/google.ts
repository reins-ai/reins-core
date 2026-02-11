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

const DEFAULT_BASE_URL = "https://cloudcode-pa.googleapis.com";
const DEFAULT_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

interface GoogleOAuthProviderOptions {
  oauthConfig: OAuthConfig;
  tokenStore: OAuthTokenStore;
  baseUrl?: string;
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

export class GoogleOAuthProvider extends OAuthProvider implements OAuthProviderDefinition {
  protected readonly providerType = "google" as const;

  public readonly id = "google";

  public readonly authModes = ["oauth", "api_key"] as const;

  public readonly metadata: ProviderMetadata;

  private readonly baseUrl: string;

  constructor(options: GoogleOAuthProviderOptions) {
    super(options.oauthConfig, options.tokenStore, new OAuthFlowHandler(options.oauthConfig));

    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.metadata = {
      name: "Google",
      description: "Google Antigravity OAuth and API key provider",
      authModes: [...this.authModes],
      oauth: {
        authUrl: options.oauthConfig.authorizationUrl,
        tokenUrl: options.oauthConfig.tokenUrl,
        scopes: [...options.oauthConfig.scopes],
        pkce: true,
        revokeUrl: DEFAULT_REVOKE_URL,
      },
      apiKey: {
        envVar: "GOOGLE_API_KEY",
        baseUrl: this.baseUrl,
      },
      endpoints: [this.baseUrl],
      icon: "google",
    };
  }

  public async register(_config: OAuthConfig, context: OAuthRegisterContext = {}): Promise<AuthorizationResult> {
    const state = context.state ?? crypto.randomUUID().replace(/-/g, "");
    const codeVerifier = context.codeVerifier ?? createCodeVerifier();
    const codeChallenge = await createCodeChallenge(codeVerifier);

    const authorizationUrl = this.flow.getAuthorizationUrl(state, {
      codeChallenge,
      codeChallengeMethod: "S256",
      extraParams: {
        access_type: "offline",
        prompt: "consent",
      },
    });

    return {
      type: "authorization_code",
      authorizationUrl,
      state,
      codeVerifier,
    };
  }

  public async authorize(config: OAuthConfig, context?: OAuthRegisterContext): Promise<AuthorizationResult> {
    return this.register(config, context);
  }

  public async exchange(code: string, _config: OAuthConfig, context?: OAuthExchangeContext): Promise<OAuthTokens> {
    if (!context?.codeVerifier) {
      throw new AuthError("Google OAuth exchange requires a PKCE code verifier");
    }

    const tokens = await this.flow.exchangeCode(code, {
      codeVerifier: context.codeVerifier,
      redirectUri: context.redirectUri,
    });
    await this.tokenStore.save(this.providerType, tokens);
    return tokens;
  }

  public async refresh(
    refreshToken: string,
    _config: OAuthConfig,
    _context?: OAuthExchangeContext,
  ): Promise<OAuthTokens> {
    const tokens = await this.flow.refreshTokens(refreshToken);
    await this.tokenStore.save(this.providerType, tokens);
    return tokens;
  }

  public async revoke(token: string, _config: OAuthConfig): Promise<void> {
    const revokeUrl = this.metadata.oauth?.revokeUrl;
    if (!revokeUrl) {
      await this.disconnect();
      return;
    }

    const body = new URLSearchParams({ token });
    const response = await fetch(revokeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new AuthError(`Google OAuth revoke failed (${response.status}): ${message || response.statusText}`);
    }

    await this.disconnect();
  }
}

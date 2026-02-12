import { AuthError } from "../../errors";
import { err, ok, type Result } from "../../result";
import { OAuthFlowHandler } from "./flow";
import type {
  AuthorizationResult,
  AuthStrategyContext,
  OAuthConfig,
  OAuthCallbackContext,
  OAuthInitiateContext,
  OAuthConnectionStatus,
  OAuthProviderDefinition,
  OAuthRefreshContext,
  OAuthStrategy,
  OAuthTokens,
  OAuthProviderType,
} from "./types";
import type { OAuthTokenStore } from "./token-store";

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(String(value));
}

export abstract class OAuthProvider {
  protected abstract readonly providerType: OAuthProviderType;

  constructor(
    protected readonly oauthConfig: OAuthConfig,
    protected readonly tokenStore: OAuthTokenStore,
    protected readonly flow: OAuthFlowHandler,
  ) {}

  public async initiateFlow(context: OAuthInitiateContext): Promise<Result<AuthorizationResult, AuthError>> {
    if (context.provider !== this.providerType) {
      return err(new AuthError(`OAuth strategy for ${this.providerType} cannot initiate flow for ${context.provider}`));
    }

    const state = context.register?.state ?? crypto.randomUUID().replace(/-/g, "");
    const authorizationUrl = this.flow.getAuthorizationUrl(state, {
      codeChallenge: context.register?.codeVerifier,
    });

    return ok({
      type: "authorization_code",
      authorizationUrl,
      state,
      codeVerifier: context.register?.codeVerifier,
    });
  }

  public async handleCallbackFlow(context: OAuthCallbackContext): Promise<Result<OAuthTokens, AuthError>> {
    if (context.provider !== this.providerType) {
      return err(new AuthError(`OAuth strategy for ${this.providerType} cannot handle callback for ${context.provider}`));
    }

    const code = context.code.trim();
    if (code.length === 0) {
      return err(new AuthError(`OAuth callback code is required for provider ${context.provider}`));
    }

    try {
      const tokens = await this.flow.exchangeCode(code, {
        codeVerifier: context.exchange?.codeVerifier,
        redirectUri: context.exchange?.redirectUri,
      });
      await this.tokenStore.save(this.providerType, tokens);
      return ok(tokens);
    } catch (error) {
      return err(
        new AuthError(
          `OAuth callback failed for provider ${context.provider} against ${this.oauthConfig.tokenUrl}. Complete sign-in again and retry token exchange.`,
          toError(error),
        ),
      );
    }
  }

  public async refreshTokensWithResult(context: OAuthRefreshContext): Promise<Result<OAuthTokens, AuthError>> {
    if (context.provider !== this.providerType) {
      return err(new AuthError(`OAuth strategy for ${this.providerType} cannot refresh tokens for ${context.provider}`));
    }

    const refreshToken = context.refreshToken.trim();
    if (refreshToken.length === 0) {
      return err(new AuthError(`Refresh token is required for provider ${context.provider}`));
    }

    try {
      const tokens = await this.flow.refreshTokens(refreshToken);
      await this.tokenStore.save(this.providerType, tokens);
      return ok(tokens);
    } catch (error) {
      return err(
        new AuthError(
          `OAuth refresh failed for provider ${context.provider} against ${this.oauthConfig.tokenUrl}. Re-authenticate to continue using this provider.`,
          toError(error),
        ),
      );
    }
  }

  public async storeTokensWithResult(context: { provider: string; tokens: OAuthTokens }): Promise<Result<void, AuthError>> {
    if (context.provider !== this.providerType) {
      return err(new AuthError(`OAuth strategy for ${this.providerType} cannot store tokens for ${context.provider}`));
    }

    try {
      await this.tokenStore.save(this.providerType, context.tokens);
      return ok(undefined);
    } catch (error) {
      return err(new AuthError(`Unable to store OAuth tokens for provider ${context.provider}`, toError(error)));
    }
  }

  public async retrieveTokensWithResult(context: AuthStrategyContext): Promise<Result<OAuthTokens | null, AuthError>> {
    if (context.provider !== this.providerType) {
      return err(new AuthError(`OAuth strategy for ${this.providerType} cannot load tokens for ${context.provider}`));
    }

    try {
      const tokens = await this.tokenStore.load(this.providerType);
      return ok(tokens);
    } catch (error) {
      return err(new AuthError(`Unable to retrieve OAuth tokens for provider ${context.provider}`, toError(error)));
    }
  }

  public async revokeTokensWithResult(context: AuthStrategyContext): Promise<Result<void, AuthError>> {
    if (context.provider !== this.providerType) {
      return err(new AuthError(`OAuth strategy for ${this.providerType} cannot revoke tokens for ${context.provider}`));
    }

    try {
      await this.tokenStore.delete(this.providerType);
      return ok(undefined);
    } catch (error) {
      return err(new AuthError(`Unable to revoke OAuth tokens for provider ${context.provider}`, toError(error)));
    }
  }

  public async getAccessToken(): Promise<string> {
    const tokenResult = await this.retrieveTokensWithResult({ provider: this.providerType });
    if (!tokenResult.ok) {
      throw tokenResult.error;
    }

    const tokens = tokenResult.value;
    if (!tokens) {
      throw new AuthError(`No OAuth tokens found for provider ${this.providerType}. Re-authenticate this provider.`);
    }

    if (!this.flow.isExpired(tokens)) {
      return tokens.accessToken;
    }

    if (!tokens.refreshToken) {
      throw new AuthError(
        `OAuth tokens expired and no refresh token is available for ${this.providerType}. Re-authenticate this provider.`,
      );
    }

    const refreshResult = await this.refreshTokensWithResult({
      provider: this.providerType,
      refreshToken: tokens.refreshToken,
    });
    if (!refreshResult.ok) {
      throw refreshResult.error;
    }

    return refreshResult.value.accessToken;
  }

  public async getConnectionStatus(): Promise<OAuthConnectionStatus> {
    return this.tokenStore.getStatus(this.providerType);
  }

  public async disconnect(): Promise<void> {
    await this.tokenStore.delete(this.providerType);
  }
}

export class OAuthProviderRegistry {
  private readonly providers = new Map<string, OAuthProviderDefinition>();

  public register(provider: OAuthProviderDefinition): void {
    if (this.providers.has(provider.id)) {
      throw new AuthError(`OAuth provider already registered: ${provider.id}`);
    }

    this.providers.set(provider.id, provider);
  }

  public registerMany(providers: OAuthProviderDefinition[]): void {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  public get(id: string): OAuthProviderDefinition | undefined {
    return this.providers.get(id);
  }

  public getOrThrow(id: string): OAuthProviderDefinition {
    const provider = this.get(id);
    if (!provider) {
      throw new AuthError(`OAuth provider not found: ${id}`);
    }

    return provider;
  }

  public resolveStrategy(id: string): Result<OAuthStrategy, AuthError> {
    const provider = this.get(id);
    if (!provider) {
      return err(new AuthError(`OAuth provider not found: ${id}`));
    }

    if (provider.strategy) {
      return ok(provider.strategy);
    }

    if (provider instanceof OAuthProvider) {
      return ok({
        mode: "oauth",
        initiate: (context) => provider.initiateFlow(context),
        handleCallback: (context) => provider.handleCallbackFlow(context),
        refresh: (context) => provider.refreshTokensWithResult(context),
        storeTokens: (context) => provider.storeTokensWithResult(context),
        retrieveTokens: (context) => provider.retrieveTokensWithResult(context),
        revoke: (context) => provider.revokeTokensWithResult(context),
      });
    }

    const strategyCandidate = provider as OAuthProviderDefinition & Partial<OAuthStrategy>;
    if (
      typeof strategyCandidate.initiate === "function" &&
      typeof strategyCandidate.handleCallback === "function" &&
      typeof strategyCandidate.refresh === "function" &&
      typeof strategyCandidate.storeTokens === "function" &&
      typeof strategyCandidate.retrieveTokens === "function" &&
      typeof strategyCandidate.revoke === "function"
    ) {
      return ok(strategyCandidate as OAuthStrategy);
    }

    return err(new AuthError(`OAuth provider ${id} does not expose a compatible OAuth strategy`));
  }

  public list(): OAuthProviderDefinition[] {
    return Array.from(this.providers.values());
  }

  public has(id: string): boolean {
    return this.providers.has(id);
  }

  public remove(id: string): boolean {
    return this.providers.delete(id);
  }

  public clear(): void {
    this.providers.clear();
  }
}

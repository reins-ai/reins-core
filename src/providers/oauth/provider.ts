import { AuthError } from "../../errors";
import { OAuthFlowHandler } from "./flow";
import type {
  OAuthConfig,
  OAuthConnectionStatus,
  OAuthProviderDefinition,
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

  public async getAccessToken(): Promise<string> {
    const tokens = await this.tokenStore.load(this.providerType);
    if (!tokens) {
      throw new AuthError(`No OAuth tokens found for provider ${this.providerType}`);
    }

    if (!this.flow.isExpired(tokens)) {
      return tokens.accessToken;
    }

    if (!tokens.refreshToken) {
      throw new AuthError(`OAuth tokens expired and refresh token is unavailable for ${this.providerType}`);
    }

    try {
      const refreshed = await this.flow.refreshTokens(tokens.refreshToken);
      await this.tokenStore.save(this.providerType, refreshed);
      return refreshed.accessToken;
    } catch (error) {
      throw new AuthError(
        `Failed to refresh OAuth token for ${this.providerType} via ${this.oauthConfig.tokenUrl}`,
        toError(error),
      );
    }
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

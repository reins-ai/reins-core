import { AuthError } from "../errors";
import { err, ok, type Result } from "../result";
import type { ProviderAuthMode as AuthMode, ProviderConfig, ProviderType } from "../types/provider";
import type { CredentialRecord, CredentialType, EncryptedCredentialStore } from "./credentials";
import type { OAuthTokens } from "./oauth";
import type { ProviderRegistry } from "./registry";

const REINS_GATEWAY_PROVIDER_ID = "reins-gateway";

interface SerializedOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scope: string;
  tokenType: string;
}

type SupportedCredentialType = Extract<CredentialType, "api_key" | "oauth">;

export interface ProviderAuthStatus {
  provider: string;
  requiresAuth: boolean;
  authModes: AuthMode[];
  configured: boolean;
  credentialType?: SupportedCredentialType;
  updatedAt?: number;
  envVars?: string[];
  baseUrl?: string;
}

export interface AuthService {
  setApiKey(provider: string, key: string, metadata?: Record<string, string>): Promise<Result<void, AuthError>>;
  setOAuthTokens(provider: string, tokens: OAuthTokens): Promise<Result<void, AuthError>>;
  getCredential(provider: string): Promise<Result<CredentialRecord | null, AuthError>>;
  listProviders(): Promise<Result<ProviderAuthStatus[], AuthError>>;
  revokeProvider(provider: string): Promise<Result<void, AuthError>>;
  requiresAuth(provider: string): boolean;
  getAuthMethods(provider: string): AuthMode[];
}

export type ProviderAuthSurface = "cli" | "tui" | "desktop";

interface ProviderAuthCommandBase {
  provider: string;
  source: ProviderAuthSurface;
}

export interface ConfigureApiKeyAuthPayload extends ProviderAuthCommandBase {
  mode: "api_key";
  key: string;
  metadata?: Record<string, string>;
}

export interface ConfigureOAuthAuthPayload extends ProviderAuthCommandBase {
  mode: "oauth";
  tokens: OAuthTokens;
}

export interface GetProviderAuthPayload extends ProviderAuthCommandBase {
  action: "get";
}

export interface ListProviderAuthPayload {
  action: "list";
  source: ProviderAuthSurface;
}

export interface RevokeProviderAuthPayload extends ProviderAuthCommandBase {
  action: "revoke";
}

export type ProviderAuthConfigurePayload = ConfigureApiKeyAuthPayload | ConfigureOAuthAuthPayload;

export type ProviderAuthCommandPayload =
  | ProviderAuthConfigurePayload
  | GetProviderAuthPayload
  | ListProviderAuthPayload
  | RevokeProviderAuthPayload;

function normalizeProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }

  const entries = Object.entries(metadata)
    .filter(([key, value]) => key.trim().length > 0 && value.trim().length > 0)
    .map(([key, value]) => [key.trim(), value.trim()] as const);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeProviderType(type: ProviderConfig["type"]): ProviderType {
  return type;
}

function authModesFromProviderType(type: ProviderType): AuthMode[] {
  switch (type) {
    case "oauth":
      return ["oauth"];
    case "gateway":
    case "byok":
      return ["api_key"];
    case "local":
      return [];
    default:
      return ["api_key"];
  }
}

function credentialTypeToAuthMode(type: SupportedCredentialType): AuthMode {
  return type === "oauth" ? "oauth" : "api_key";
}

function toSupportedCredentialType(type: CredentialType): SupportedCredentialType | undefined {
  if (type === "api_key" || type === "oauth") {
    return type;
  }

  return undefined;
}

function pickPreferredCredential(records: CredentialRecord[]): CredentialRecord | null {
  if (records.length === 0) {
    return null;
  }

  const sorted = [...records].sort((left, right) => right.updatedAt - left.updatedAt);
  return sorted[0] ?? null;
}

function toSerializedOAuthTokens(tokens: OAuthTokens): SerializedOAuthTokens {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt.toISOString(),
    scope: tokens.scope,
    tokenType: tokens.tokenType,
  };
}

function validateProviderId(provider: string): Result<string, AuthError> {
  const normalized = normalizeProviderId(provider);
  if (normalized.length === 0) {
    return err(new AuthError("Provider is required"));
  }

  return ok(normalized);
}

function validateApiKey(provider: string, key: string): Result<string, AuthError> {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    return err(new AuthError(`API key is required for provider ${provider}`));
  }

  if (provider === REINS_GATEWAY_PROVIDER_ID && !/^rk_(live|test)_[a-zA-Z0-9]+$/.test(trimmed)) {
    return err(new AuthError("Reins Gateway key must use rk_live_* or rk_test_* format"));
  }

  return ok(trimmed);
}

export interface ProviderAuthServiceOptions {
  store: EncryptedCredentialStore;
  registry: ProviderRegistry;
}

export class ProviderAuthService implements AuthService {
  private readonly store: EncryptedCredentialStore;
  private readonly registry: ProviderRegistry;

  constructor(options: ProviderAuthServiceOptions) {
    this.store = options.store;
    this.registry = options.registry;
  }

  public async setApiKey(
    provider: string,
    key: string,
    metadata?: Record<string, string>,
  ): Promise<Result<void, AuthError>> {
    const providerResult = validateProviderId(provider);
    if (!providerResult.ok) {
      return providerResult;
    }

    const normalizedProvider = providerResult.value;
    const keyResult = validateApiKey(normalizedProvider, key);
    if (!keyResult.ok) {
      return keyResult;
    }

    if (!this.getAuthMethods(normalizedProvider).includes("api_key")) {
      return err(new AuthError(`Provider ${normalizedProvider} does not support api_key authentication`));
    }

    const result = await this.store.set({
      id: `auth_${normalizedProvider}_api_key`,
      provider: normalizedProvider,
      type: "api_key",
      accountId: "default",
      metadata: normalizeMetadata(metadata),
      payload: {
        key: keyResult.value,
      },
    });

    if (!result.ok) {
      return err(new AuthError(`Unable to set API key for provider ${normalizedProvider}`, result.error));
    }

    return ok(undefined);
  }

  public async setOAuthTokens(provider: string, tokens: OAuthTokens): Promise<Result<void, AuthError>> {
    const providerResult = validateProviderId(provider);
    if (!providerResult.ok) {
      return providerResult;
    }

    const normalizedProvider = providerResult.value;
    if (!this.getAuthMethods(normalizedProvider).includes("oauth")) {
      return err(new AuthError(`Provider ${normalizedProvider} does not support oauth authentication`));
    }

    const result = await this.store.set({
      id: `auth_${normalizedProvider}_oauth`,
      provider: normalizedProvider,
      type: "oauth",
      accountId: "default",
      payload: toSerializedOAuthTokens(tokens),
    });

    if (!result.ok) {
      return err(new AuthError(`Unable to set OAuth tokens for provider ${normalizedProvider}`, result.error));
    }

    return ok(undefined);
  }

  public async getCredential(provider: string): Promise<Result<CredentialRecord | null, AuthError>> {
    const providerResult = validateProviderId(provider);
    if (!providerResult.ok) {
      return providerResult;
    }

    const normalizedProvider = providerResult.value;
    const listResult = await this.store.list({
      provider: normalizedProvider,
      includeRevoked: false,
    });

    if (!listResult.ok) {
      return err(new AuthError(`Unable to get credential for provider ${normalizedProvider}`, listResult.error));
    }

    return ok(pickPreferredCredential(listResult.value));
  }

  public async listProviders(): Promise<Result<ProviderAuthStatus[], AuthError>> {
    const credentialsResult = await this.store.list({ includeRevoked: false });
    if (!credentialsResult.ok) {
      return err(new AuthError("Unable to list provider credentials", credentialsResult.error));
    }

    const latestCredentialByProvider = new Map<string, CredentialRecord>();
    for (const record of credentialsResult.value) {
      const existing = latestCredentialByProvider.get(record.provider);
      if (!existing || existing.updatedAt < record.updatedAt) {
        latestCredentialByProvider.set(record.provider, record);
      }
    }

    const knownProviderIds = new Set<string>(this.registry.listCapabilities().map((entry) => entry.providerId));
    for (const providerId of latestCredentialByProvider.keys()) {
      knownProviderIds.add(providerId);
    }

    const statuses: ProviderAuthStatus[] = Array.from(knownProviderIds)
      .sort((left, right) => left.localeCompare(right))
      .map((providerId) => {
        const capabilities = this.registry.getCapabilities(providerId);
        const provider = this.registry.get(providerId);
        const credential = latestCredentialByProvider.get(providerId);
        const credentialType = credential ? toSupportedCredentialType(credential.type) : undefined;

        const fallbackAuthModes = credentialType
          ? [credentialTypeToAuthMode(credentialType)]
          : provider
            ? authModesFromProviderType(normalizeProviderType(provider.config.type))
            : [];
        const authModes = capabilities?.authModes ?? fallbackAuthModes;
        const requiresAuth = capabilities?.requiresAuth ?? authModes.length > 0;

        return {
          provider: providerId,
          requiresAuth,
          authModes,
          configured: requiresAuth ? credential !== undefined : true,
          credentialType,
          updatedAt: credential?.updatedAt,
          envVars: capabilities?.envVars,
          baseUrl: capabilities?.baseUrl ?? provider?.config.baseUrl,
        };
      });

    return ok(statuses);
  }

  public async revokeProvider(provider: string): Promise<Result<void, AuthError>> {
    const providerResult = validateProviderId(provider);
    if (!providerResult.ok) {
      return providerResult;
    }

    const normalizedProvider = providerResult.value;
    const recordsResult = await this.store.list({
      provider: normalizedProvider,
      includeRevoked: false,
    });

    if (!recordsResult.ok) {
      return err(new AuthError(`Unable to list credentials for provider ${normalizedProvider}`, recordsResult.error));
    }

    for (const record of recordsResult.value) {
      const revokeResult = await this.store.revoke(record.id);
      if (!revokeResult.ok) {
        return err(new AuthError(`Unable to revoke credentials for provider ${normalizedProvider}`, revokeResult.error));
      }
    }

    return ok(undefined);
  }

  public requiresAuth(provider: string): boolean {
    const normalizedProvider = normalizeProviderId(provider);
    const capabilities = this.registry.getCapabilities(normalizedProvider);
    if (capabilities) {
      return capabilities.requiresAuth;
    }

    const registered = this.registry.get(normalizedProvider);
    if (!registered) {
      return true;
    }

    return normalizeProviderType(registered.config.type) !== "local";
  }

  public getAuthMethods(provider: string): AuthMode[] {
    const normalizedProvider = normalizeProviderId(provider);
    const capabilities = this.registry.getCapabilities(normalizedProvider);
    if (capabilities) {
      return [...capabilities.authModes];
    }

    const registered = this.registry.get(normalizedProvider);
    if (!registered) {
      return [];
    }

    return authModesFromProviderType(normalizeProviderType(registered.config.type));
  }
}

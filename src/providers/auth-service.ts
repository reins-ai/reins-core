import { AuthError } from "../errors";
import { err, ok, type Result } from "../result";
import type { ProviderAuthMode as AuthMode, ProviderConfig, ProviderType } from "../types/provider";
import type { CredentialRecord, CredentialType, EncryptedCredentialStore } from "./credentials";
import { OAuthProviderRegistry } from "./oauth/provider";
import type { OAuthTokens } from "./oauth";
import type {
  ApiKeyAuthStrategy,
  ApiKeyCredentialInput,
  AuthStrategyContext,
  AuthorizationResult,
  OAuthCallbackContext,
  OAuthInitiateContext,
  OAuthRefreshContext,
  OAuthStrategy,
  OAuthStoreContext,
} from "./oauth/types";
import type { OAuthLocalCallbackServerOptions, OAuthLocalCallbackSession } from "./oauth/flow";
import { OAuthFlowHandler } from "./oauth/flow";

import type { ProviderRegistry } from "./registry";

const REINS_GATEWAY_PROVIDER_ID = "reins-gateway";
const OAUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface SerializedOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scope: string;
  tokenType: string;
}

function toSerializedOAuthTokensPayload(value: unknown): SerializedOAuthTokens | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const accessToken = payload.accessToken;
  const refreshToken = payload.refreshToken;
  const expiresAt = payload.expiresAt;
  const scope = payload.scope;
  const tokenType = payload.tokenType;

  if (
    typeof accessToken !== "string" ||
    (refreshToken !== undefined && typeof refreshToken !== "string") ||
    typeof expiresAt !== "string" ||
    typeof scope !== "string" ||
    typeof tokenType !== "string"
  ) {
    return null;
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scope,
    tokenType,
  };
}

function toOAuthTokens(value: SerializedOAuthTokens): OAuthTokens {
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: new Date(value.expiresAt),
    scope: value.scope,
    tokenType: value.tokenType,
  };
}

type SupportedCredentialType = Extract<CredentialType, "api_key" | "oauth">;

export type ProviderConnectionState = "ready" | "requires_auth" | "requires_reauth" | "invalid";

export interface ProviderAuthStatus {
  provider: string;
  requiresAuth: boolean;
  authModes: AuthMode[];
  configured: boolean;
  connectionState: ProviderConnectionState;
  credentialType?: SupportedCredentialType;
  updatedAt?: number;
  expiresAt?: number;
  envVars?: string[];
  baseUrl?: string;
}

export interface ConversationAuthCheck {
  allowed: boolean;
  provider: string;
  connectionState: ProviderConnectionState;
  guidance?: ProviderAuthGuidance;
}

export interface AuthService {
  setApiKey(provider: string, key: string, metadata?: Record<string, string>): Promise<Result<void, AuthError>>;
  setOAuthTokens(provider: string, tokens: OAuthTokens): Promise<Result<void, AuthError>>;
  initiateOAuth(provider: string, context?: OAuthInitiationRuntimeContext): Promise<Result<AuthorizationResult, AuthError>>;
  completeOAuthCallback(provider: string, context?: OAuthCompletionRuntimeContext): Promise<Result<OAuthTokens, AuthError>>;
  getOAuthAccessToken(provider: string): Promise<Result<string, AuthError>>;
  getCredential(provider: string): Promise<Result<CredentialRecord | null, AuthError>>;
  getProviderAuthStatus(provider: string): Promise<Result<ProviderAuthStatus, AuthError>>;
  checkConversationReady(provider: string): Promise<Result<ConversationAuthCheck, AuthError>>;
  listProviders(): Promise<Result<ProviderAuthStatus[], AuthError>>;
  revokeProvider(provider: string): Promise<Result<void, AuthError>>;
  requiresAuth(provider: string): boolean;
  getAuthMethods(provider: string): AuthMode[];
  handleCommand(payload: ProviderAuthCommandPayload): Promise<Result<ProviderAuthCommandResult, AuthError>>;
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

export interface InitiateOAuthAuthPayload extends ProviderAuthCommandBase {
  action: "oauth_initiate";
  state?: string;
  codeVerifier?: string;
  redirectUri?: string;
}

export interface CompleteOAuthAuthPayload extends ProviderAuthCommandBase {
  action: "oauth_callback";
  code: string;
  state?: string;
  codeVerifier?: string;
  redirectUri?: string;
}

export type ProviderAuthConfigurePayload = ConfigureApiKeyAuthPayload | ConfigureOAuthAuthPayload;

export type ProviderAuthCommandPayload =
  | ProviderAuthConfigurePayload
  | GetProviderAuthPayload
  | ListProviderAuthPayload
  | RevokeProviderAuthPayload
  | InitiateOAuthAuthPayload
  | CompleteOAuthAuthPayload;

export interface ProviderAuthGuidance {
  provider: string;
  action: "reauth" | "configure" | "retry";
  message: string;
  supportedModes: AuthMode[];
}

export interface ProviderAuthCommandResult {
  action: "configure" | "get" | "list" | "revoke" | "oauth_initiate" | "oauth_callback";
  provider?: string;
  source: ProviderAuthSurface;
  credential?: CredentialRecord | null;
  providers?: ProviderAuthStatus[];
  guidance?: ProviderAuthGuidance;
  authorization?: AuthorizationResult;
  tokens?: OAuthTokens;
}

export interface OAuthInitiationRuntimeContext extends Omit<OAuthInitiateContext, "provider"> {
  localCallback?: OAuthLocalCallbackServerOptions | false;
}

export interface OAuthCompletionRuntimeContext extends Omit<OAuthCallbackContext, "provider" | "code"> {
  code?: string;
}

interface PendingOAuthCallbackSession {
  session: OAuthLocalCallbackSession;
  expectedState?: string;
}

interface EndpointValidatable {
  validateWithEndpoint(key: string): Promise<Result<void, AuthError>>;
}

function hasEndpointValidation(strategy: ApiKeyAuthStrategy): strategy is ApiKeyAuthStrategy & EndpointValidatable {
  return typeof (strategy as unknown as EndpointValidatable).validateWithEndpoint === "function";
}

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

function isOAuthTokenExpired(tokens: OAuthTokens): boolean {
  return Date.now() >= tokens.expiresAt.getTime() - OAUTH_REFRESH_BUFFER_MS;
}

export interface ProviderAuthServiceOptions {
  store: EncryptedCredentialStore;
  registry: ProviderRegistry;
  oauthProviderRegistry?: OAuthProviderRegistry;
  apiKeyStrategies?: Record<string, ApiKeyAuthStrategy>;
  oauthStrategies?: Record<string, OAuthStrategy>;
}

class CredentialStoreApiKeyStrategy implements ApiKeyAuthStrategy {
  public readonly mode = "api_key" as const;

  constructor(
    private readonly credentialStore: EncryptedCredentialStore,
    private readonly keyValidator: (provider: string, key: string) => Result<string, AuthError>,
  ) {}

  public validate(input: ApiKeyCredentialInput): Result<string, AuthError> {
    return this.keyValidator(input.provider, input.key);
  }

  public async store(input: ApiKeyCredentialInput): Promise<Result<void, AuthError>> {
    const result = await this.credentialStore.set({
      id: `auth_${input.provider}_api_key`,
      provider: input.provider,
      type: "api_key",
      accountId: "default",
      metadata: normalizeMetadata(input.metadata),
      payload: {
        key: input.key,
      },
    });

    if (!result.ok) {
      return err(new AuthError(`Unable to set API key for provider ${input.provider}`, result.error));
    }

    return ok(undefined);
  }

  public async retrieve(context: AuthStrategyContext): Promise<Result<{ key: string; metadata?: Record<string, string>; updatedAt: number; } | null, AuthError>> {
    const result = await this.credentialStore.get({
      id: `auth_${context.provider}_api_key`,
      provider: context.provider,
      type: "api_key",
      accountId: "default",
    });
    if (!result.ok) {
      return err(new AuthError(`Unable to load API key credential for provider ${context.provider}`, result.error));
    }

    if (!result.value) {
      return ok(null);
    }

    const payloadResult = await this.credentialStore.decryptPayload<unknown>(result.value);
    if (!payloadResult.ok) {
      return err(new AuthError(`Unable to read API key credential for provider ${context.provider}`, payloadResult.error));
    }

    const payload = payloadResult.value;
    if (typeof payload !== "object" || payload === null || typeof (payload as Record<string, unknown>).key !== "string") {
      return err(new AuthError(`Stored API key credential is invalid for provider ${context.provider}`));
    }

    return ok({
      key: (payload as Record<string, string>).key,
      metadata: result.value.metadata,
      updatedAt: result.value.updatedAt,
    });
  }

  public async revoke(context: AuthStrategyContext): Promise<Result<void, AuthError>> {
    const result = await this.credentialStore.revoke(`auth_${context.provider}_api_key`);
    if (!result.ok) {
      return err(new AuthError(`Unable to revoke API key for provider ${context.provider}`, result.error));
    }

    return ok(undefined);
  }
}

class CredentialStoreOAuthStrategy implements OAuthStrategy {
  public readonly mode = "oauth" as const;

  constructor(
    private readonly credentialStore: EncryptedCredentialStore,
    private readonly oauthProviders: OAuthProviderRegistry,
  ) {}

  public async initiate(context: OAuthInitiateContext): Promise<Result<AuthorizationResult, AuthError>> {
    const strategyResult = this.oauthProviders.resolveStrategy(context.provider);
    if (!strategyResult.ok) {
      return strategyResult;
    }

    return strategyResult.value.initiate(context);
  }

  public async handleCallback(context: OAuthCallbackContext): Promise<Result<OAuthTokens, AuthError>> {
    const strategyResult = this.oauthProviders.resolveStrategy(context.provider);
    if (!strategyResult.ok) {
      return strategyResult;
    }

    return strategyResult.value.handleCallback(context);
  }

  public async refresh(context: OAuthRefreshContext): Promise<Result<OAuthTokens, AuthError>> {
    const strategyResult = this.oauthProviders.resolveStrategy(context.provider);
    if (!strategyResult.ok) {
      return strategyResult;
    }

    return strategyResult.value.refresh(context);
  }

  public async storeTokens(context: OAuthStoreContext): Promise<Result<void, AuthError>> {
    const result = await this.credentialStore.set({
      id: `auth_${context.provider}_oauth`,
      provider: context.provider,
      type: "oauth",
      accountId: "default",
      payload: toSerializedOAuthTokens(context.tokens),
    });

    if (!result.ok) {
      return err(new AuthError(`Unable to set OAuth tokens for provider ${context.provider}`, result.error));
    }

    return ok(undefined);
  }

  public async retrieveTokens(context: AuthStrategyContext): Promise<Result<OAuthTokens | null, AuthError>> {
    const result = await this.credentialStore.get({
      id: `auth_${context.provider}_oauth`,
      provider: context.provider,
      type: "oauth",
      accountId: "default",
    });

    if (!result.ok) {
      return err(new AuthError(`Unable to get OAuth credential for provider ${context.provider}`, result.error));
    }

    if (!result.value) {
      return ok(null);
    }

    const payloadResult = await this.credentialStore.decryptPayload<unknown>(result.value);
    if (!payloadResult.ok) {
      return err(new AuthError(`Unable to read OAuth credential for provider ${context.provider}`, payloadResult.error));
    }

    const serialized = toSerializedOAuthTokensPayload(payloadResult.value);
    if (!serialized) {
      return err(new AuthError(`Stored OAuth credential is invalid for provider ${context.provider}`));
    }

    return ok(toOAuthTokens(serialized));
  }

  public async revoke(context: AuthStrategyContext): Promise<Result<void, AuthError>> {
    const result = await this.credentialStore.revoke(`auth_${context.provider}_oauth`);
    if (!result.ok) {
      return err(new AuthError(`Unable to revoke OAuth credential for provider ${context.provider}`, result.error));
    }

    return ok(undefined);
  }
}

export class ProviderAuthService implements AuthService {
  private readonly store: EncryptedCredentialStore;
  private readonly registry: ProviderRegistry;
  private readonly apiKeyStrategies: Map<string, ApiKeyAuthStrategy>;
  private readonly oauthStrategies: Map<string, OAuthStrategy>;
  private readonly defaultApiKeyStrategy: ApiKeyAuthStrategy;
  private readonly defaultOAuthStrategy: OAuthStrategy;
  private readonly pendingOAuthCallbackSessions = new Map<string, PendingOAuthCallbackSession>();

  constructor(options: ProviderAuthServiceOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.defaultApiKeyStrategy = new CredentialStoreApiKeyStrategy(this.store, validateApiKey);
    this.defaultOAuthStrategy = new CredentialStoreOAuthStrategy(
      this.store,
      options.oauthProviderRegistry ?? new OAuthProviderRegistry(),
    );
    this.apiKeyStrategies = new Map(
      Object.entries(options.apiKeyStrategies ?? {}).map(([provider, strategy]) => [normalizeProviderId(provider), strategy]),
    );
    this.oauthStrategies = new Map(
      Object.entries(options.oauthStrategies ?? {}).map(([provider, strategy]) => [normalizeProviderId(provider), strategy]),
    );
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
    const strategyResult = this.resolveApiKeyStrategy(normalizedProvider);
    if (!strategyResult.ok) {
      return strategyResult;
    }

    const keyResult = strategyResult.value.validate({
      provider: normalizedProvider,
      key,
      metadata,
    });
    if (!keyResult.ok) {
      return keyResult;
    }

    if (!this.getAuthMethods(normalizedProvider).includes("api_key")) {
      return err(new AuthError(`Provider ${normalizedProvider} does not support api_key authentication`));
    }

    const strategy = strategyResult.value;
    if (hasEndpointValidation(strategy)) {
      const endpointResult = await strategy.validateWithEndpoint(keyResult.value);
      if (!endpointResult.ok) {
        return endpointResult;
      }
    }

    return strategy.store({
      provider: normalizedProvider,
      key: keyResult.value,
      metadata,
    });
  }

  public async setOAuthTokens(provider: string, tokens: OAuthTokens): Promise<Result<void, AuthError>> {
    const providerResult = validateProviderId(provider);
    if (!providerResult.ok) {
      return providerResult;
    }

    const normalizedProvider = providerResult.value;
    const strategyResult = this.resolveOAuthStrategy(normalizedProvider);
    if (!strategyResult.ok) {
      return strategyResult;
    }

    if (!this.getAuthMethods(normalizedProvider).includes("oauth")) {
      return err(new AuthError(`Provider ${normalizedProvider} does not support oauth authentication`));
    }

    return strategyResult.value.storeTokens({
      provider: normalizedProvider,
      tokens,
    });
  }

  public async initiateOAuth(
    provider: string,
    context: OAuthInitiationRuntimeContext = {},
  ): Promise<Result<AuthorizationResult, AuthError>> {
    const providerResult = validateProviderId(provider);
    if (!providerResult.ok) {
      return providerResult;
    }

    const normalizedProvider = providerResult.value;
    const strategyResult = this.resolveOAuthStrategy(normalizedProvider);
    if (!strategyResult.ok) {
      return strategyResult;
    }

    const localCallbackOptions = context.localCallback;
    const shouldUseLocalCallback = localCallbackOptions !== false && normalizedProvider !== "anthropic";
    let callbackSession: OAuthLocalCallbackSession | null = null;

    if (shouldUseLocalCallback) {
      try {
        callbackSession = OAuthFlowHandler.startLocalCallbackServer(localCallbackOptions ?? {});
      } catch (error) {
        return err(
          new AuthError(
            `Unable to start local OAuth callback server for provider ${normalizedProvider}`,
            error instanceof Error ? error : undefined,
          ),
        );
      }
    }

    const register = callbackSession
      ? {
          ...context.register,
          redirectUri: callbackSession.redirectUri,
        }
      : context.register;

    const initiateResult = await strategyResult.value.initiate({
      provider: normalizedProvider,
      register,
    });

    if (!initiateResult.ok) {
      callbackSession?.stop();
      return initiateResult;
    }

    if (callbackSession && initiateResult.value.type === "authorization_code") {
      this.stopPendingOAuthCallbackSession(normalizedProvider);
      this.pendingOAuthCallbackSessions.set(normalizedProvider, {
        session: callbackSession,
        expectedState: initiateResult.value.state,
      });
    } else {
      callbackSession?.stop();
    }

    return initiateResult;
  }

  public async completeOAuthCallback(
    provider: string,
    context: OAuthCompletionRuntimeContext = {},
  ): Promise<Result<OAuthTokens, AuthError>> {
    const providerResult = validateProviderId(provider);
    if (!providerResult.ok) {
      return providerResult;
    }

    const normalizedProvider = providerResult.value;
    const strategyResult = this.resolveOAuthStrategy(normalizedProvider);
    if (!strategyResult.ok) {
      return strategyResult;
    }

    const pendingCallbackSession = this.pendingOAuthCallbackSessions.get(normalizedProvider);
    const explicitCode = context.code?.trim() ?? "";
    let code = explicitCode;
    let state = context.state;

    if (!code) {
      if (!pendingCallbackSession) {
        return err(
          new AuthError(
            `OAuth callback code is required for provider ${normalizedProvider}. Start browser sign-in and retry.`,
          ),
        );
      }

      try {
        const callback = await pendingCallbackSession.session.waitForCallback(pendingCallbackSession.expectedState);
        code = callback.code;
        state = callback.state;
      } catch (error) {
        this.stopPendingOAuthCallbackSession(normalizedProvider);
        return err(
          new AuthError(
            `OAuth callback failed for provider ${normalizedProvider}. Restart sign-in and try again.`,
            error instanceof Error ? error : undefined,
          ),
        );
      }
    }

    const callbackResult = await strategyResult.value.handleCallback({
      provider: normalizedProvider,
      code,
      state,
      exchange: context.exchange,
    });

    if (pendingCallbackSession) {
      this.stopPendingOAuthCallbackSession(normalizedProvider);
    }

    if (!callbackResult.ok) {
      return callbackResult;
    }

    const persistResult = await strategyResult.value.storeTokens({
      provider: normalizedProvider,
      tokens: callbackResult.value,
    });
    if (!persistResult.ok) {
      return persistResult;
    }

    return callbackResult;
  }

  private stopPendingOAuthCallbackSession(provider: string): void {
    const pending = this.pendingOAuthCallbackSessions.get(provider);
    if (!pending) {
      return;
    }

    try {
      pending.session.stop();
    } catch {
      // swallow cleanup failures
    }

    this.pendingOAuthCallbackSessions.delete(provider);
  }

  public async getOAuthAccessToken(provider: string): Promise<Result<string, AuthError>> {
    const providerResult = validateProviderId(provider);
    if (!providerResult.ok) {
      return providerResult;
    }

    const normalizedProvider = providerResult.value;
    const strategyResult = this.resolveOAuthStrategy(normalizedProvider);
    if (!strategyResult.ok) {
      return strategyResult;
    }

    const strategy = strategyResult.value;
    const tokensResult = await strategy.retrieveTokens({ provider: normalizedProvider });
    if (!tokensResult.ok) {
      return tokensResult;
    }

    const tokens = tokensResult.value;
    if (!tokens) {
      return err(
        new AuthError(
          `No OAuth credentials configured for provider ${normalizedProvider}. Start browser sign-in to continue.`,
        ),
      );
    }

    if (!isOAuthTokenExpired(tokens)) {
      return ok(tokens.accessToken);
    }

    if (!tokens.refreshToken) {
      return err(
        new AuthError(
          `OAuth session for ${normalizedProvider} expired and cannot refresh. Re-authenticate from the connect flow.`,
        ),
      );
    }

    const refreshResult = await strategy.refresh({
      provider: normalizedProvider,
      refreshToken: tokens.refreshToken,
    });
    if (!refreshResult.ok) {
      return err(
        new AuthError(
          `OAuth refresh failed for ${normalizedProvider}. Re-authenticate from the connect flow and retry.`,
          refreshResult.error,
        ),
      );
    }

    const persistResult = await strategy.storeTokens({
      provider: normalizedProvider,
      tokens: refreshResult.value,
    });
    if (!persistResult.ok) {
      return persistResult;
    }

    return ok(refreshResult.value.accessToken);
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

    const knownProviderIds = new Set<string>(this.registry.listUserConfigurableCapabilities().map((entry) => entry.providerId));
    for (const providerId of latestCredentialByProvider.keys()) {
      const capabilities = this.registry.getCapabilities(providerId);
      if (capabilities?.userConfigurable === false) {
        continue;
      }

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

        const configured = requiresAuth ? credential !== undefined : true;
        let connectionState: ProviderConnectionState;
        if (!requiresAuth) {
          connectionState = "ready";
        } else if (!credential) {
          connectionState = "requires_auth";
        } else if (credential.revokedAt !== undefined) {
          connectionState = "requires_auth";
        } else {
          connectionState = "ready";
        }

        return {
          provider: providerId,
          requiresAuth,
          authModes,
          configured,
          connectionState,
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
    const authModes = this.getAuthMethods(normalizedProvider);
    if (authModes.includes("api_key")) {
      const apiKeyStrategy = this.resolveApiKeyStrategy(normalizedProvider);
      if (!apiKeyStrategy.ok) {
        return apiKeyStrategy;
      }

      const revokeResult = await apiKeyStrategy.value.revoke({ provider: normalizedProvider });
      if (!revokeResult.ok) {
        return revokeResult;
      }
    }

    if (authModes.includes("oauth")) {
      const oauthStrategy = this.resolveOAuthStrategy(normalizedProvider);
      if (!oauthStrategy.ok) {
        return oauthStrategy;
      }

      const revokeResult = await oauthStrategy.value.revoke({ provider: normalizedProvider });
      if (!revokeResult.ok) {
        return revokeResult;
      }
    }

    return ok(undefined);
  }

  public async handleCommand(payload: ProviderAuthCommandPayload): Promise<Result<ProviderAuthCommandResult, AuthError>> {
    if ("action" in payload && payload.action === "list") {
      const listResult = await this.listProviders();
      if (!listResult.ok) {
        return listResult;
      }

      return ok({
        action: "list",
        source: payload.source,
        providers: listResult.value,
      });
    }

    const providerResult = validateProviderId(payload.provider);
    if (!providerResult.ok) {
      return providerResult;
    }

    const provider = providerResult.value;
    const source = payload.source;

    if ("action" in payload && payload.action === "oauth_initiate") {
      const initiateResult = await this.initiateOAuth(provider, {
        register: {
          state: payload.state,
          codeVerifier: payload.codeVerifier,
          redirectUri: payload.redirectUri,
        },
      });
      if (!initiateResult.ok) {
        return ok({
          action: "oauth_initiate",
          provider,
          source,
          guidance: {
            provider,
            action: "retry",
            message: initiateResult.error.message,
            supportedModes: this.getAuthMethods(provider),
          },
        });
      }

      return ok({
        action: "oauth_initiate",
        provider,
        source,
        authorization: initiateResult.value,
      });
    }

    if ("action" in payload && payload.action === "oauth_callback") {
      const callbackResult = await this.completeOAuthCallback(provider, {
        code: payload.code,
        state: payload.state,
        exchange: {
          codeVerifier: payload.codeVerifier,
          redirectUri: payload.redirectUri,
          state: payload.state,
        },
      });

      if (!callbackResult.ok) {
        return ok({
          action: "oauth_callback",
          provider,
          source,
          guidance: {
            provider,
            action: "reauth",
            message: callbackResult.error.message,
            supportedModes: this.getAuthMethods(provider),
          },
        });
      }

      const credentialResult = await this.getCredential(provider);
      if (!credentialResult.ok) {
        return credentialResult;
      }

      return ok({
        action: "oauth_callback",
        provider,
        source,
        credential: credentialResult.value,
        tokens: callbackResult.value,
        guidance: this.buildGuidance(provider, credentialResult.value, source),
      });
    }

    if ("action" in payload && payload.action === "get") {
      const credentialResult = await this.getCredential(provider);
      if (!credentialResult.ok) {
        return credentialResult;
      }

      const guidance = this.buildGuidance(provider, credentialResult.value, source);
      return ok({
        action: "get",
        provider,
        source,
        credential: credentialResult.value,
        guidance,
      });
    }

    if ("action" in payload && payload.action === "revoke") {
      const revokeResult = await this.revokeProvider(provider);
      if (!revokeResult.ok) {
        return revokeResult;
      }

      return ok({
        action: "revoke",
        provider,
        source,
      });
    }

    const configureResult =
      payload.mode === "api_key"
        ? await this.setApiKey(provider, payload.key, payload.metadata)
        : await this.setOAuthTokens(provider, payload.tokens);

    if (!configureResult.ok) {
      const supportedModes = this.getAuthMethods(provider);
      return ok({
        action: "configure",
        provider,
        source,
        guidance: {
          provider,
          action: "retry",
          message: configureResult.error.message,
          supportedModes,
        },
      });
    }

    const credentialResult = await this.getCredential(provider);
    if (!credentialResult.ok) {
      return credentialResult;
    }

    return ok({
      action: "configure",
      provider,
      source,
      credential: credentialResult.value,
      guidance: this.buildGuidance(provider, credentialResult.value, source),
    });
  }

  public async getProviderAuthStatus(provider: string): Promise<Result<ProviderAuthStatus, AuthError>> {
    const providerResult = validateProviderId(provider);
    if (!providerResult.ok) {
      return providerResult;
    }

    const normalizedProvider = providerResult.value;
    const requiresAuth = this.requiresAuth(normalizedProvider);
    const authModes = this.getAuthMethods(normalizedProvider);
    const capabilities = this.registry.getCapabilities(normalizedProvider);
    const registeredProvider = this.registry.get(normalizedProvider);

    if (!requiresAuth) {
      return ok({
        provider: normalizedProvider,
        requiresAuth: false,
        authModes,
        configured: true,
        connectionState: "ready",
        envVars: capabilities?.envVars,
        baseUrl: capabilities?.baseUrl ?? registeredProvider?.config.baseUrl,
      });
    }

    const credentialResult = await this.getCredential(normalizedProvider);
    if (!credentialResult.ok) {
      return credentialResult;
    }

    const credential = credentialResult.value;
    if (!credential) {
      return ok({
        provider: normalizedProvider,
        requiresAuth: true,
        authModes,
        configured: false,
        connectionState: "requires_auth",
        envVars: capabilities?.envVars,
        baseUrl: capabilities?.baseUrl ?? registeredProvider?.config.baseUrl,
      });
    }

    if (credential.revokedAt !== undefined) {
      return ok({
        provider: normalizedProvider,
        requiresAuth: true,
        authModes,
        configured: false,
        connectionState: "requires_auth",
        credentialType: toSupportedCredentialType(credential.type),
        updatedAt: credential.updatedAt,
        envVars: capabilities?.envVars,
        baseUrl: capabilities?.baseUrl ?? registeredProvider?.config.baseUrl,
      });
    }

    const credentialType = toSupportedCredentialType(credential.type);

    if (credentialType === "oauth") {
      const expiryResult = await this.getOAuthTokenExpiry(normalizedProvider);
      if (expiryResult.ok && expiryResult.value !== null) {
        const { expiresAt, expired } = expiryResult.value;
        if (expired) {
          return ok({
            provider: normalizedProvider,
            requiresAuth: true,
            authModes,
            configured: true,
            connectionState: "requires_reauth",
            credentialType,
            updatedAt: credential.updatedAt,
            expiresAt: expiresAt.getTime(),
            envVars: capabilities?.envVars,
            baseUrl: capabilities?.baseUrl ?? registeredProvider?.config.baseUrl,
          });
        }

        return ok({
          provider: normalizedProvider,
          requiresAuth: true,
          authModes,
          configured: true,
          connectionState: "ready",
          credentialType,
          updatedAt: credential.updatedAt,
          expiresAt: expiresAt.getTime(),
          envVars: capabilities?.envVars,
          baseUrl: capabilities?.baseUrl ?? registeredProvider?.config.baseUrl,
        });
      }
    }

    return ok({
      provider: normalizedProvider,
      requiresAuth: true,
      authModes,
      configured: true,
      connectionState: "ready",
      credentialType,
      updatedAt: credential.updatedAt,
      envVars: capabilities?.envVars,
      baseUrl: capabilities?.baseUrl ?? registeredProvider?.config.baseUrl,
    });
  }

  public async checkConversationReady(provider: string): Promise<Result<ConversationAuthCheck, AuthError>> {
    const statusResult = await this.getProviderAuthStatus(provider);
    if (!statusResult.ok) {
      return statusResult;
    }

    const status = statusResult.value;
    const supportedModes = status.authModes;

    switch (status.connectionState) {
      case "ready":
        return ok({
          allowed: true,
          provider: status.provider,
          connectionState: "ready",
        });

      case "requires_auth":
        return ok({
          allowed: false,
          provider: status.provider,
          connectionState: "requires_auth",
          guidance: {
            provider: status.provider,
            action: "configure",
            message: `Authentication required for ${status.provider}. Run /connect to configure ${supportedModes.join(" or ")} credentials.`,
            supportedModes,
          },
        });

      case "requires_reauth":
        return ok({
          allowed: false,
          provider: status.provider,
          connectionState: "requires_reauth",
          guidance: {
            provider: status.provider,
            action: "reauth",
            message: `Credentials expired for ${status.provider}. Run /connect to re-authenticate.`,
            supportedModes,
          },
        });

      case "invalid":
        return ok({
          allowed: false,
          provider: status.provider,
          connectionState: "invalid",
          guidance: {
            provider: status.provider,
            action: "configure",
            message: `Invalid credentials for ${status.provider}. Run /connect to re-configure your connection.`,
            supportedModes,
          },
        });
    }
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

  private resolveApiKeyStrategy(provider: string): Result<ApiKeyAuthStrategy, AuthError> {
    if (!this.getAuthMethods(provider).includes("api_key")) {
      return err(new AuthError(`Provider ${provider} does not support api_key authentication`));
    }

    return ok(this.apiKeyStrategies.get(provider) ?? this.defaultApiKeyStrategy);
  }

  private resolveOAuthStrategy(provider: string): Result<OAuthStrategy, AuthError> {
    if (!this.getAuthMethods(provider).includes("oauth")) {
      return err(new AuthError(`Provider ${provider} does not support oauth authentication`));
    }

    return ok(this.oauthStrategies.get(provider) ?? this.defaultOAuthStrategy);
  }

  private async getOAuthTokenExpiry(
    provider: string,
  ): Promise<Result<{ expiresAt: Date; expired: boolean } | null, AuthError>> {
    const strategyResult = this.resolveOAuthStrategy(provider);
    if (!strategyResult.ok) {
      return ok(null);
    }

    const tokensResult = await strategyResult.value.retrieveTokens({ provider });
    if (!tokensResult.ok) {
      return ok(null);
    }

    const tokens = tokensResult.value;
    if (!tokens) {
      return ok(null);
    }

    return ok({
      expiresAt: tokens.expiresAt,
      expired: isOAuthTokenExpired(tokens),
    });
  }

  private buildGuidance(
    provider: string,
    credential: CredentialRecord | null,
    source: ProviderAuthSurface,
  ): ProviderAuthGuidance | undefined {
    const supportedModes = this.getAuthMethods(provider);
    if (!this.requiresAuth(provider)) {
      return undefined;
    }

    if (!credential) {
      return {
        provider,
        action: "configure",
        message: `Provider ${provider} requires authentication. Configure ${supportedModes.join(" or ")} from ${source}.`,
        supportedModes,
      };
    }

    if (credential.revokedAt !== undefined) {
      return {
        provider,
        action: "reauth",
        message: `Credentials for ${provider} have been revoked. Reconfigure ${supportedModes.join(" or ")} from ${source}.`,
        supportedModes,
      };
    }

    return undefined;
  }
}

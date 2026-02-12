import type { AuthError } from "../../errors";
import type { Result } from "../../result";

export type AuthMode = "oauth" | "api_key" | "token";

export interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectUri: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope: string;
  tokenType: string;
}

export interface OAuthAuthorizationMetadata {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  pkce: boolean;
  revokeUrl?: string;
}

export interface ApiKeyMetadata {
  envVar: string;
  format?: string;
  baseUrl: string;
}

export interface ProviderMetadata {
  name: string;
  description: string;
  authModes: AuthMode[];
  oauth?: OAuthAuthorizationMetadata;
  apiKey?: ApiKeyMetadata;
  endpoints?: string[];
  icon?: string;
}

export interface OAuthRegisterContext {
  state?: string;
  codeVerifier?: string;
  redirectUri?: string;
}

export interface OAuthExchangeContext {
  state?: string;
  codeVerifier?: string;
  redirectUri?: string;
}

export interface AuthStrategyContext {
  provider: string;
}

export interface ApiKeyCredentialInput extends AuthStrategyContext {
  key: string;
  metadata?: Record<string, string>;
}

export interface StoredApiKeyCredential {
  key: string;
  metadata?: Record<string, string>;
  updatedAt: number;
}

export interface ApiKeyAuthStrategy {
  readonly mode: "api_key";
  validate(input: ApiKeyCredentialInput): Result<string, AuthError>;
  store(input: ApiKeyCredentialInput): Promise<Result<void, AuthError>>;
  retrieve(context: AuthStrategyContext): Promise<Result<StoredApiKeyCredential | null, AuthError>>;
  revoke(context: AuthStrategyContext): Promise<Result<void, AuthError>>;
}

export interface OAuthInitiateContext extends AuthStrategyContext {
  register?: OAuthRegisterContext;
}

export interface OAuthCallbackContext extends AuthStrategyContext {
  code: string;
  state?: string;
  exchange?: OAuthExchangeContext;
}

export interface OAuthRefreshContext extends AuthStrategyContext {
  refreshToken: string;
  exchange?: OAuthExchangeContext;
}

export interface OAuthStoreContext extends AuthStrategyContext {
  tokens: OAuthTokens;
}

export interface OAuthStrategy {
  readonly mode: "oauth";
  initiate(context: OAuthInitiateContext): Promise<Result<AuthorizationResult, AuthError>>;
  handleCallback(context: OAuthCallbackContext): Promise<Result<OAuthTokens, AuthError>>;
  refresh(context: OAuthRefreshContext): Promise<Result<OAuthTokens, AuthError>>;
  storeTokens(context: OAuthStoreContext): Promise<Result<void, AuthError>>;
  retrieveTokens(context: AuthStrategyContext): Promise<Result<OAuthTokens | null, AuthError>>;
  revoke(context: AuthStrategyContext): Promise<Result<void, AuthError>>;
}

export interface AuthorizationCodeResult {
  type: "authorization_code";
  authorizationUrl: string;
  state: string;
  codeVerifier?: string;
}

export interface DeviceCodeAuthorizationResult {
  type: "device_code";
  verificationUri: string;
  userCode: string;
  deviceCode: string;
  expiresAt: Date;
  intervalSeconds: number;
  state?: string;
  codeVerifier?: string;
}

export type AuthorizationResult = AuthorizationCodeResult | DeviceCodeAuthorizationResult;

export type OAuthConnectionStatus = "disconnected" | "connected" | "expired" | "error";

export type OAuthProviderType = "anthropic" | "openai" | "google" | "glm" | "kimi" | "minimax";

export interface OAuthProviderDefinition {
  id: OAuthProviderType | string;
  metadata: ProviderMetadata;
  authModes: readonly AuthMode[];
  strategy?: OAuthStrategy;
  register?(config: OAuthConfig, context?: OAuthRegisterContext): Promise<AuthorizationResult>;
  authorize?(config: OAuthConfig, context?: OAuthRegisterContext): Promise<AuthorizationResult>;
  exchange?(code: string, config: OAuthConfig, context?: OAuthExchangeContext): Promise<OAuthTokens>;
  refresh?(refreshToken: string, config: OAuthConfig, context?: OAuthExchangeContext): Promise<OAuthTokens>;
  revoke?(token: string, config: OAuthConfig): Promise<void>;
}

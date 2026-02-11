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
  codeVerifier?: string;
  redirectUri?: string;
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
  authModes: AuthMode[];
  register?(config: OAuthConfig, context?: OAuthRegisterContext): Promise<AuthorizationResult>;
  authorize?(config: OAuthConfig, context?: OAuthRegisterContext): Promise<AuthorizationResult>;
  exchange?(code: string, config: OAuthConfig, context?: OAuthExchangeContext): Promise<OAuthTokens>;
  refresh?(refreshToken: string, config: OAuthConfig, context?: OAuthExchangeContext): Promise<OAuthTokens>;
  revoke?(token: string, config: OAuthConfig): Promise<void>;
}

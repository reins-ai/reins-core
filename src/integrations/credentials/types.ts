import type { Result } from "../../result";
import type { IntegrationError } from "../errors";

export interface OAuthCredential {
  type: "oauth";
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scopes: string[];
  token_type: string;
}

export interface ApiKeyCredential {
  type: "api_key";
  key: string;
  label: string;
}

export interface LocalPathCredential {
  type: "local_path";
  path: string;
  validated: boolean;
}

export type IntegrationCredential = OAuthCredential | ApiKeyCredential | LocalPathCredential;

export type CredentialStatus = "valid" | "expired" | "missing" | "error";

export interface CredentialVault {
  store(integrationId: string, credential: IntegrationCredential): Promise<Result<void, IntegrationError>>;
  retrieve<TCredential extends IntegrationCredential = IntegrationCredential>(
    integrationId: string,
  ): Promise<Result<TCredential | null, IntegrationError>>;
  revoke(integrationId: string): Promise<Result<boolean, IntegrationError>>;
  hasCredentials(integrationId: string): Promise<Result<boolean, IntegrationError>>;
  getStatus(integrationId: string): Promise<Result<CredentialStatus, IntegrationError>>;
}

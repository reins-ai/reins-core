import { err, ok, type Result } from "../../result";
import type { KeyEncryption } from "../../providers/byok/crypto";
import { EncryptedCredentialStore } from "../../providers/credentials/store";
import type { CredentialType } from "../../providers/credentials/types";
import { IntegrationError } from "../errors";
import type {
  ApiKeyCredential,
  CredentialStatus,
  CredentialVault,
  IntegrationCredential,
  LocalPathCredential,
  OAuthCredential,
} from "./types";

const INTEGRATION_PROVIDER = "integration";
const STORED_CREDENTIAL_VERSION = 1;
const CREDENTIAL_TYPE_ORDER = ["oauth", "api_key", "local_path"] as const;

interface StoredIntegrationCredential {
  v: 1;
  ciphertext: string;
  iv: string;
}

export interface IntegrationCredentialVaultOptions {
  store: EncryptedCredentialStore;
  encryption: KeyEncryption;
}

function toCredentialRecordType(type: IntegrationCredential["type"]): CredentialType {
  if (type === "local_path") {
    return "token";
  }

  return type;
}

function normalizeIntegrationId(integrationId: string): Result<string, IntegrationError> {
  const normalized = integrationId.trim().toLowerCase();
  if (normalized.length === 0) {
    return err(new IntegrationError("Integration id is required for credential operations"));
  }

  return ok(normalized);
}

function buildCredentialKey(integrationId: string, credentialType: IntegrationCredential["type"]): string {
  return `integration:${integrationId}:${credentialType}`;
}

function evaluateCredentialStatus(credential: IntegrationCredential): CredentialStatus {
  if (credential.type === "oauth") {
    const expiresAt = Date.parse(credential.expires_at);
    if (Number.isNaN(expiresAt)) {
      return "error";
    }

    return expiresAt <= Date.now() ? "expired" : "valid";
  }

  if (credential.type === "api_key") {
    return credential.key.trim().length > 0 ? "valid" : "error";
  }

  return credential.validated ? "valid" : "error";
}

function isStoredIntegrationCredential(value: unknown): value is StoredIntegrationCredential {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.v === STORED_CREDENTIAL_VERSION && typeof candidate.ciphertext === "string" && typeof candidate.iv === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseCredential(value: unknown): IntegrationCredential | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.type === "oauth") {
    if (
      typeof candidate.access_token === "string" &&
      typeof candidate.refresh_token === "string" &&
      typeof candidate.expires_at === "string" &&
      typeof candidate.token_type === "string" &&
      isStringArray(candidate.scopes)
    ) {
      const credential: OAuthCredential = {
        type: "oauth",
        access_token: candidate.access_token,
        refresh_token: candidate.refresh_token,
        expires_at: candidate.expires_at,
        scopes: candidate.scopes,
        token_type: candidate.token_type,
      };

      return credential;
    }

    return null;
  }

  if (candidate.type === "api_key") {
    if (typeof candidate.key === "string" && typeof candidate.label === "string") {
      const credential: ApiKeyCredential = {
        type: "api_key",
        key: candidate.key,
        label: candidate.label,
      };

      return credential;
    }

    return null;
  }

  if (candidate.type === "local_path") {
    if (typeof candidate.path === "string" && typeof candidate.validated === "boolean") {
      const credential: LocalPathCredential = {
        type: "local_path",
        path: candidate.path,
        validated: candidate.validated,
      };

      return credential;
    }

    return null;
  }

  return null;
}

export class IntegrationCredentialVault implements CredentialVault {
  private readonly credentialStore: EncryptedCredentialStore;
  private readonly encryption: KeyEncryption;

  constructor(options: IntegrationCredentialVaultOptions) {
    this.credentialStore = options.store;
    this.encryption = options.encryption;
  }

  public async store(integrationId: string, credential: IntegrationCredential): Promise<Result<void, IntegrationError>> {
    const integrationIdResult = normalizeIntegrationId(integrationId);
    if (!integrationIdResult.ok) {
      return integrationIdResult;
    }

    let encryptedCredential: { ciphertext: string; iv: string };
    try {
      encryptedCredential = await this.encryption.encrypt(JSON.stringify(credential));
    } catch (cause) {
      return err(this.toIntegrationError("Failed to encrypt integration credential", cause));
    }

    const key = buildCredentialKey(integrationIdResult.value, credential.type);
    const writeResult = await this.credentialStore.set({
      id: key,
      provider: INTEGRATION_PROVIDER,
      accountId: integrationIdResult.value,
      type: toCredentialRecordType(credential.type),
      metadata: {
        integrationId: integrationIdResult.value,
        credentialType: credential.type,
      },
      payload: {
        v: STORED_CREDENTIAL_VERSION,
        ciphertext: encryptedCredential.ciphertext,
        iv: encryptedCredential.iv,
      } satisfies StoredIntegrationCredential,
    });

    if (!writeResult.ok) {
      return err(this.toIntegrationError("Failed to persist integration credential", writeResult.error));
    }

    return ok(undefined);
  }

  public async retrieve<TCredential extends IntegrationCredential = IntegrationCredential>(
    integrationId: string,
  ): Promise<Result<TCredential | null, IntegrationError>> {
    const integrationIdResult = normalizeIntegrationId(integrationId);
    if (!integrationIdResult.ok) {
      return integrationIdResult;
    }

    for (const credentialType of CREDENTIAL_TYPE_ORDER) {
      const key = buildCredentialKey(integrationIdResult.value, credentialType);
      const recordResult = await this.credentialStore.get({
        id: key,
        provider: INTEGRATION_PROVIDER,
        accountId: integrationIdResult.value,
      });
      if (!recordResult.ok) {
        return err(this.toIntegrationError("Failed to load integration credential", recordResult.error));
      }

      if (!recordResult.value) {
        continue;
      }

      const payloadResult = await this.credentialStore.decryptPayload<unknown>(recordResult.value);
      if (!payloadResult.ok) {
        return err(this.toIntegrationError("Failed to decrypt stored integration credential payload", payloadResult.error));
      }

      if (!isStoredIntegrationCredential(payloadResult.value)) {
        return err(new IntegrationError("Stored integration credential payload is malformed"));
      }

      let plaintext: string;
      try {
        plaintext = await this.encryption.decrypt(payloadResult.value.ciphertext, payloadResult.value.iv);
      } catch (cause) {
        return err(this.toIntegrationError("Failed to decrypt integration credential", cause));
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(plaintext) as unknown;
      } catch (cause) {
        return err(this.toIntegrationError("Stored integration credential JSON is invalid", cause));
      }

      const credential = parseCredential(parsed);
      if (!credential) {
        return err(new IntegrationError("Stored integration credential shape is invalid"));
      }

      return ok(credential as TCredential);
    }

    return ok(null);
  }

  public async revoke(integrationId: string): Promise<Result<boolean, IntegrationError>> {
    const integrationIdResult = normalizeIntegrationId(integrationId);
    if (!integrationIdResult.ok) {
      return integrationIdResult;
    }

    let revoked = false;
    for (const credentialType of CREDENTIAL_TYPE_ORDER) {
      const key = buildCredentialKey(integrationIdResult.value, credentialType);
      const revokeResult = await this.credentialStore.revoke(key);
      if (!revokeResult.ok) {
        return err(this.toIntegrationError("Failed to revoke integration credential", revokeResult.error));
      }

      revoked = revoked || revokeResult.value;
    }

    return ok(revoked);
  }

  public async hasCredentials(integrationId: string): Promise<Result<boolean, IntegrationError>> {
    const integrationIdResult = normalizeIntegrationId(integrationId);
    if (!integrationIdResult.ok) {
      return integrationIdResult;
    }

    for (const credentialType of CREDENTIAL_TYPE_ORDER) {
      const key = buildCredentialKey(integrationIdResult.value, credentialType);
      const getResult = await this.credentialStore.get({
        id: key,
        provider: INTEGRATION_PROVIDER,
        accountId: integrationIdResult.value,
      });
      if (!getResult.ok) {
        return err(this.toIntegrationError("Failed to check integration credentials", getResult.error));
      }

      if (getResult.value) {
        return ok(true);
      }
    }

    return ok(false);
  }

  public async getStatus(integrationId: string): Promise<Result<CredentialStatus, IntegrationError>> {
    const credentialResult = await this.retrieve(integrationId);
    if (!credentialResult.ok) {
      return credentialResult;
    }

    if (!credentialResult.value) {
      return ok("missing");
    }

    return ok(evaluateCredentialStatus(credentialResult.value));
  }

  private toIntegrationError(message: string, cause: unknown): IntegrationError {
    if (cause instanceof IntegrationError) {
      return cause;
    }

    return new IntegrationError(message, cause instanceof Error ? cause : undefined);
  }
}

export class InMemoryCredentialVault implements CredentialVault {
  private readonly credentials = new Map<string, IntegrationCredential>();

  public async store(integrationId: string, credential: IntegrationCredential): Promise<Result<void, IntegrationError>> {
    const integrationIdResult = normalizeIntegrationId(integrationId);
    if (!integrationIdResult.ok) {
      return integrationIdResult;
    }

    const key = buildCredentialKey(integrationIdResult.value, credential.type);
    this.credentials.set(key, structuredClone(credential));
    return ok(undefined);
  }

  public async retrieve<TCredential extends IntegrationCredential = IntegrationCredential>(
    integrationId: string,
  ): Promise<Result<TCredential | null, IntegrationError>> {
    const integrationIdResult = normalizeIntegrationId(integrationId);
    if (!integrationIdResult.ok) {
      return integrationIdResult;
    }

    for (const credentialType of CREDENTIAL_TYPE_ORDER) {
      const key = buildCredentialKey(integrationIdResult.value, credentialType);
      const credential = this.credentials.get(key);
      if (credential) {
        return ok(structuredClone(credential) as TCredential);
      }
    }

    return ok(null);
  }

  public async revoke(integrationId: string): Promise<Result<boolean, IntegrationError>> {
    const integrationIdResult = normalizeIntegrationId(integrationId);
    if (!integrationIdResult.ok) {
      return integrationIdResult;
    }

    let revoked = false;
    for (const credentialType of CREDENTIAL_TYPE_ORDER) {
      const key = buildCredentialKey(integrationIdResult.value, credentialType);
      revoked = this.credentials.delete(key) || revoked;
    }

    return ok(revoked);
  }

  public async hasCredentials(integrationId: string): Promise<Result<boolean, IntegrationError>> {
    const integrationIdResult = normalizeIntegrationId(integrationId);
    if (!integrationIdResult.ok) {
      return integrationIdResult;
    }

    for (const credentialType of CREDENTIAL_TYPE_ORDER) {
      const key = buildCredentialKey(integrationIdResult.value, credentialType);
      if (this.credentials.has(key)) {
        return ok(true);
      }
    }

    return ok(false);
  }

  public async getStatus(integrationId: string): Promise<Result<CredentialStatus, IntegrationError>> {
    const credentialResult = await this.retrieve(integrationId);
    if (!credentialResult.ok) {
      return credentialResult;
    }

    if (!credentialResult.value) {
      return ok("missing");
    }

    return ok(evaluateCredentialStatus(credentialResult.value));
  }
}

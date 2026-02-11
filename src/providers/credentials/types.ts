export type CredentialType = "api_key" | "oauth" | "token";

export interface EncryptedCredentialPayload {
  v: 1;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface CredentialSyncEnvelope {
  version: number;
  checksum: string;
  updatedAt: number;
  syncedAt?: number;
}

export interface CredentialRecord {
  id: string;
  provider: string;
  type: CredentialType;
  accountId?: string;
  metadata?: Record<string, string>;
  encryptedPayload: EncryptedCredentialPayload;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
  sync: CredentialSyncEnvelope;
}

export interface CredentialRecordInput {
  id?: string;
  provider: string;
  type: CredentialType;
  accountId?: string;
  metadata?: Record<string, string>;
  payload: unknown;
}

export interface CredentialRecordQuery {
  id?: string;
  provider?: string;
  type?: CredentialType;
  accountId?: string;
  includeRevoked?: boolean;
}

export interface CredentialFilePayload {
  v: 1;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface CredentialStoreState {
  version: number;
  records: Record<string, CredentialRecord>;
  envelope: CredentialSyncEnvelope;
}

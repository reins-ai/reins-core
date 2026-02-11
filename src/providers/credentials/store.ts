import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AuthError } from "../../errors";
import { getDataRoot } from "../../daemon/paths";
import { err, ok, type Result } from "../../result";
import type {
  CredentialFilePayload,
  CredentialRecord,
  CredentialRecordInput,
  CredentialRecordQuery,
  CredentialStoreState,
  CredentialSyncEnvelope,
  EncryptedCredentialPayload,
} from "./types";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DERIVATION_ITERATIONS = 100_000;
const STATE_VERSION = 1;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function copyMetadata(metadata: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b)));
}

function cloneRecord(record: CredentialRecord): CredentialRecord {
  return {
    ...record,
    metadata: copyMetadata(record.metadata),
    encryptedPayload: { ...record.encryptedPayload },
    sync: { ...record.sync },
  };
}

function normalizeRecord(record: CredentialRecord): CredentialRecord {
  return {
    ...cloneRecord(record),
    provider: record.provider.trim().toLowerCase(),
    accountId: record.accountId?.trim().toLowerCase(),
  };
}

function toFilePayload(value: unknown): Result<CredentialFilePayload, AuthError> {
  if (!isRecord(value)) {
    return err(new AuthError("Credential store file payload is invalid"));
  }

  const v = value.v;
  const salt = value.salt;
  const iv = value.iv;
  const ciphertext = value.ciphertext;

  if (v !== 1 || typeof salt !== "string" || typeof iv !== "string" || typeof ciphertext !== "string") {
    return err(new AuthError("Credential store file payload fields are invalid"));
  }

  return ok({ v, salt, iv, ciphertext });
}

function toEncryptedCredentialPayload(value: unknown): Result<EncryptedCredentialPayload, AuthError> {
  if (!isRecord(value)) {
    return err(new AuthError("Credential encrypted payload is invalid"));
  }

  const v = value.v;
  const salt = value.salt;
  const iv = value.iv;
  const ciphertext = value.ciphertext;

  if (v !== 1 || typeof salt !== "string" || typeof iv !== "string" || typeof ciphertext !== "string") {
    return err(new AuthError("Credential encrypted payload fields are invalid"));
  }

  return ok({ v, salt, iv, ciphertext });
}

function toSyncEnvelope(value: unknown): Result<CredentialSyncEnvelope, AuthError> {
  if (!isRecord(value)) {
    return err(new AuthError("Credential sync envelope is invalid"));
  }

  const version = value.version;
  const checksum = value.checksum;
  const updatedAt = value.updatedAt;
  const syncedAt = value.syncedAt;

  if (
    typeof version !== "number" ||
    typeof checksum !== "string" ||
    typeof updatedAt !== "number" ||
    (syncedAt !== undefined && typeof syncedAt !== "number")
  ) {
    return err(new AuthError("Credential sync envelope fields are invalid"));
  }

  return ok({ version, checksum, updatedAt, syncedAt });
}

function toCredentialRecord(value: unknown): Result<CredentialRecord, AuthError> {
  if (!isRecord(value)) {
    return err(new AuthError("Credential record is invalid"));
  }

  const id = value.id;
  const provider = value.provider;
  const type = value.type;
  const accountId = value.accountId;
  const metadata = value.metadata;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  const revokedAt = value.revokedAt;

  if (
    typeof id !== "string" ||
    typeof provider !== "string" ||
    (type !== "api_key" && type !== "oauth" && type !== "token") ||
    (accountId !== undefined && typeof accountId !== "string") ||
    typeof createdAt !== "number" ||
    typeof updatedAt !== "number" ||
    (revokedAt !== undefined && typeof revokedAt !== "number")
  ) {
    return err(new AuthError("Credential record fields are invalid"));
  }

  let normalizedMetadata: Record<string, string> | undefined;
  if (metadata !== undefined) {
    if (!isRecord(metadata)) {
      return err(new AuthError("Credential metadata is invalid"));
    }

    normalizedMetadata = {};
    for (const [key, rawValue] of Object.entries(metadata)) {
      if (typeof rawValue !== "string") {
        return err(new AuthError("Credential metadata value is invalid"));
      }

      normalizedMetadata[key] = rawValue;
    }
  }

  const payloadResult = toEncryptedCredentialPayload(value.encryptedPayload);
  if (!payloadResult.ok) {
    return payloadResult;
  }

  const syncResult = toSyncEnvelope(value.sync);
  if (!syncResult.ok) {
    return syncResult;
  }

  return ok(
    normalizeRecord({
      id,
      provider,
      type,
      accountId,
      metadata: normalizedMetadata,
      encryptedPayload: payloadResult.value,
      createdAt,
      updatedAt,
      revokedAt,
      sync: syncResult.value,
    }),
  );
}

function toStoreState(value: unknown): Result<CredentialStoreState, AuthError> {
  if (!isRecord(value)) {
    return err(new AuthError("Credential store state is invalid"));
  }

  const version = value.version;
  const records = value.records;
  if (typeof version !== "number" || !isRecord(records)) {
    return err(new AuthError("Credential store state fields are invalid"));
  }

  const normalizedRecords: Record<string, CredentialRecord> = {};
  for (const [id, rawRecord] of Object.entries(records)) {
    const recordResult = toCredentialRecord(rawRecord);
    if (!recordResult.ok) {
      return recordResult;
    }

    if (recordResult.value.id !== id) {
      return err(new AuthError("Credential record identifier mismatch"));
    }

    normalizedRecords[id] = recordResult.value;
  }

  const envelopeResult = toSyncEnvelope(value.envelope);
  if (!envelopeResult.ok) {
    return envelopeResult;
  }

  return ok({
    version,
    records: normalizedRecords,
    envelope: envelopeResult.value,
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

function canonicalRecordShape(record: CredentialRecord): Record<string, unknown> {
  return {
    id: record.id,
    provider: record.provider,
    type: record.type,
    accountId: record.accountId,
    metadata: copyMetadata(record.metadata),
    encryptedPayload: {
      v: record.encryptedPayload.v,
      salt: record.encryptedPayload.salt,
      iv: record.encryptedPayload.iv,
      ciphertext: record.encryptedPayload.ciphertext,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revokedAt: record.revokedAt,
  };
}

async function buildChecksum(records: Record<string, CredentialRecord>): Promise<string> {
  const canonicalRecords = Object.keys(records)
    .sort((a, b) => a.localeCompare(b))
    .map((id) => canonicalRecordShape(records[id]!));
  return sha256Hex(JSON.stringify(canonicalRecords));
}

async function buildSyncEnvelope(
  records: Record<string, CredentialRecord>,
  previous: CredentialSyncEnvelope | undefined,
): Promise<CredentialSyncEnvelope> {
  return {
    version: STATE_VERSION,
    checksum: await buildChecksum(records),
    updatedAt: Date.now(),
    syncedAt: previous?.syncedAt,
  };
}

function matches(record: CredentialRecord, query: CredentialRecordQuery): boolean {
  if (query.id && record.id !== query.id) {
    return false;
  }

  if (query.provider && record.provider !== query.provider.trim().toLowerCase()) {
    return false;
  }

  if (query.type && record.type !== query.type) {
    return false;
  }

  if (query.accountId && record.accountId !== query.accountId.trim().toLowerCase()) {
    return false;
  }

  if (!query.includeRevoked && record.revokedAt !== undefined) {
    return false;
  }

  return true;
}

function createCredentialId(): string {
  return `cred_${crypto.randomUUID().replace(/-/g, "")}`;
}

export interface EncryptedCredentialStoreOptions {
  encryptionSecret: string;
  filePath?: string;
}

export class EncryptedCredentialStore {
  private readonly filePath: string;
  private readonly encryptionSecret: string;

  constructor(options: EncryptedCredentialStoreOptions) {
    this.encryptionSecret = options.encryptionSecret;
    this.filePath = options.filePath ?? join(getDataRoot(), "credentials", "store.enc.json");
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public async set(input: CredentialRecordInput): Promise<Result<CredentialRecord, AuthError>> {
    const provider = input.provider.trim().toLowerCase();
    const accountId = input.accountId?.trim().toLowerCase();
    const metadata = copyMetadata(input.metadata);

    if (provider.length === 0) {
      return err(new AuthError("Credential provider is required"));
    }

    const encryptedPayloadResult = await this.encryptPayload(input.payload);
    if (!encryptedPayloadResult.ok) {
      return encryptedPayloadResult;
    }

    const stateResult = await this.loadState();
    if (!stateResult.ok) {
      return stateResult;
    }

    const now = Date.now();
    const id = input.id?.trim() || createCredentialId();
    const previous = stateResult.value.records[id];

    const record: CredentialRecord = {
      id,
      provider,
      type: input.type,
      accountId,
      metadata,
      encryptedPayload: encryptedPayloadResult.value,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      sync: {
        version: STATE_VERSION,
        checksum: "",
        updatedAt: now,
        syncedAt: previous?.sync.syncedAt,
      },
    };

    stateResult.value.records[id] = record;
    const saveResult = await this.saveState(stateResult.value);
    if (!saveResult.ok) {
      return saveResult;
    }

    const persisted = saveResult.value.records[id];
    if (!persisted) {
      return err(new AuthError("Credential record save failed"));
    }

    return ok(cloneRecord(persisted));
  }

  public async get(query: CredentialRecordQuery): Promise<Result<CredentialRecord | null, AuthError>> {
    const listResult = await this.list({ ...query, includeRevoked: query.includeRevoked });
    if (!listResult.ok) {
      return listResult;
    }

    return ok(listResult.value[0] ?? null);
  }

  public async list(query: CredentialRecordQuery = {}): Promise<Result<CredentialRecord[], AuthError>> {
    const stateResult = await this.loadState();
    if (!stateResult.ok) {
      return stateResult;
    }

    const records = Object.values(stateResult.value.records)
      .filter((record) => matches(record, query))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => cloneRecord(record));

    return ok(records);
  }

  public async revoke(id: string): Promise<Result<boolean, AuthError>> {
    const recordId = id.trim();
    if (recordId.length === 0) {
      return err(new AuthError("Credential id is required"));
    }

    const stateResult = await this.loadState();
    if (!stateResult.ok) {
      return stateResult;
    }

    const record = stateResult.value.records[recordId];
    if (!record || record.revokedAt !== undefined) {
      return ok(false);
    }

    record.revokedAt = Date.now();
    record.updatedAt = record.revokedAt;

    const saveResult = await this.saveState(stateResult.value);
    if (!saveResult.ok) {
      return saveResult;
    }

    return ok(true);
  }

  public async decryptPayload<T>(record: CredentialRecord): Promise<Result<T, AuthError>> {
    const payloadResult = await this.decryptEncryptedPayload(record.encryptedPayload);
    if (!payloadResult.ok) {
      return payloadResult;
    }

    return ok(payloadResult.value as T);
  }

  public async getEnvelope(): Promise<Result<CredentialSyncEnvelope, AuthError>> {
    const stateResult = await this.loadState();
    if (!stateResult.ok) {
      return stateResult;
    }

    return ok({ ...stateResult.value.envelope });
  }

  private async loadState(): Promise<Result<CredentialStoreState, AuthError>> {
    const file = Bun.file(this.filePath);
    if (!(await file.exists())) {
      return ok(await this.createEmptyState());
    }

    let raw: unknown;
    try {
      raw = await file.json();
    } catch (error) {
      return err(new AuthError("Unable to parse credential store file", error instanceof Error ? error : undefined));
    }

    const filePayloadResult = toFilePayload(raw);
    if (!filePayloadResult.ok) {
      return filePayloadResult;
    }

    const decryptedStateResult = await this.decryptStorePayload(filePayloadResult.value);
    if (!decryptedStateResult.ok) {
      return decryptedStateResult;
    }

    const stateResult = toStoreState(decryptedStateResult.value);
    if (!stateResult.ok) {
      return stateResult;
    }

    return ok({
      version: stateResult.value.version,
      records: Object.fromEntries(
        Object.entries(stateResult.value.records).map(([id, record]) => [id, cloneRecord(record)]),
      ),
      envelope: { ...stateResult.value.envelope },
    });
  }

  private async saveState(state: CredentialStoreState): Promise<Result<CredentialStoreState, AuthError>> {
    const records = Object.fromEntries(
      Object.entries(state.records).map(([id, record]) => {
        const now = Date.now();
        const sync = {
          version: STATE_VERSION,
          checksum: "",
          updatedAt: now,
          syncedAt: record.sync.syncedAt,
        };

        return [
          id,
          {
            ...normalizeRecord(record),
            sync,
          },
        ];
      }),
    );

    const envelope = await buildSyncEnvelope(records, state.envelope);

    for (const record of Object.values(records)) {
      record.sync.checksum = envelope.checksum;
      record.sync.updatedAt = envelope.updatedAt;
      record.sync.version = envelope.version;
    }

    const nextState: CredentialStoreState = {
      version: STATE_VERSION,
      records,
      envelope,
    };

    const encryptedResult = await this.encryptStoreState(nextState);
    if (!encryptedResult.ok) {
      return encryptedResult;
    }

    const directory = dirname(this.filePath);

    try {
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
      if (process.platform !== "win32") {
        await chmod(directory, DIRECTORY_MODE);
      }
    } catch (error) {
      return err(
        new AuthError(
          `Unable to create credential store directory: ${directory}`,
          error instanceof Error ? error : undefined,
        ),
      );
    }

    try {
      await Bun.write(this.filePath, JSON.stringify(encryptedResult.value));
      if (process.platform !== "win32") {
        await chmod(this.filePath, FILE_MODE);
      }
    } catch (error) {
      return err(
        new AuthError(
          `Unable to persist credential store file: ${this.filePath}`,
          error instanceof Error ? error : undefined,
        ),
      );
    }

    return ok(nextState);
  }

  private async createEmptyState(): Promise<CredentialStoreState> {
    const records: Record<string, CredentialRecord> = {};
    return {
      version: STATE_VERSION,
      records,
      envelope: await buildSyncEnvelope(records, undefined),
    };
  }

  private async encryptStoreState(state: CredentialStoreState): Promise<Result<CredentialFilePayload, AuthError>> {
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const keyResult = await this.deriveKey(salt);
      if (!keyResult.ok) {
        return keyResult;
      }

      const plaintext = new TextEncoder().encode(JSON.stringify(state));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyResult.value, plaintext);
      return ok({
        v: 1,
        salt: toBase64(salt),
        iv: toBase64(iv),
        ciphertext: toBase64(new Uint8Array(ciphertext)),
      });
    } catch (error) {
      return err(new AuthError("Unable to encrypt credential store state", error instanceof Error ? error : undefined));
    }
  }

  private async decryptStorePayload(payload: CredentialFilePayload): Promise<Result<unknown, AuthError>> {
    try {
      const salt = fromBase64(payload.salt);
      const iv = fromBase64(payload.iv);
      const ciphertext = fromBase64(payload.ciphertext);

      const keyResult = await this.deriveKey(salt);
      if (!keyResult.ok) {
        return keyResult;
      }

      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(iv) },
        keyResult.value,
        toArrayBuffer(ciphertext),
      );

      return ok(JSON.parse(new TextDecoder().decode(decrypted)) as unknown);
    } catch (error) {
      return err(new AuthError("Unable to decrypt credential store payload", error instanceof Error ? error : undefined));
    }
  }

  private async encryptPayload(payload: unknown): Promise<Result<EncryptedCredentialPayload, AuthError>> {
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));

      const keyResult = await this.deriveKey(salt);
      if (!keyResult.ok) {
        return keyResult;
      }

      const plaintext = new TextEncoder().encode(JSON.stringify(payload));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyResult.value, plaintext);

      return ok({
        v: 1,
        salt: toBase64(salt),
        iv: toBase64(iv),
        ciphertext: toBase64(new Uint8Array(ciphertext)),
      });
    } catch (error) {
      return err(new AuthError("Unable to encrypt credential payload", error instanceof Error ? error : undefined));
    }
  }

  private async decryptEncryptedPayload(payload: EncryptedCredentialPayload): Promise<Result<unknown, AuthError>> {
    try {
      const salt = fromBase64(payload.salt);
      const iv = fromBase64(payload.iv);
      const ciphertext = fromBase64(payload.ciphertext);

      const keyResult = await this.deriveKey(salt);
      if (!keyResult.ok) {
        return keyResult;
      }

      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(iv) },
        keyResult.value,
        toArrayBuffer(ciphertext),
      );

      return ok(JSON.parse(new TextDecoder().decode(decrypted)) as unknown);
    } catch (error) {
      return err(new AuthError("Unable to decrypt credential payload", error instanceof Error ? error : undefined));
    }
  }

  private async deriveKey(salt: Uint8Array): Promise<Result<CryptoKey, AuthError>> {
    try {
      const material = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(this.encryptionSecret),
        "PBKDF2",
        false,
        ["deriveKey"],
      );

      const key = await crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: toArrayBuffer(salt),
          iterations: DERIVATION_ITERATIONS,
          hash: "SHA-256",
        },
        material,
        {
          name: "AES-GCM",
          length: 256,
        },
        false,
        ["encrypt", "decrypt"],
      );

      return ok(key);
    } catch (error) {
      return err(new AuthError("Unable to derive credential encryption key", error instanceof Error ? error : undefined));
    }
  }
}

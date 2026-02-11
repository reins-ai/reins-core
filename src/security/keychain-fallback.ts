import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { err, ok, type Result } from "../result";
import { SecurityError } from "./security-error";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DERIVATION_ITERATIONS = 100_000;

interface EncryptedPayload {
  v: 1;
  salt: string;
  iv: string;
  ciphertext: string;
}

interface SecretEnvelope {
  entries: Record<string, string>;
}

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

function toEncryptedPayload(value: unknown): Result<EncryptedPayload, SecurityError> {
  if (!isRecord(value)) {
    return err(new SecurityError("Encrypted fallback payload is invalid", "SECURITY_PAYLOAD_INVALID"));
  }

  const v = value.v;
  const salt = value.salt;
  const iv = value.iv;
  const ciphertext = value.ciphertext;

  if (v !== 1 || typeof salt !== "string" || typeof iv !== "string" || typeof ciphertext !== "string") {
    return err(new SecurityError("Encrypted fallback payload fields are invalid", "SECURITY_PAYLOAD_INVALID"));
  }

  return ok({ v, salt, iv, ciphertext });
}

function toSecretEnvelope(value: unknown): Result<SecretEnvelope, SecurityError> {
  if (!isRecord(value)) {
    return err(new SecurityError("Fallback secret envelope is invalid", "SECURITY_PAYLOAD_INVALID"));
  }

  const entries = value.entries;
  if (!isRecord(entries)) {
    return err(new SecurityError("Fallback secret envelope entries are invalid", "SECURITY_PAYLOAD_INVALID"));
  }

  const normalizedEntries: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(entries)) {
    if (typeof rawValue !== "string") {
      return err(new SecurityError("Fallback secret entry has invalid value type", "SECURITY_PAYLOAD_INVALID"));
    }

    normalizedEntries[key] = rawValue;
  }

  return ok({ entries: normalizedEntries });
}

export interface EncryptedFileKeychainFallbackOptions {
  filePath?: string;
  keyMaterial?: string;
}

export class EncryptedFileKeychainFallback {
  private readonly filePath: string;
  private readonly keyMaterial: string;

  constructor(options: EncryptedFileKeychainFallbackOptions = {}) {
    this.filePath = options.filePath ?? join(homedir(), ".reins", "machine-secret.enc");
    this.keyMaterial =
      options.keyMaterial ??
      ["reins-machine-auth", userInfo().username, hostname(), process.platform].join(":");
  }

  public getPath(): string {
    return this.filePath;
  }

  public async read(service: string, account: string): Promise<Result<string | null, SecurityError>> {
    const envelopeResult = await this.loadEnvelope();
    if (!envelopeResult.ok) {
      return envelopeResult;
    }

    const entryId = this.toEntryId(service, account);
    return ok(envelopeResult.value.entries[entryId] ?? null);
  }

  public async write(service: string, account: string, secret: string): Promise<Result<void, SecurityError>> {
    const envelopeResult = await this.loadEnvelope();
    if (!envelopeResult.ok) {
      return envelopeResult;
    }

    const entryId = this.toEntryId(service, account);
    envelopeResult.value.entries[entryId] = secret;

    return this.saveEnvelope(envelopeResult.value);
  }

  public async remove(service: string, account: string): Promise<Result<void, SecurityError>> {
    const envelopeResult = await this.loadEnvelope();
    if (!envelopeResult.ok) {
      return envelopeResult;
    }

    const entryId = this.toEntryId(service, account);
    delete envelopeResult.value.entries[entryId];

    if (Object.keys(envelopeResult.value.entries).length === 0) {
      try {
        await rm(this.filePath, { force: true });
        return ok(undefined);
      } catch (error) {
        return err(
          new SecurityError(
            `Unable to delete fallback keychain file: ${this.filePath}`,
            "SECURITY_FALLBACK_DELETE_FAILED",
            error instanceof Error ? error : undefined,
          ),
        );
      }
    }

    return this.saveEnvelope(envelopeResult.value);
  }

  private toEntryId(service: string, account: string): string {
    return `${service}:${account}`;
  }

  private async loadEnvelope(): Promise<Result<SecretEnvelope, SecurityError>> {
    const file = Bun.file(this.filePath);
    if (!(await file.exists())) {
      return ok({ entries: {} });
    }

    let rawPayload: unknown;
    try {
      rawPayload = await file.json();
    } catch (error) {
      return err(
        new SecurityError(
          "Unable to parse fallback keychain file",
          "SECURITY_PAYLOAD_PARSE_FAILED",
          error instanceof Error ? error : undefined,
        ),
      );
    }

    const payloadResult = toEncryptedPayload(rawPayload);
    if (!payloadResult.ok) {
      return payloadResult;
    }

    const decryptedResult = await this.decrypt(payloadResult.value);
    if (!decryptedResult.ok) {
      return decryptedResult;
    }

    const parsedResult = toSecretEnvelope(decryptedResult.value);
    if (!parsedResult.ok) {
      return parsedResult;
    }

    return ok(parsedResult.value);
  }

  private async saveEnvelope(envelope: SecretEnvelope): Promise<Result<void, SecurityError>> {
    const directory = dirname(this.filePath);

    try {
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
      await chmod(directory, DIRECTORY_MODE);
    } catch (error) {
      return err(
        new SecurityError(
          `Unable to prepare fallback keychain directory: ${directory}`,
          "SECURITY_FALLBACK_DIRECTORY_FAILED",
          error instanceof Error ? error : undefined,
        ),
      );
    }

    const encryptedResult = await this.encrypt(envelope);
    if (!encryptedResult.ok) {
      return encryptedResult;
    }

    try {
      await Bun.write(this.filePath, JSON.stringify(encryptedResult.value));
      await chmod(this.filePath, FILE_MODE);
      return ok(undefined);
    } catch (error) {
      return err(
        new SecurityError(
          `Unable to persist fallback keychain file: ${this.filePath}`,
          "SECURITY_FALLBACK_WRITE_FAILED",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  private async encrypt(envelope: SecretEnvelope): Promise<Result<EncryptedPayload, SecurityError>> {
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const keyResult = await this.deriveKey(salt);
      if (!keyResult.ok) {
        return keyResult;
      }

      const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyResult.value, plaintext);

      return ok({
        v: 1,
        salt: toBase64(salt),
        iv: toBase64(iv),
        ciphertext: toBase64(new Uint8Array(ciphertext)),
      });
    } catch (error) {
      return err(
        new SecurityError(
          "Unable to encrypt fallback keychain payload",
          "SECURITY_FALLBACK_ENCRYPT_FAILED",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  private async decrypt(payload: EncryptedPayload): Promise<Result<unknown, SecurityError>> {
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
      return err(
        new SecurityError(
          "Unable to decrypt fallback keychain payload",
          "SECURITY_FALLBACK_DECRYPT_FAILED",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  private async deriveKey(salt: Uint8Array): Promise<Result<CryptoKey, SecurityError>> {
    try {
      const material = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(this.keyMaterial),
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
      return err(
        new SecurityError(
          "Unable to derive fallback encryption key",
          "SECURITY_FALLBACK_KEY_DERIVE_FAILED",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }
}

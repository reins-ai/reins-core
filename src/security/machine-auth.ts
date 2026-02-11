import { randomBytes, timingSafeEqual } from "node:crypto";

import { err, ok, type Result } from "../result";
import { createKeychainProvider, type KeychainProvider } from "./keychain-provider";
import { SecurityError } from "./security-error";

const TOKEN_PREFIX = "rm_";
const TOKEN_HEX_LENGTH = 64;
const TOKEN_REGEX = /^rm_[a-f0-9]{64}$/;

export const MACHINE_AUTH_SERVICE_NAME = "com.reins.daemon";
export const MACHINE_AUTH_ACCOUNT_NAME = "machine-secret";

export type MachineAuthAuditType =
  | "auth.bootstrap.created"
  | "auth.bootstrap.reused"
  | "auth.validation.accepted"
  | "auth.validation.rejected"
  | "auth.rotation.completed"
  | "auth.revocation.completed";

export interface MachineAuthAuditSignal {
  type: MachineAuthAuditType;
  timestamp: string;
  details?: Record<string, string>;
}

export interface MachineAuthServiceOptions {
  provider?: KeychainProvider;
  serviceName?: string;
  accountName?: string;
  tokenBytes?: number;
  now?: () => Date;
  onAuditSignal?: (signal: MachineAuthAuditSignal) => void;
}

export class MachineAuthService {
  private readonly provider: KeychainProvider;
  private readonly serviceName: string;
  private readonly accountName: string;
  private readonly tokenBytes: number;
  private readonly now: () => Date;
  private readonly onAuditSignal?: (signal: MachineAuthAuditSignal) => void;

  constructor(options: MachineAuthServiceOptions = {}) {
    this.provider = options.provider ?? createKeychainProvider();
    this.serviceName = options.serviceName ?? MACHINE_AUTH_SERVICE_NAME;
    this.accountName = options.accountName ?? MACHINE_AUTH_ACCOUNT_NAME;
    this.tokenBytes = options.tokenBytes ?? 32;
    this.now = options.now ?? (() => new Date());
    this.onAuditSignal = options.onAuditSignal;
  }

  public async bootstrap(): Promise<Result<string, SecurityError>> {
    const existingResult = await this.provider.get(this.serviceName, this.accountName);
    if (!existingResult.ok) {
      return existingResult;
    }

    if (existingResult.value && this.isTokenFormatValid(existingResult.value)) {
      this.emitAudit("auth.bootstrap.reused", { reason: "secret_exists" });
      return ok(existingResult.value);
    }

    const token = this.generateToken();
    const writeResult = await this.provider.set(this.serviceName, this.accountName, token);
    if (!writeResult.ok) {
      return writeResult;
    }

    this.emitAudit("auth.bootstrap.created", { tokenPrefix: TOKEN_PREFIX });
    return ok(token);
  }

  public async validate(token: string): Promise<Result<boolean, SecurityError>> {
    if (!this.isTokenFormatValid(token)) {
      this.emitAudit("auth.validation.rejected", { reason: "format_invalid" });
      return ok(false);
    }

    const storedResult = await this.provider.get(this.serviceName, this.accountName);
    if (!storedResult.ok) {
      return storedResult;
    }

    if (!storedResult.value || !this.isTokenFormatValid(storedResult.value)) {
      this.emitAudit("auth.validation.rejected", { reason: "secret_missing" });
      return ok(false);
    }

    const candidate = Buffer.from(token);
    const expected = Buffer.from(storedResult.value);
    if (candidate.byteLength !== expected.byteLength) {
      this.emitAudit("auth.validation.rejected", { reason: "length_mismatch" });
      return ok(false);
    }

    const valid = timingSafeEqual(candidate, expected);
    this.emitAudit(valid ? "auth.validation.accepted" : "auth.validation.rejected", {
      reason: valid ? "match" : "mismatch",
    });

    return ok(valid);
  }

  public async rotate(): Promise<Result<string, SecurityError>> {
    const token = this.generateToken();
    const writeResult = await this.provider.set(this.serviceName, this.accountName, token);
    if (!writeResult.ok) {
      return writeResult;
    }

    this.emitAudit("auth.rotation.completed");
    return ok(token);
  }

  public async revoke(): Promise<Result<void, SecurityError>> {
    const deleteResult = await this.provider.delete(this.serviceName, this.accountName);
    if (!deleteResult.ok) {
      return deleteResult;
    }

    this.emitAudit("auth.revocation.completed");
    return ok(undefined);
  }

  public async getToken(): Promise<Result<string, SecurityError>> {
    const storedResult = await this.provider.get(this.serviceName, this.accountName);
    if (!storedResult.ok) {
      return storedResult;
    }

    if (!storedResult.value) {
      return err(
        new SecurityError("Machine authentication token is not initialized", "MACHINE_AUTH_NOT_BOOTSTRAPPED"),
      );
    }

    if (!this.isTokenFormatValid(storedResult.value)) {
      return err(new SecurityError("Machine authentication token has invalid format", "MACHINE_AUTH_TOKEN_INVALID"));
    }

    return ok(storedResult.value);
  }

  private isTokenFormatValid(token: string): boolean {
    return token.length === TOKEN_PREFIX.length + TOKEN_HEX_LENGTH && TOKEN_REGEX.test(token);
  }

  private generateToken(): string {
    return `${TOKEN_PREFIX}${randomBytes(this.tokenBytes).toString("hex")}`;
  }

  private emitAudit(type: MachineAuthAuditType, details?: Record<string, string>): void {
    this.onAuditSignal?.({
      type,
      timestamp: this.now().toISOString(),
      details,
    });
  }
}

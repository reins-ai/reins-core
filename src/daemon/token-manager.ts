import { randomBytes } from "node:crypto";

import { ok, type Result } from "../result";
import type { KeychainProvider } from "../security/keychain-provider";
import { SecurityError } from "../security/security-error";

const KEYCHAIN_SERVICE = "reins.daemon";
const TOKEN_PREFIX = "rm_";
const TOKEN_BYTES = 32;
const TOKEN_REGEX = /^rm_[a-f0-9]{64}$/;

export interface TokenManagerOptions {
  keychain: KeychainProvider;
}

/**
 * Manages per-profile daemon auth tokens in the OS keychain.
 *
 * Tokens are stored under service "reins.daemon" with the profile name
 * (lowercased) as the account. Tokens follow the rm_ prefix format used
 * by MachineAuthService for consistency.
 */
export class DaemonTokenManager {
  private readonly keychain: KeychainProvider;

  constructor(options: TokenManagerOptions) {
    this.keychain = options.keychain;
  }

  /** Store a token for a daemon profile. */
  public async storeToken(
    profileName: string,
    token: string,
  ): Promise<Result<void, SecurityError>> {
    const account = this.normalizeProfileName(profileName);
    return this.keychain.set(KEYCHAIN_SERVICE, account, token);
  }

  /** Retrieve a token for a daemon profile. Returns null if not found. */
  public async getToken(
    profileName: string,
  ): Promise<Result<string | null, SecurityError>> {
    const account = this.normalizeProfileName(profileName);
    return this.keychain.get(KEYCHAIN_SERVICE, account);
  }

  /** Delete a token for a daemon profile. */
  public async deleteToken(
    profileName: string,
  ): Promise<Result<void, SecurityError>> {
    const account = this.normalizeProfileName(profileName);
    return this.keychain.delete(KEYCHAIN_SERVICE, account);
  }

  /** Rotate: generate new token, store it, return the new token. */
  public async rotateToken(
    profileName: string,
  ): Promise<Result<string, SecurityError>> {
    const token = this.generateToken();
    const storeResult = await this.storeToken(profileName, token);
    if (!storeResult.ok) {
      return storeResult;
    }
    return ok(token);
  }

  /** Check if a token exists for a profile without retrieving it. */
  public async hasToken(
    profileName: string,
  ): Promise<Result<boolean, SecurityError>> {
    const getResult = await this.getToken(profileName);
    if (!getResult.ok) {
      return getResult;
    }
    return ok(getResult.value !== null);
  }

  /** Validate that a token string matches the expected rm_ format. */
  public isValidTokenFormat(token: string): boolean {
    return TOKEN_REGEX.test(token);
  }

  private normalizeProfileName(profileName: string): string {
    return profileName.toLowerCase();
  }

  private generateToken(): string {
    return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("hex")}`;
  }
}

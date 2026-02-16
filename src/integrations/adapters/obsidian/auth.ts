/**
 * Obsidian integration auth handler.
 *
 * Validates that a local vault directory exists, is readable, and contains
 * at least one Markdown file. Stores a LocalPathCredential in the
 * CredentialVault on successful connection.
 */

import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { err, ok, type Result } from "../../../result";
import { IntegrationError } from "../../errors";
import type { CredentialVault, LocalPathCredential } from "../../credentials/types";
import type { IntegrationStatus, IntegrationStatusIndicator } from "../../types";
import { IntegrationState } from "../../types";

const INTEGRATION_ID = "obsidian";

export interface ObsidianAuthOptions {
  vault: CredentialVault;
}

/**
 * Validate that a directory exists and is readable.
 */
async function validateDirectoryAccess(vaultPath: string): Promise<Result<void, IntegrationError>> {
  try {
    await access(vaultPath, constants.R_OK);
  } catch {
    return err(
      new IntegrationError(
        `Vault path does not exist or is not readable: ${vaultPath}`,
      ),
    );
  }

  return ok(undefined);
}

/**
 * Validate that the directory contains at least one .md file (non-recursive top-level check).
 */
async function validateContainsMarkdown(vaultPath: string): Promise<Result<void, IntegrationError>> {
  let entries: string[];
  try {
    entries = await readdir(vaultPath);
  } catch {
    return err(
      new IntegrationError(
        `Unable to read vault directory: ${vaultPath}`,
      ),
    );
  }

  const hasMarkdown = entries.some((entry) => entry.endsWith(".md"));
  if (!hasMarkdown) {
    return err(
      new IntegrationError(
        `Vault directory does not contain any Markdown (.md) files: ${vaultPath}`,
      ),
    );
  }

  return ok(undefined);
}

/**
 * Full vault path validation: exists, readable, and contains .md files.
 */
export async function validateVaultPath(vaultPath: string): Promise<Result<void, IntegrationError>> {
  const trimmed = vaultPath.trim();
  if (trimmed.length === 0) {
    return err(new IntegrationError("Vault path must not be empty"));
  }

  const accessResult = await validateDirectoryAccess(trimmed);
  if (!accessResult.ok) {
    return accessResult;
  }

  const markdownResult = await validateContainsMarkdown(trimmed);
  if (!markdownResult.ok) {
    return markdownResult;
  }

  return ok(undefined);
}

/**
 * Obsidian auth handler managing the connect/disconnect/getStatus lifecycle
 * for a local vault path credential.
 */
export class ObsidianAuth {
  private readonly vault: CredentialVault;
  private state: IntegrationState;
  private lastError: string | undefined;

  constructor(options: ObsidianAuthOptions) {
    this.vault = options.vault;
    this.state = IntegrationState.INSTALLED;
    this.lastError = undefined;
  }

  /**
   * Validate the vault path and store a LocalPathCredential in the vault.
   */
  public async connect(vaultPath: string): Promise<Result<void, IntegrationError>> {
    const validationResult = await validateVaultPath(vaultPath);
    if (!validationResult.ok) {
      this.lastError = validationResult.error.message;
      this.state = IntegrationState.DISCONNECTED;
      return validationResult;
    }

    const credential: LocalPathCredential = {
      type: "local_path",
      path: vaultPath.trim(),
      validated: true,
    };

    const storeResult = await this.vault.store(INTEGRATION_ID, credential);
    if (!storeResult.ok) {
      this.lastError = storeResult.error.message;
      this.state = IntegrationState.DISCONNECTED;
      return storeResult;
    }

    this.lastError = undefined;
    this.state = IntegrationState.CONNECTED;
    return ok(undefined);
  }

  /**
   * Revoke the stored credential and reset state.
   */
  public async disconnect(): Promise<Result<void, IntegrationError>> {
    const revokeResult = await this.vault.revoke(INTEGRATION_ID);
    if (!revokeResult.ok) {
      this.lastError = revokeResult.error.message;
      return err(revokeResult.error);
    }

    this.lastError = undefined;
    this.state = IntegrationState.DISCONNECTED;
    return ok(undefined);
  }

  /**
   * Return the current connection status.
   */
  public getStatus(): IntegrationStatus {
    return {
      indicator: this.resolveIndicator(),
      state: this.state,
      lastError: this.lastError,
      updatedAt: new Date(),
    };
  }

  /**
   * Retrieve the stored vault path from the credential vault.
   * Returns null if no credential is stored.
   */
  public async getVaultPath(): Promise<Result<string | null, IntegrationError>> {
    const credentialResult = await this.vault.retrieve<LocalPathCredential>(INTEGRATION_ID);
    if (!credentialResult.ok) {
      return credentialResult;
    }

    if (!credentialResult.value) {
      return ok(null);
    }

    return ok(credentialResult.value.path);
  }

  private resolveIndicator(): IntegrationStatusIndicator {
    switch (this.state) {
      case IntegrationState.CONNECTED:
      case IntegrationState.ACTIVE:
        return "connected";
      case IntegrationState.SUSPENDED:
        return "suspended";
      case IntegrationState.DISCONNECTED:
        return this.lastError ? "error" : "disconnected";
      default:
        return "disconnected";
    }
  }
}

/**
 * Obsidian integration — local filesystem access to Obsidian vaults.
 *
 * Implements the Integration interface from the 5-file contract:
 * manifest.json + auth.ts + operations/index.ts + operation files + README.md
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../../../result";
import { IntegrationError } from "../../errors";
import { validateIntegrationManifest } from "../../manifest";
import type { CredentialVault } from "../../credentials/types";
import type {
  Integration,
  IntegrationConfig,
  IntegrationManifest,
  IntegrationOperation,
  IntegrationStatus,
} from "../../types";
import { ObsidianAuth } from "./auth";

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

let cachedManifest: IntegrationManifest | null = null;

/**
 * Load and validate the Obsidian manifest from the co-located JSON file.
 * The result is cached after the first successful load.
 */
export async function loadObsidianManifest(): Promise<Result<IntegrationManifest, IntegrationError>> {
  if (cachedManifest) {
    return ok(cachedManifest);
  }

  const manifestPath = join(import.meta.dir, "manifest.json");

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    return err(new IntegrationError(`Failed to read Obsidian manifest at ${manifestPath}`));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return err(new IntegrationError("Obsidian manifest contains invalid JSON"));
  }

  const validationResult = validateIntegrationManifest(parsed);
  if (!validationResult.valid) {
    return err(
      new IntegrationError(
        `Obsidian manifest validation failed: ${validationResult.errors.join("; ")}`,
      ),
    );
  }

  cachedManifest = validationResult.value;
  return ok(cachedManifest);
}

/**
 * Reset the cached manifest (useful for testing).
 */
export function resetManifestCacheForTests(): void {
  cachedManifest = null;
}

// ---------------------------------------------------------------------------
// Integration options
// ---------------------------------------------------------------------------

export interface ObsidianIntegrationOptions {
  vault: CredentialVault;
  manifest: IntegrationManifest;
  config?: Partial<IntegrationConfig>;
}

// ---------------------------------------------------------------------------
// Integration implementation
// ---------------------------------------------------------------------------

export class ObsidianIntegration implements Integration {
  public readonly config: IntegrationConfig;
  public readonly manifest: IntegrationManifest;

  private readonly auth: ObsidianAuth;

  constructor(options: ObsidianIntegrationOptions) {
    this.manifest = options.manifest;
    this.auth = new ObsidianAuth({ vault: options.vault });
    this.config = {
      id: options.manifest.id,
      enabled: options.config?.enabled ?? true,
      settings: options.config?.settings,
      authConfig: options.config?.authConfig,
    };
  }

  public async connect(): Promise<Result<void, IntegrationError>> {
    const vaultPath = this.resolveVaultPath();
    if (!vaultPath) {
      return err(
        new IntegrationError(
          "Vault path is required. Set it via config.settings.vaultPath or config.authConfig.vaultPath.",
        ),
      );
    }

    return this.auth.connect(vaultPath);
  }

  public async disconnect(): Promise<Result<void, IntegrationError>> {
    return this.auth.disconnect();
  }

  public getStatus(): IntegrationStatus {
    return this.auth.getStatus();
  }

  public getOperations(): IntegrationOperation[] {
    return this.manifest.operations;
  }

  public async execute(
    _operationName: string,
    _args: Record<string, unknown>,
  ): Promise<Result<unknown, IntegrationError>> {
    // Operations will be implemented in Task 4.2
    return err(
      new IntegrationError(
        "Obsidian operations are not yet implemented. See Task 4.2.",
      ),
    );
  }

  /**
   * Expose the auth handler for direct vault path retrieval by operations.
   */
  public getAuth(): ObsidianAuth {
    return this.auth;
  }

  private resolveVaultPath(): string | undefined {
    const fromSettings = this.config.settings?.["vaultPath"];
    if (typeof fromSettings === "string" && fromSettings.trim().length > 0) {
      return fromSettings.trim();
    }

    const fromAuth = this.config.authConfig?.["vaultPath"];
    if (typeof fromAuth === "string" && fromAuth.trim().length > 0) {
      return fromAuth.trim();
    }

    return undefined;
  }
}

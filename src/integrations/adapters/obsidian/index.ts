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
import { searchNotes } from "./operations/search-notes";
import { readNote } from "./operations/read-note";
import { createNote } from "./operations/create-note";
import { listNotes } from "./operations/list-notes";
import { connect as connectOperation } from "./operations/connect";
import { disconnect as disconnectOperation } from "./operations/disconnect";

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
    operationName: string,
    args: Record<string, unknown>,
  ): Promise<Result<unknown, IntegrationError>> {
    if (operationName === "connect") {
      return connectOperation(this.auth, {
        vault_path: String(args["vault_path"] ?? ""),
      });
    }

    if (operationName === "disconnect") {
      return disconnectOperation(this.auth);
    }

    const vaultPathResult = await this.auth.getVaultPath();
    if (!vaultPathResult.ok) {
      return vaultPathResult;
    }

    const vaultPath = vaultPathResult.value;
    if (!vaultPath) {
      return err(
        new IntegrationError(
          "Obsidian vault is not connected. To set up Obsidian:\n"
            + "1. Ask the user for their Obsidian vault path\n"
            + "2. Use the integration tool with action 'activate' and integration_id 'obsidian' to see available operations\n"
            + "3. Use action 'execute' with operation 'connect' and args { vault_path: '/absolute/path/to/vault' }\n"
            + "4. Then retry this operation",
        ),
      );
    }

    switch (operationName) {
      case "search-notes":
        return searchNotes(vaultPath, {
          query: String(args["query"] ?? ""),
          limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
        });

      case "read-note":
        return readNote(vaultPath, {
          path: String(args["path"] ?? ""),
        });

      case "create-note":
        return createNote(vaultPath, {
          title: String(args["title"] ?? ""),
          content: String(args["content"] ?? ""),
          folder: typeof args["folder"] === "string" ? args["folder"] : undefined,
        });

      case "list-notes":
        return listNotes(vaultPath, {
          folder: typeof args["folder"] === "string" ? args["folder"] : undefined,
          recursive: typeof args["recursive"] === "boolean" ? args["recursive"] : undefined,
        });

      default:
        return err(
          new IntegrationError(`Unknown Obsidian operation: ${operationName}`),
        );
    }
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

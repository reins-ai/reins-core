/**
 * Obsidian connect operation.
 *
 * Connects an Obsidian vault through the normal integration execute flow.
 * Validates the provided path, stores it in the credential vault via auth,
 * and returns a dual-channel IntegrationResult.
 */

import { err, ok, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatDetailResult, type IntegrationResult } from "../../../result";
import type { ObsidianAuth } from "../auth";

export interface ConnectParams {
  vault_path: string;
}

interface ConnectResult {
  connected: true;
  vault_path: string;
}

export async function connect(
  auth: ObsidianAuth,
  params: ConnectParams,
): Promise<Result<IntegrationResult<{ connected: true; path: string }, ConnectResult>, IntegrationError>> {
  const vaultPath = params.vault_path.trim();
  if (vaultPath.length === 0) {
    return err(new IntegrationError("'vault_path' is required and must not be empty"));
  }

  const connectResult = await auth.connect(vaultPath);
  if (!connectResult.ok) {
    return connectResult;
  }

  const result = formatDetailResult<ConnectResult, { connected: true; path: string }, ConnectResult>({
    entityName: "connection",
    item: {
      connected: true,
      vault_path: vaultPath,
    },
    toModel: (item) => ({
      connected: item.connected,
      path: item.vault_path,
    }),
    toUser: (item) => item,
    title: "Obsidian Connected",
    message: `Connected to Obsidian vault at ${vaultPath}`,
  });

  return ok(result);
}

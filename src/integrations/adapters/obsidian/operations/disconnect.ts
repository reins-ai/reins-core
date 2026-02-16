import { ok, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatDetailResult, type IntegrationResult } from "../../../result";
import type { ObsidianAuth } from "../auth";

interface DisconnectResult {
  connected: false;
}

export async function disconnect(
  auth: ObsidianAuth,
): Promise<Result<IntegrationResult<{ connected: false }, DisconnectResult>, IntegrationError>> {
  const disconnectResult = await auth.disconnect();
  if (!disconnectResult.ok) {
    return disconnectResult;
  }

  const result = formatDetailResult<DisconnectResult, { connected: false }, DisconnectResult>({
    entityName: "connection",
    item: {
      connected: false,
    },
    toModel: (item) => ({
      connected: item.connected,
    }),
    toUser: (item) => item,
    title: "Obsidian Disconnected",
    message: "Disconnected from Obsidian and cleared saved vault credentials.",
  });

  return ok(result);
}

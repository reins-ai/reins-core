import type { CommandContext, CommandHandler, CommandResult } from "../types";

/**
 * `/disconnect` command handler.
 *
 * With a provider name argument, revokes that provider's credentials directly.
 * Without arguments, shows a menu of currently connected providers so the
 * user can select one to disconnect.
 */
export const disconnectHandler: CommandHandler = async (
  context: CommandContext,
  args: string[],
): Promise<CommandResult> => {
  if (args.length === 0) {
    return showConnectedProviders(context);
  }

  return revokeProvider(context, args[0]);
};

/**
 * List connected providers as a selectable menu.
 */
async function showConnectedProviders(
  context: CommandContext,
): Promise<CommandResult> {
  let providers: Array<{
    provider: string;
    configured: boolean;
    connectionState: string;
    authModes: string[];
  }>;

  try {
    providers = await context.providerAuthService.listProviders();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      kind: "text",
      text: `Failed to list providers: ${message}`,
      success: false,
      error: "LIST_FAILED",
    };
  }

  const connected = providers.filter(
    (p) => p.configured && p.connectionState !== "disconnected",
  );

  if (connected.length === 0) {
    return {
      kind: "text",
      text: "No providers are currently connected.",
      success: true,
    };
  }

  return {
    kind: "menu",
    text: "Select a provider to disconnect:",
    items: connected.map((p) => ({
      id: `disconnect:${p.provider}`,
      label: p.provider,
      description: `Status: ${p.connectionState}`,
    })),
    success: true,
  };
}

/**
 * Revoke credentials for a specific provider by name.
 */
async function revokeProvider(
  context: CommandContext,
  providerName: string,
): Promise<CommandResult> {
  const normalized = providerName.toLowerCase();

  try {
    await context.providerAuthService.revokeProvider(normalized);
    return {
      kind: "text",
      text: `Disconnected **${normalized}**. Provider credentials revoked.`,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      kind: "text",
      text: `Failed to disconnect ${normalized}: ${message}`,
      success: false,
      error: "REVOKE_FAILED",
    };
  }
}

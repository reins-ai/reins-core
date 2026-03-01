import type { CommandContext, CommandHandler, CommandResult } from "../types";

/**
 * `/providers` command handler.
 *
 * Lists all registered providers with their connection status and
 * supported authentication modes. Cross-references the provider registry
 * with the auth service to show live connection state.
 */
export const providersHandler: CommandHandler = async (
  context: CommandContext,
  _args: string[],
): Promise<CommandResult> => {
  const registeredProviders = context.providerRegistry.list();

  if (registeredProviders.length === 0) {
    return {
      kind: "text",
      text: "No providers registered.",
      success: true,
    };
  }

  let authStatuses: Array<{
    provider: string;
    configured: boolean;
    connectionState: string;
    authModes: string[];
  }>;

  try {
    authStatuses = await context.providerAuthService.listProviders();
  } catch (_error) {
    // If auth service is unavailable, show providers without status
    authStatuses = [];
  }

  const statusByProvider = new Map(
    authStatuses.map((p) => [p.provider, p]),
  );

  const lines = registeredProviders.map((reg) => {
    const status = statusByProvider.get(reg.id);
    const connected = status?.configured
      ? "connected"
      : "not connected";
    const authMode = reg.authModes.join("/") || "none";
    return `• **${reg.name}** (${reg.id}) — ${connected} | auth: ${authMode}`;
  });

  return {
    kind: "text",
    text: `**Providers**\n\n${lines.join("\n")}`,
    success: true,
  };
};

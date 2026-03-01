import type {
  CommandContext,
  CommandHandler,
  CommandMenuItem,
  CommandResult,
  PendingCommandState,
  PendingCommandStep,
} from "../types";
import { PENDING_COMMAND_TTL_MS } from "../types";

const OAUTH_ONLY_PROVIDERS = new Set(["anthropic", "google"]);

const CONNECT_CALLBACK_PREFIX = "connect:";
const CONNECT_CANCEL_CALLBACK_ID = "connect:cancel";

/**
 * Check whether a pending command state has expired.
 */
function isPendingStateExpired(state: PendingCommandState): boolean {
  return Date.now() - state.createdAt > PENDING_COMMAND_TTL_MS;
}

function normalizeProviderName(providerName: string): string {
  return providerName.trim().toLowerCase();
}

/**
 * Build provider menu items for providers requiring authentication.
 */
async function buildProviderMenuItems(
  context: CommandContext,
): Promise<CommandMenuItem[]> {
  const registeredProviders = context.providerRegistry.list();
  const authProviders = registeredProviders.filter(
    (provider) => provider.requiresAuth,
  );

  let statuses: Array<{
    provider: string;
    configured: boolean;
    connectionState: string;
    authModes: string[];
  }>;

  try {
    statuses = await context.providerAuthService.listProviders();
  } catch (_error) {
    statuses = [];
  }

  const statusByProvider = new Map(
    statuses.map((status) => [status.provider, status]),
  );

  return authProviders.map((provider) => {
    const status = statusByProvider.get(provider.id);
    const isConnected =
      status?.configured && status.connectionState !== "disconnected";
    const authMode = provider.authModes.join("/") || "unknown";
    const statusText = isConnected ? "connected" : "not connected";

    return {
      id: `${CONNECT_CALLBACK_PREFIX}${provider.id}`,
      label: provider.name,
      description: `${statusText} | auth: ${authMode}`,
    };
  });
}

/**
 * /connect command handler.
 *
 * Without arguments, shows a menu of configurable providers.
 * With a provider argument, starts the flow directly for that provider.
 */
export const connectHandler: CommandHandler = async (
  context: CommandContext,
  args: string[],
): Promise<CommandResult> => {
  if (args.length > 0) {
    return startProviderFlow(normalizeProviderName(args[0]), context);
  }

  const providerItems = await buildProviderMenuItems(context);
  if (providerItems.length === 0) {
    return {
      kind: "text",
      text: "No configurable providers found.",
      success: true,
    };
  }

  return {
    kind: "menu",
    text: "Select a provider to connect:",
    items: [
      ...providerItems,
      {
        id: CONNECT_CANCEL_CALLBACK_ID,
        label: "Cancel",
        description: "Exit provider connection flow",
      },
    ],
    success: true,
  };
};

/**
 * Start the connection flow for a selected provider.
 */
async function startProviderFlow(
  providerName: string,
  _context: CommandContext,
): Promise<CommandResult> {
  const normalizedProvider = normalizeProviderName(providerName);

  if (!normalizedProvider) {
    return {
      kind: "text",
      text: "Please provide a provider name. Usage: `/connect <provider>`",
      success: false,
      error: "MISSING_PROVIDER",
    };
  }

  if (OAUTH_ONLY_PROVIDERS.has(normalizedProvider)) {
    const displayName =
      normalizedProvider.charAt(0).toUpperCase() +
      normalizedProvider.slice(1);

    return {
      kind: "text",
      text: [
        `**${displayName}** uses OAuth authentication, which requires a browser.`,
        "",
        "Please connect this provider from the Reins TUI or Desktop app.",
      ].join("\n"),
      success: true,
    };
  }

  return {
    kind: "text",
    text: [
      `Connecting to **${normalizedProvider}**...`,
      "",
      `Please reply with your API key for ${normalizedProvider}.`,
      "Your key message will be deleted after capture.",
    ].join("\n"),
    success: true,
  };
}

/**
 * Handle callback interactions from the /connect provider menu.
 */
export async function handleConnectCallback(
  callbackId: string,
  pendingState: PendingCommandState,
  context: CommandContext,
): Promise<CommandResult> {
  if (callbackId === CONNECT_CANCEL_CALLBACK_ID) {
    return {
      kind: "text",
      text: "Connection cancelled.",
      success: true,
    };
  }

  if (isPendingStateExpired(pendingState)) {
    return {
      kind: "text",
      text: "Session expired. Please run `/connect` again.",
      success: false,
      error: "SESSION_EXPIRED",
    };
  }

  const selectedProvider = callbackId.startsWith(CONNECT_CALLBACK_PREFIX)
    ? callbackId.slice(CONNECT_CALLBACK_PREFIX.length)
    : callbackId;
  return startProviderFlow(selectedProvider, context);
}

/**
 * Handle API key replies for the /connect flow.
 *
 * The returned result always includes `deleteUserMessage` when handling key input
 * so adapters can remove sensitive key content from channel history.
 */
export async function handleConnectReply(
  replyText: string,
  pendingState: PendingCommandState,
  context: CommandContext,
): Promise<CommandResult> {
  if (isPendingStateExpired(pendingState)) {
    return {
      kind: "text",
      text: "Session expired. Please run `/connect` again.",
      success: false,
      error: "SESSION_EXPIRED",
    };
  }

  const providerName = normalizeProviderName(
    pendingState.data.selectedProvider ?? "",
  );
  if (!providerName) {
    return {
      kind: "text",
      text: "Invalid state - no provider selected. Please run `/connect` again.",
      success: false,
      error: "INVALID_STATE",
    };
  }

  const apiKey = replyText.trim();
  if (apiKey.length === 0) {
    return {
      kind: "text",
      text: "API key cannot be empty. Please reply with your API key.",
      success: false,
      error: "EMPTY_KEY",
      flags: ["deleteUserMessage"],
    };
  }

  try {
    await context.providerAuthService.setApiKey(providerName, apiKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return {
      kind: "text",
      text: `Failed to store API key for ${providerName}: ${message}`,
      success: false,
      error: "STORE_FAILED",
      flags: ["deleteUserMessage"],
    };
  }

  let isValid = false;
  try {
    isValid = await context.providerAuthService.validateConnection(providerName);
  } catch (_error) {
    // Keep success path since key storage already succeeded.
  }

  const validationNote = isValid
    ? "Connection validated."
    : "Key stored. Run `/status` to verify connection.";

  return {
    kind: "text",
    text: [`Connected to **${providerName}**`, "", validationNote].join("\n"),
    success: true,
    flags: ["deleteUserMessage"],
  };
}

/**
 * Build a fresh pending command state for the /connect flow.
 */
export function buildConnectPendingState(
  step: PendingCommandStep,
  data: Record<string, string> = {},
): PendingCommandState {
  return {
    command: "connect",
    step,
    data,
    createdAt: Date.now(),
  };
}

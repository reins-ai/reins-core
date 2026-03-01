import type {
  CommandContext,
  CommandHandler,
  CommandMenuItem,
  CommandResult,
  PendingCommandState,
  PendingCommandStep,
} from "../types";
import { PENDING_COMMAND_TTL_MS } from "../types";

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
 *
 * For OAuth providers, attempts to generate an authorization URL. If successful,
 * the result carries `oauthPending` so the dispatcher can set `awaiting_auth_code`
 * pending state and route the user's code-paste reply here.
 *
 * Falls back to the API key flow for non-OAuth providers or when the service
 * does not implement `getOAuthAuthorizationUrl`.
 */
async function startProviderFlow(
  providerName: string,
  context: CommandContext,
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

  // Attempt OAuth URL flow when the service supports it.
  if (context.providerAuthService.getOAuthAuthorizationUrl) {
    let oauthResult: { url: string; state: string; codeVerifier?: string } | null = null;
    try {
      oauthResult = await context.providerAuthService.getOAuthAuthorizationUrl(normalizedProvider);
    } catch (_error) {
      // Non-fatal — fall through to API key flow.
    }

    if (oauthResult) {
      const displayName =
        normalizedProvider.charAt(0).toUpperCase() + normalizedProvider.slice(1);

      return {
        kind: "text",
        text: [
          `**${displayName}** uses OAuth. Tap the link below to authorize:`,
          "",
          oauthResult.url,
          "",
          "After authorizing, you will see a code on the page. Reply here with that code.",
        ].join("\n"),
        success: true,
        oauthPending: {
          provider: normalizedProvider,
          state: oauthResult.state,
          codeVerifier: oauthResult.codeVerifier,
        },
      };
    }
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
 * Handle the OAuth authorization code pasted by the user in response to the URL
 * sent during the `awaiting_auth_code` step.
 *
 * The returned result always includes `deleteUserMessage` so the pasted code is
 * removed from channel history.
 */
export async function handleOAuthCodeReply(
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
      flags: ["deleteUserMessage"],
    };
  }

  const providerName = normalizeProviderName(pendingState.data.selectedProvider ?? "");
  if (!providerName) {
    return {
      kind: "text",
      text: "Invalid state — no provider selected. Please run `/connect` again.",
      success: false,
      error: "INVALID_STATE",
      flags: ["deleteUserMessage"],
    };
  }

  if (!context.providerAuthService.completeOAuthWithCode) {
    return {
      kind: "text",
      text: "OAuth code exchange is not supported in this environment.",
      success: false,
      error: "UNSUPPORTED",
      flags: ["deleteUserMessage"],
    };
  }

  const code = replyText.trim();
  if (code.length === 0) {
    return {
      kind: "text",
      text: "Authorization code cannot be empty. Please paste the code shown after authorizing.",
      success: false,
      error: "EMPTY_CODE",
      flags: ["deleteUserMessage"],
    };
  }

  try {
    await context.providerAuthService.completeOAuthWithCode(
      providerName,
      code,
      pendingState.data.oauthState,
      pendingState.data.oauthCodeVerifier,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      kind: "text",
      text: `Failed to complete OAuth for ${providerName}: ${message}`,
      success: false,
      error: "EXCHANGE_FAILED",
      flags: ["deleteUserMessage"],
    };
  }

  let isValid = false;
  try {
    isValid = await context.providerAuthService.validateConnection(providerName);
  } catch (_error) {
    // Non-fatal — token storage already succeeded.
  }

  const validationNote = isValid
    ? "Connection validated."
    : "Authorization complete. Run `/status` to verify the connection.";

  return {
    kind: "text",
    text: [`Connected to **${providerName}** via OAuth.`, "", validationNote].join("\n"),
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

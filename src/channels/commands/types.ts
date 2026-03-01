import type { ChannelPlatform } from "../types";

/**
 * Side-effect flags that adapters execute after sending a command result.
 */
export type CommandResultFlag = "deleteUserMessage" | "ephemeral";

/**
 * Discriminator for all command result variants.
 */
export type CommandResultKind = "text" | "menu" | "confirmation";

/**
 * A selectable option rendered by platform adapters for menu results.
 */
export interface CommandMenuItem {
  id: string;
  label: string;
  description?: string;
}

/**
 * Plain text command output.
 */
export interface CommandResultText {
  kind: "text";
  text: string;
  success: boolean;
  error?: string;
  flags?: CommandResultFlag[];
}

/**
 * Interactive menu output rendered as platform-specific selection UI.
 */
export interface CommandResultMenu {
  kind: "menu";
  text: string;
  items: CommandMenuItem[];
  success: boolean;
  error?: string;
  flags?: CommandResultFlag[];
}

/**
 * Confirmation prompt output rendered as a yes/no interaction.
 */
export interface CommandResultConfirmation {
  kind: "confirmation";
  text: string;
  confirmId: string;
  cancelId: string;
  success: boolean;
  error?: string;
  flags?: CommandResultFlag[];
}

/**
 * Platform-agnostic command handler response contract.
 */
export type CommandResult =
  | CommandResultText
  | CommandResultMenu
  | CommandResultConfirmation;

/**
 * Parsed command payload extracted from an inbound channel message.
 */
export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}

/**
 * Minimal conversation service slice required by command handlers.
 */
export interface CommandConversationManager {
  create(options: {
    title?: string;
    model?: string;
    provider?: string;
  }): Promise<{ id: string }>;
  delete(conversationId: string): Promise<void>;
  list(options?: { limit?: number }): Promise<Array<{ id: string; title?: string }>>;
}

/**
 * Minimal provider registry slice required by command handlers.
 */
export interface CommandProviderRegistry {
  list(): Array<{
    id: string;
    name: string;
    requiresAuth: boolean;
    authModes: string[];
  }>;
}

/**
 * Provider authorization and credential management methods used by commands.
 */
export interface CommandProviderAuthService {
  isAuthorized?(channelId: string, senderId: string): Promise<boolean>;
  listProviders(): Promise<
    Array<{
      provider: string;
      configured: boolean;
      connectionState: string;
      authModes: string[];
    }>
  >;
  revokeProvider(provider: string): Promise<void>;
  setApiKey(provider: string, key: string): Promise<void>;
  validateConnection(provider: string): Promise<boolean>;
}

/**
 * Full execution context injected into each command handler.
 */
export interface CommandContext {
  senderId: string;
  senderName?: string;
  channelId: string;
  platform: ChannelPlatform;
  conversationId?: string;
  currentModel?: string;
  currentProvider?: string;
  conversationManager: CommandConversationManager;
  providerRegistry: CommandProviderRegistry;
  providerAuthService: CommandProviderAuthService;
  setModel(model: string): void;
  setProvider(provider: string): void;
  setConversationId(conversationId: string): void;
}

/**
 * Unified function contract implemented by all command handlers.
 */
export type CommandHandler = (
  context: CommandContext,
  args: string[],
) => Promise<CommandResult>;

/**
 * A registered command entry with metadata, handler, and optional aliases.
 */
export interface CommandDefinition {
  name: string;
  description: string;
  handler: CommandHandler;
  aliases?: string[];
}

/**
 * Steps used by pending multi-step command flows.
 */
export type PendingCommandStep =
  | "awaiting_provider_selection"
  | "awaiting_api_key"
  | "complete";

/**
 * In-memory pending command state used for multi-step interactions.
 */
export interface PendingCommandState {
  command: string;
  step: PendingCommandStep;
  data: Record<string, string>;
  createdAt: number;
}

/**
 * Time-to-live for pending command state in milliseconds.
 */
export const PENDING_COMMAND_TTL_MS = 5 * 60 * 1000;

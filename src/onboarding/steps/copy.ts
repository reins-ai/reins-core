import type { PersonalityPreset } from "../types";

/**
 * Personality-aware copy variants for onboarding steps.
 *
 * Each preset (balanced, concise, technical, warm) has its own tone.
 * Steps pull copy from here to keep handler logic clean and copy
 * easy to review in one place.
 */

export interface WelcomeCopy {
  /** Main greeting headline. */
  headline: string;
  /** Subtitle or tagline below the headline. */
  subtitle: string;
  /** Prompt text for the name input field. */
  namePrompt: string;
  /** Placeholder text inside the name input. */
  namePlaceholder: string;
  /** Label for the quickstart mode option. */
  quickstartLabel: string;
  /** Description of what quickstart mode does. */
  quickstartDescription: string;
  /** Label for the advanced mode option. */
  advancedLabel: string;
  /** Description of what advanced mode does. */
  advancedDescription: string;
}

const WELCOME_BALANCED: WelcomeCopy = {
  headline: "Welcome to Reins",
  subtitle: "Your personal AI assistant, ready when you are.",
  namePrompt: "What should I call you?",
  namePlaceholder: "Your name",
  quickstartLabel: "Quick Setup",
  quickstartDescription: "Get started in under a minute with sensible defaults.",
  advancedLabel: "Advanced Setup",
  advancedDescription: "Configure every detail to match your workflow.",
};

const WELCOME_CONCISE: WelcomeCopy = {
  headline: "Reins Setup",
  subtitle: "Let's get you up and running.",
  namePrompt: "Your name:",
  namePlaceholder: "Name",
  quickstartLabel: "Quick",
  quickstartDescription: "Defaults. Fast.",
  advancedLabel: "Advanced",
  advancedDescription: "Full control over every setting.",
};

const WELCOME_TECHNICAL: WelcomeCopy = {
  headline: "Reins Configuration",
  subtitle: "Initialize your assistant environment.",
  namePrompt: "Display name for greetings:",
  namePlaceholder: "Name",
  quickstartLabel: "Quick Setup",
  quickstartDescription: "Auto-configure with recommended defaults.",
  advancedLabel: "Advanced Setup",
  advancedDescription: "Manual configuration: daemon, providers, models, workspace, personality.",
};

const WELCOME_WARM: WelcomeCopy = {
  headline: "Hey there! Welcome to Reins",
  subtitle: "I'm excited to help you get set up. This will only take a moment!",
  namePrompt: "First things first — what's your name?",
  namePlaceholder: "Your name",
  quickstartLabel: "Quick Setup",
  quickstartDescription: "I'll pick great defaults so you can jump right in!",
  advancedLabel: "Advanced Setup",
  advancedDescription: "Take your time and customize everything to your liking.",
};

const WELCOME_COPY_MAP: Record<PersonalityPreset, WelcomeCopy> = {
  balanced: WELCOME_BALANCED,
  concise: WELCOME_CONCISE,
  technical: WELCOME_TECHNICAL,
  warm: WELCOME_WARM,
  custom: WELCOME_BALANCED,
};

/**
 * Get welcome step copy for a given personality preset.
 *
 * When a `personaName` is provided and differs from the default "Reins",
 * the headline is personalized to introduce the assistant by name
 * (e.g. "Hi! I'm Alex, your Reins assistant").
 *
 * Falls back to balanced copy for unknown or custom presets.
 */
export function getWelcomeCopy(
  preset: PersonalityPreset = "balanced",
  personaName?: string,
): WelcomeCopy {
  const baseCopy = WELCOME_COPY_MAP[preset] ?? WELCOME_BALANCED;

  if (!personaName || personaName === "Reins") {
    return baseCopy;
  }

  return {
    ...baseCopy,
    headline: `Hi! I'm ${personaName}, your Reins assistant`,
  };
}

/**
 * All available welcome copy variants, keyed by preset.
 * Useful for testing that every preset has complete copy.
 */
export const WELCOME_COPY_VARIANTS = WELCOME_COPY_MAP;

// ---------------------------------------------------------------------------
// Workspace step copy
// ---------------------------------------------------------------------------

export interface WorkspaceCopy {
  /** Short headline for the workspace step. */
  headline: string;
  /** One-sentence explanation of what a workspace is. */
  description: string;
  /** Explanation of why the workspace is useful. */
  benefit: string;
  /** Label shown next to the default path in quickstart mode. */
  defaultPathLabel: string;
  /** Prompt text asking the user to enter a custom path. */
  customPathPrompt: string;
  /** Placeholder text inside the custom path input. */
  customPathPlaceholder: string;
}

const WORKSPACE_BALANCED: WorkspaceCopy = {
  headline: "Your Workspace",
  description:
    "Reins keeps your notes, memory files, and HEARTBEAT.md in one folder called your workspace.",
  benefit: "Everything stays in one place, easy to find and back up.",
  defaultPathLabel: "Default location",
  customPathPrompt: "Where would you like to store your workspace?",
  customPathPlaceholder: "~/reins-workspace",
};

const WORKSPACE_CONCISE: WorkspaceCopy = {
  headline: "Workspace",
  description: "Folder for notes, memory, and HEARTBEAT.md.",
  benefit: "One place for everything.",
  defaultPathLabel: "Default",
  customPathPrompt: "Custom path:",
  customPathPlaceholder: "~/reins-workspace",
};

const WORKSPACE_TECHNICAL: WorkspaceCopy = {
  headline: "Workspace Directory",
  description:
    "Reins stores persistent data (notes, HEARTBEAT.md, memory index) in a local workspace directory.",
  benefit: "Centralised storage makes backups, version control, and inspection straightforward.",
  defaultPathLabel: "Default path",
  customPathPrompt: "Enter an absolute or home-relative path for the workspace directory:",
  customPathPlaceholder: "~/reins-workspace",
};

const WORKSPACE_WARM: WorkspaceCopy = {
  headline: "Let's Find a Home for Your Stuff",
  description:
    "I'll keep your notes, memories, and a little file called HEARTBEAT.md in a special folder — your workspace.",
  benefit: "It's all in one spot, so you can always find it (and back it up easily).",
  defaultPathLabel: "I'll use this folder",
  customPathPrompt: "Or pick a different spot if you'd like:",
  customPathPlaceholder: "~/reins-workspace",
};

const WORKSPACE_COPY_MAP: Record<PersonalityPreset, WorkspaceCopy> = {
  balanced: WORKSPACE_BALANCED,
  concise: WORKSPACE_CONCISE,
  technical: WORKSPACE_TECHNICAL,
  warm: WORKSPACE_WARM,
  custom: WORKSPACE_BALANCED,
};

/**
 * Get workspace step copy for a given personality preset.
 *
 * Falls back to balanced copy for unknown or custom presets.
 */
export function getWorkspaceCopy(preset: PersonalityPreset = "balanced"): WorkspaceCopy {
  return WORKSPACE_COPY_MAP[preset] ?? WORKSPACE_BALANCED;
}

/**
 * All available workspace copy variants, keyed by preset.
 * Useful for testing that every preset has complete copy.
 */
export const WORKSPACE_COPY_VARIANTS = WORKSPACE_COPY_MAP;

// ---------------------------------------------------------------------------
// Provider setup step copy
// ---------------------------------------------------------------------------

export interface ProviderSetupCopy {
  /** Headline for the provider setup step. */
  title: string;
  /** Prompt shown in quickstart mode for key entry. */
  quickstartPrompt: string;
  /** Hint explaining auto-detection below the key input. */
  quickstartHint: string;
  /** Prompt shown in advanced mode for provider selection. */
  advancedPrompt: string;
  /** Message shown when a provider is auto-detected from key prefix. */
  detectedMessage: (providerName: string) => string;
  /** Message shown when auto-detection fails and manual selection is needed. */
  fallbackMessage: string;
  /** Message shown while validating the key. */
  validatingMessage: string;
  /** Message shown when the user skips provider setup. */
  skipMessage: string;
}

const PROVIDER_BALANCED: ProviderSetupCopy = {
  title: "Connect your AI provider",
  quickstartPrompt: "Paste your API key to get started",
  quickstartHint: "We'll figure out which provider it belongs to automatically.",
  advancedPrompt: "Choose a provider and enter your API key",
  detectedMessage: (name) => `Got it — that's a ${name} key.`,
  fallbackMessage: "We couldn't detect the provider automatically. Please select one below.",
  validatingMessage: "Checking your key…",
  skipMessage: "You can add a provider key later in settings.",
};

const PROVIDER_CONCISE: ProviderSetupCopy = {
  title: "API key",
  quickstartPrompt: "Paste your key",
  quickstartHint: "Provider detected automatically.",
  advancedPrompt: "Select provider, then enter key",
  detectedMessage: (name) => `Detected: ${name}.`,
  fallbackMessage: "Provider not detected. Select manually.",
  validatingMessage: "Validating…",
  skipMessage: "Skip — configure later.",
};

const PROVIDER_TECHNICAL: ProviderSetupCopy = {
  title: "Provider API key configuration",
  quickstartPrompt: "Enter your API key (prefix-based detection)",
  quickstartHint: "Supported prefixes: sk-ant-*, sk-*, AIza*, fw-*",
  advancedPrompt: "Select a provider and enter your API key",
  detectedMessage: (name) => `Key prefix matched: ${name}.`,
  fallbackMessage: "No prefix match. Select provider manually.",
  validatingMessage: "Validating key…",
  skipMessage: "Skip — no provider configured.",
};

const PROVIDER_WARM: ProviderSetupCopy = {
  title: "Let's connect your AI provider!",
  quickstartPrompt: "Just paste your API key below — we'll handle the rest!",
  quickstartHint: "Don't worry, we'll figure out which provider it's for.",
  advancedPrompt: "Pick your favorite provider and pop in your key",
  detectedMessage: (name) => `Nice! That looks like a ${name} key.`,
  fallbackMessage: "Hmm, we couldn't tell which provider that is. Mind picking one?",
  validatingMessage: "Hang on, checking your key…",
  skipMessage: "No worries — you can always add one later!",
};

const PROVIDER_COPY_MAP: Record<PersonalityPreset, ProviderSetupCopy> = {
  balanced: PROVIDER_BALANCED,
  concise: PROVIDER_CONCISE,
  technical: PROVIDER_TECHNICAL,
  warm: PROVIDER_WARM,
  custom: PROVIDER_BALANCED,
};

/**
 * Get provider setup step copy for a given personality preset.
 *
 * Falls back to balanced copy for unknown or custom presets.
 */
export function getProviderSetupCopy(preset: PersonalityPreset = "balanced"): ProviderSetupCopy {
  return PROVIDER_COPY_MAP[preset] ?? PROVIDER_BALANCED;
}

/**
 * All available provider setup copy variants, keyed by preset.
 * Useful for testing that every preset has complete copy.
 */
export const PROVIDER_COPY_VARIANTS = PROVIDER_COPY_MAP;

// ---------------------------------------------------------------------------
// Daemon-install step copy
// ---------------------------------------------------------------------------

export interface DaemonInstallCopy {
  /** Short headline for the daemon install step. */
  headline: string;
  /** Plain-language explanation of what the daemon does. */
  description: string;
  /** Why the daemon is useful. */
  benefit: string;
  /** Status message when the daemon is already running. */
  alreadyRunningMessage: string;
  /** Status message when the daemon is being installed. */
  installingMessage: string;
  /** Status message when the daemon was installed successfully. */
  installedMessage: string;
  /** Status message when the daemon needs manual setup. */
  manualInstallMessage: string;
  /** Label shown next to the default install path in advanced mode. */
  defaultPathLabel: string;
  /** Prompt text asking the user to choose a custom install location. */
  customPathPrompt: string;
}

const DAEMON_INSTALL_BALANCED: DaemonInstallCopy = {
  headline: "Background Assistant",
  description:
    "Reins runs a small background service that handles scheduled tasks, delivers briefings, and keeps things running while you're away.",
  benefit: "You'll get morning briefings, reminders, and background task results — even when the app is closed.",
  alreadyRunningMessage: "Your background service is already running. Nothing to do here!",
  installingMessage: "Setting up the background service…",
  installedMessage: "Background service is up and running.",
  manualInstallMessage: "The background service needs to be started manually. Run `reins-daemon` in a terminal.",
  defaultPathLabel: "Default install location",
  customPathPrompt: "Where would you like to install the background service?",
};

const DAEMON_INSTALL_CONCISE: DaemonInstallCopy = {
  headline: "Background Service",
  description: "Runs scheduled tasks and delivers results when the app is closed.",
  benefit: "Briefings, reminders, and background tasks keep working.",
  alreadyRunningMessage: "Already running.",
  installingMessage: "Installing…",
  installedMessage: "Running.",
  manualInstallMessage: "Start manually: `reins-daemon`.",
  defaultPathLabel: "Default",
  customPathPrompt: "Install path:",
};

const DAEMON_INSTALL_TECHNICAL: DaemonInstallCopy = {
  headline: "Daemon Service",
  description:
    "The Reins daemon is a background process that runs the cron scheduler, executes background tasks via AgentLoop workers, and delivers results over WebSocket.",
  benefit: "Enables proactive features: morning briefings, heartbeat routines, nudge evaluation, and async task execution.",
  alreadyRunningMessage: "Daemon is healthy (localhost:7433).",
  installingMessage: "Installing system service…",
  installedMessage: "Daemon installed and health check passed.",
  manualInstallMessage: "No service installer available. Start the daemon manually: `bun run reins-daemon`.",
  defaultPathLabel: "Default service path",
  customPathPrompt: "Enter a custom service installation path:",
};

const DAEMON_INSTALL_WARM: DaemonInstallCopy = {
  headline: "Your Personal Assistant, Always On",
  description:
    "I'll set up a small helper that runs quietly in the background — it handles your scheduled tasks, sends you morning briefings, and works on things while you're away.",
  benefit: "Think of it as having an assistant who never sleeps! You'll get updates and results whenever you're ready.",
  alreadyRunningMessage: "Great news — your background helper is already running!",
  installingMessage: "Setting things up for you…",
  installedMessage: "All set! Your background helper is ready to go.",
  manualInstallMessage: "I wasn't able to set this up automatically. You can start it yourself by running `reins-daemon` in a terminal.",
  defaultPathLabel: "I'll put it here",
  customPathPrompt: "Want to pick a different spot? Enter a path:",
};

const DAEMON_INSTALL_COPY_MAP: Record<PersonalityPreset, DaemonInstallCopy> = {
  balanced: DAEMON_INSTALL_BALANCED,
  concise: DAEMON_INSTALL_CONCISE,
  technical: DAEMON_INSTALL_TECHNICAL,
  warm: DAEMON_INSTALL_WARM,
  custom: DAEMON_INSTALL_BALANCED,
};

/**
 * Get daemon-install step copy for a given personality preset.
 *
 * Falls back to balanced copy for unknown or custom presets.
 */
export function getDaemonInstallCopy(preset: PersonalityPreset = "balanced"): DaemonInstallCopy {
  return DAEMON_INSTALL_COPY_MAP[preset] ?? DAEMON_INSTALL_BALANCED;
}

/**
 * All available daemon-install copy variants, keyed by preset.
 * Useful for testing that every preset has complete copy.
 */
export const DAEMON_INSTALL_COPY_VARIANTS = DAEMON_INSTALL_COPY_MAP;

// ---------------------------------------------------------------------------
// Model-selection step copy
// ---------------------------------------------------------------------------

export interface ModelSelectionCopy {
  /** Short headline for the model selection step. */
  headline: string;
  /** Plain-language explanation of what model selection means. */
  description: string;
  /** Message shown when a model is auto-selected in quickstart. */
  autoSelectedMessage: string;
  /** Prompt text for choosing a model in advanced mode. */
  selectionPrompt: string;
  /** Message shown when no models are available. */
  noModelsMessage: string;
}

const MODEL_SELECTION_BALANCED: ModelSelectionCopy = {
  headline: "Choose Your AI Model",
  description:
    "Pick the AI model that powers your assistant. Different models have different strengths — some are faster, some are more capable.",
  autoSelectedMessage: "We've picked a great default model for you.",
  selectionPrompt: "Which model would you like to use?",
  noModelsMessage: "No models available yet. You can configure one later in settings.",
};

const MODEL_SELECTION_CONCISE: ModelSelectionCopy = {
  headline: "Model",
  description: "Select the AI model for your assistant.",
  autoSelectedMessage: "Default model selected.",
  selectionPrompt: "Choose a model:",
  noModelsMessage: "No models available.",
};

const MODEL_SELECTION_TECHNICAL: ModelSelectionCopy = {
  headline: "Model Configuration",
  description:
    "Select the primary LLM for chat and agent tasks. Model routing can be configured later for per-capability overrides.",
  autoSelectedMessage: "Auto-selected the first available model from your configured provider.",
  selectionPrompt: "Select a model from the available providers:",
  noModelsMessage: "No models found. Ensure at least one provider is configured with a valid API key.",
};

const MODEL_SELECTION_WARM: ModelSelectionCopy = {
  headline: "Pick Your AI Brain",
  description:
    "This is the AI model that'll power our conversations. Don't worry — you can always switch later!",
  autoSelectedMessage: "I've picked a great model for you — you can change it anytime.",
  selectionPrompt: "Here are the available models — pick the one that sounds right for you:",
  noModelsMessage: "Hmm, no models available yet. We can set one up later — no worries!",
};

const MODEL_SELECTION_COPY_MAP: Record<PersonalityPreset, ModelSelectionCopy> = {
  balanced: MODEL_SELECTION_BALANCED,
  concise: MODEL_SELECTION_CONCISE,
  technical: MODEL_SELECTION_TECHNICAL,
  warm: MODEL_SELECTION_WARM,
  custom: MODEL_SELECTION_BALANCED,
};

/**
 * Get model-selection step copy for a given personality preset.
 *
 * Falls back to balanced copy for unknown or custom presets.
 */
export function getModelSelectionCopy(preset: PersonalityPreset = "balanced"): ModelSelectionCopy {
  return MODEL_SELECTION_COPY_MAP[preset] ?? MODEL_SELECTION_BALANCED;
}

/**
 * All available model-selection copy variants, keyed by preset.
 * Useful for testing that every preset has complete copy.
 */
export const MODEL_SELECTION_COPY_VARIANTS = MODEL_SELECTION_COPY_MAP;

// ---------------------------------------------------------------------------
// Friendly model name mapping
// ---------------------------------------------------------------------------

/**
 * Maps raw model IDs to human-friendly display names.
 *
 * Used by the model selection step to present models with readable
 * names instead of raw API identifiers. Unknown IDs are cleaned up
 * heuristically (dashes to spaces, title-cased).
 */
const FRIENDLY_MODEL_NAMES: Record<string, string> = {
  // Anthropic
  "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
  "claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
  "claude-sonnet-4-20250514": "Claude Sonnet 4",
  "claude-3-opus-20240229": "Claude 3 Opus",
  "claude-3-haiku-20240307": "Claude 3 Haiku",
  // OpenAI
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-4-turbo": "GPT-4 Turbo",
  "gpt-4": "GPT-4",
  "gpt-3.5-turbo": "GPT-3.5 Turbo",
  "o1": "o1",
  "o1-mini": "o1 Mini",
  "o1-preview": "o1 Preview",
  "o3-mini": "o3 Mini",
  // Google
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.0-flash": "Gemini 2.0 Flash",
  "gemini-1.5-pro": "Gemini 1.5 Pro",
  "gemini-1.5-flash": "Gemini 1.5 Flash",
  // Fireworks
  "accounts/fireworks/models/llama-v3p1-405b-instruct": "Llama 3.1 405B",
  "accounts/fireworks/models/llama-v3p1-70b-instruct": "Llama 3.1 70B",
  "accounts/fireworks/models/mixtral-8x22b-instruct": "Mixtral 8x22B",
};

/**
 * Get a human-friendly display name for a model ID.
 *
 * Looks up the ID in the known model name map. If not found,
 * applies heuristic cleanup: strips common prefixes, replaces
 * dashes with spaces, and title-cases the result.
 */
export function getFriendlyModelName(modelId: string): string {
  const known = FRIENDLY_MODEL_NAMES[modelId];
  if (known) return known;

  // Heuristic: strip common prefixes and clean up
  let cleaned = modelId;

  // Strip "accounts/fireworks/models/" or similar path prefixes
  const lastSlash = cleaned.lastIndexOf("/");
  if (lastSlash !== -1) {
    cleaned = cleaned.slice(lastSlash + 1);
  }

  // Strip date suffixes like "-20241022"
  cleaned = cleaned.replace(/-\d{8}$/, "");

  // Replace dashes with spaces and title-case
  return cleaned
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * All known friendly model name mappings.
 * Useful for testing coverage of known models.
 */
export const FRIENDLY_MODEL_NAME_MAP = FRIENDLY_MODEL_NAMES;

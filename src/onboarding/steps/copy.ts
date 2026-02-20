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
 * Falls back to balanced copy for unknown or custom presets.
 */
export function getWelcomeCopy(preset: PersonalityPreset = "balanced"): WelcomeCopy {
  return WELCOME_COPY_MAP[preset] ?? WELCOME_BALANCED;
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

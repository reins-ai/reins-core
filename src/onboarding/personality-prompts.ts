import type { PersonalityPreset } from "./types";

/**
 * Definition of a personality preset with its display metadata
 * and system prompt modifier string.
 */
export interface PersonalityPromptDefinition {
  /** Preset identifier matching PersonalityPreset type. */
  preset: PersonalityPreset;
  /** Human-readable label for display. */
  label: string;
  /** Short description of the personality style. */
  description: string;
  /** System prompt modifier applied when this preset is active. */
  systemPromptModifier: string;
}

/**
 * Rich card data for presenting personality presets in the onboarding UI.
 *
 * Each card includes visual metadata (emoji, description, example response)
 * so the TUI can render selectable personality cards without hardcoding
 * display logic.
 */
export interface PersonalityCardData {
  /** Preset identifier matching PersonalityPreset type. */
  preset: PersonalityPreset;
  /** Human-readable label for display. */
  label: string;
  /** Emoji icon representing the personality style. */
  emoji: string;
  /** Short description of the personality style. */
  description: string;
  /** Example response demonstrating the personality tone. */
  exampleResponse: string;
}

/**
 * Built-in personality presets with their system prompt modifiers.
 *
 * Each preset produces a distinct modifier string that can be passed
 * to SystemPromptBuilder via additionalInstructions or the PERSONALITY
 * environment document.
 */
export const PERSONALITY_PRESETS: ReadonlyArray<PersonalityPromptDefinition> = [
  {
    preset: "balanced",
    label: "Balanced",
    description: "Neutral, professional tone. Clear and helpful.",
    systemPromptModifier:
      "Respond in a balanced, professional tone. Be clear and helpful without being overly formal or casual.",
  },
  {
    preset: "concise",
    label: "Concise",
    description: "Brief, to-the-point responses.",
    systemPromptModifier:
      "Keep responses brief and to the point. Avoid unnecessary elaboration. Use short sentences and bullet points when appropriate.",
  },
  {
    preset: "technical",
    label: "Technical",
    description: "Detailed, technical explanations.",
    systemPromptModifier:
      "Provide detailed technical explanations. Include code examples, specifications, and precise terminology. Assume technical competence.",
  },
  {
    preset: "warm",
    label: "Warm",
    description: "Friendly, conversational tone.",
    systemPromptModifier:
      "Use a warm, friendly, and conversational tone. Be encouraging and supportive. Make interactions feel natural and approachable.",
  },
];

/**
 * Rich card data for each personality preset.
 *
 * Used by the onboarding personality step to present presets as
 * visual cards with emoji, description, and an example response
 * that demonstrates the tone.
 */
export const PERSONALITY_CARDS: ReadonlyArray<PersonalityCardData> = [
  {
    preset: "balanced",
    label: "Balanced",
    emoji: "\u2696\uFE0F",
    description:
      "Clear, professional, and helpful. A good fit for most people.",
    exampleResponse:
      "Here\u2019s a summary of your schedule for today. You have 3 meetings and a deadline at 5 PM.",
  },
  {
    preset: "concise",
    label: "Concise",
    emoji: "\u26A1",
    description:
      "Short and to the point. No fluff, just answers.",
    exampleResponse:
      "3 meetings today. Deadline at 5 PM.",
  },
  {
    preset: "technical",
    label: "Technical",
    emoji: "\uD83D\uDD27",
    description:
      "Detailed and precise. Assumes you know your stuff.",
    exampleResponse:
      "Today\u2019s schedule: 3 calendar events (2 syncs, 1 standup). Task queue has 1 item due at 17:00 UTC.",
  },
  {
    preset: "warm",
    label: "Warm",
    emoji: "\u2615",
    description:
      "Friendly and encouraging. Like chatting with a helpful friend.",
    exampleResponse:
      "Good morning! You\u2019ve got a pretty manageable day ahead \u2014 3 meetings and one deadline this evening. You\u2019ve got this!",
  },
];

/**
 * Look up the system prompt modifier for a given personality preset.
 *
 * Returns `null` for the "custom" preset (which uses user-provided text)
 * or if the preset is not found.
 */
export function getPresetPromptModifier(preset: PersonalityPreset): string | null {
  if (preset === "custom") return null;
  const definition = PERSONALITY_PRESETS.find((p) => p.preset === preset);
  return definition?.systemPromptModifier ?? null;
}

/**
 * Look up the card data for a given personality preset.
 *
 * Returns `undefined` if the preset is not found or is "custom".
 */
export function getPresetCard(preset: PersonalityPreset): PersonalityCardData | undefined {
  if (preset === "custom") return undefined;
  return PERSONALITY_CARDS.find((c) => c.preset === preset);
}

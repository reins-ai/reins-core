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

import type { CommandContext, CommandHandler, CommandResult } from "../types";

/**
 * Infer the provider ID from a model name prefix.
 *
 * Uses well-known model name prefixes to map to provider identifiers.
 * Returns `undefined` when the provider cannot be determined.
 */
function inferProviderFromModel(model: string): string | undefined {
  const lower = model.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (
    lower.startsWith("gpt") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  ) {
    return "openai";
  }
  if (lower.startsWith("gemini")) return "google";
  if (
    lower.startsWith("llama") ||
    lower.startsWith("mixtral") ||
    lower.startsWith("qwen")
  ) {
    return "fireworks";
  }
  return undefined;
}

/**
 * `/model` command handler.
 *
 * Without arguments, displays the current active model and provider.
 * With a model name argument, switches to the specified model and
 * attempts to infer the provider from the model name prefix.
 */
export const modelHandler: CommandHandler = async (
  context: CommandContext,
  args: string[],
): Promise<CommandResult> => {
  // No args — show current model
  if (args.length === 0) {
    const model = context.currentModel ?? "not set";
    const provider = context.currentProvider ?? "not set";
    return {
      kind: "text",
      text: `Current model: **${model}** (provider: ${provider})`,
      success: true,
    };
  }

  // Switch model
  const newModel = args[0];
  if (!newModel || newModel.trim().length === 0) {
    return {
      kind: "text",
      text: "Please provide a model name. Usage: `/model <model-name>`",
      success: false,
      error: "MISSING_MODEL_NAME",
    };
  }

  const trimmedModel = newModel.trim();
  const inferredProvider = inferProviderFromModel(trimmedModel);

  context.setModel(trimmedModel);
  if (inferredProvider) {
    context.setProvider(inferredProvider);
  }

  const providerNote = inferredProvider
    ? ` (provider: ${inferredProvider})`
    : "";

  return {
    kind: "text",
    text: `Switched to model **${trimmedModel}**${providerNote}`,
    success: true,
  };
};

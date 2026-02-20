import type { Provider } from "../types/provider";
import type { SubAgentResult } from "./sub-agent-pool";

const DEFAULT_SEPARATOR = "\n\n---\n\n";
const DEFAULT_SYNTHESIZE_PROMPT = "Synthesize the following outputs into a single coherent response:";
const ALL_FAILED_MESSAGE = "All tasks failed to produce output.";

export type MergeStrategy = "concat" | "synthesize" | "first";

export interface MergeOptions {
  separator?: string;
  synthesizePrompt?: string;
  provider?: Provider;
  model?: string;
}

export class SubAgentResultMerger {
  concat(results: SubAgentResult[], options: MergeOptions = {}): string {
    if (results.length === 0) {
      return "";
    }

    const outputs = getSuccessfulOutputs(results);
    if (outputs.length === 0) {
      return ALL_FAILED_MESSAGE;
    }

    return outputs.join(options.separator ?? DEFAULT_SEPARATOR);
  }

  async synthesize(
    results: SubAgentResult[],
    options: MergeOptions & { provider: Provider },
  ): Promise<string> {
    if (results.length === 0) {
      return "";
    }

    const outputs = getSuccessfulOutputs(results);
    if (outputs.length === 0) {
      return ALL_FAILED_MESSAGE;
    }

    const model = options.model ?? await this.resolveModel(options.provider);
    if (!model) {
      return this.concat(results, options);
    }

    const mergedOutput = outputs.join(options.separator ?? DEFAULT_SEPARATOR);
    try {
      const response = await options.provider.chat({
        model,
        systemPrompt: options.synthesizePrompt ?? DEFAULT_SYNTHESIZE_PROMPT,
        messages: [
          {
            id: "sub-agent-merge-user",
            role: "user",
            content: mergedOutput,
            createdAt: new Date(),
          },
        ],
      });

      if (response.content.trim().length === 0) {
        return this.concat(results, options);
      }

      return response.content;
    } catch {
      return this.concat(results, options);
    }
  }

  first(results: SubAgentResult[]): string {
    if (results.length === 0) {
      return "";
    }

    for (const result of results) {
      if (result.error === undefined && typeof result.output === "string" && result.output.trim().length > 0) {
        return result.output;
      }
    }

    return ALL_FAILED_MESSAGE;
  }

  async merge(strategy: MergeStrategy, results: SubAgentResult[], options: MergeOptions = {}): Promise<string> {
    if (strategy === "concat") {
      return this.concat(results, options);
    }

    if (strategy === "first") {
      return this.first(results);
    }

    if (!options.provider) {
      return this.concat(results, options);
    }

    return this.synthesize(results, {
      ...options,
      provider: options.provider,
    });
  }

  private async resolveModel(provider: Provider): Promise<string | undefined> {
    try {
      const models = await provider.listModels();
      return models[0]?.id;
    } catch {
      return undefined;
    }
  }
}

function getSuccessfulOutputs(results: SubAgentResult[]): string[] {
  return results
    .filter((result) => result.error === undefined && typeof result.output === "string")
    .map((result) => result.output?.trim() ?? "")
    .filter((output) => output.length > 0);
}

import { err, ok, type Result } from "../result";
import type {
  EnvironmentDocument,
  EnvironmentDocumentMap,
  OverlayResolution,
} from "../environment/types";
import type { EnvironmentSwitchService } from "../environment/switch-service";
import type { BuildOptions, SystemPromptBuilder } from "./builder";
import type { Persona } from "./persona";

type EnvironmentResolver = Pick<EnvironmentSwitchService, "getResolvedDocuments">;

export class EnvironmentContextProvider {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly environmentResolver: EnvironmentResolver,
    private readonly promptBuilder: SystemPromptBuilder,
    switchService?: Pick<EnvironmentSwitchService, "onEnvironmentSwitch">,
  ) {
    switchService?.onEnvironmentSwitch(() => {
      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  async buildEnvironmentPrompt(
    persona: Persona,
    options: Partial<BuildOptions> = {},
  ): Promise<Result<string, Error>> {
    const resolutionResult = await this.environmentResolver.getResolvedDocuments();
    if (!resolutionResult.ok) {
      return err(resolutionResult.error);
    }

    const environmentDocuments = this.toEnvironmentDocumentMap(resolutionResult.value);
    const systemPrompt = this.promptBuilder.build({
      ...options,
      persona,
      environmentDocuments,
    });

    return ok(systemPrompt);
  }

  onEnvironmentSwitch(callback: () => void): () => void {
    this.listeners.add(callback);

    return () => {
      this.listeners.delete(callback);
    };
  }

  private toEnvironmentDocumentMap(resolution: OverlayResolution): EnvironmentDocumentMap {
    const map: EnvironmentDocumentMap = {};

    for (const [documentType, document] of Object.entries(resolution.documents)) {
      map[documentType as EnvironmentDocument] = document.document.content;
    }

    return map;
  }
}

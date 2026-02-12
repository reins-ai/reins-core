import type { ToolDefinition } from "../types";
import type { Persona, ToolPermissionSet } from "./persona";

export interface BuildOptions {
  persona: Persona;
  availableTools?: ToolDefinition[];
  userContext?: string;
  additionalInstructions?: string[];
  currentDate?: Date;
}

export class SystemPromptBuilder {
  build(options: BuildOptions): string {
    const sections: string[] = [options.persona.systemPrompt.trim()];

    if (options.currentDate) {
      sections.push(this.buildDateSection(options.currentDate));
    }

    if (options.userContext) {
      sections.push(this.buildUserContextSection(options.userContext));
    }

    const toolsSection = this.buildToolsSection(options.persona, options.availableTools ?? []);
    if (toolsSection) {
      sections.push(toolsSection);
    }

    const additionalInstructions = options.additionalInstructions?.filter(
      (instruction) => instruction.trim().length > 0,
    );

    if (additionalInstructions && additionalInstructions.length > 0) {
      sections.push(this.buildAdditionalInstructionsSection(additionalInstructions));
    }

    return sections.join("\n\n");
  }

  private buildDateSection(currentDate: Date): string {
    return ["## Current Date and Time", currentDate.toISOString()].join("\n");
  }

  private buildUserContextSection(userContext: string): string {
    return ["## User Context", userContext.trim()].join("\n");
  }

  private buildToolsSection(persona: Persona, availableTools: ToolDefinition[]): string | undefined {
    if (availableTools.length === 0) {
      return undefined;
    }

    const permittedTools = availableTools.filter((tool) =>
      this.isToolPermitted(tool.name, persona.toolPermissions),
    );

    if (permittedTools.length === 0) {
      return undefined;
    }

    const lines = permittedTools.map((tool) => `- ${tool.name}: ${tool.description}`);
    return ["## Available Tools", ...lines].join("\n");
  }

  private buildAdditionalInstructionsSection(additionalInstructions: string[]): string {
    const lines = additionalInstructions.map((instruction) => `- ${instruction}`);
    return ["## Additional Instructions", ...lines].join("\n");
  }

  private isToolPermitted(toolName: string, permissions: ToolPermissionSet): boolean {
    if (permissions.mode === "all") {
      return true;
    }

    const tools = permissions.tools ?? [];

    if (permissions.mode === "allowlist") {
      return tools.includes(toolName);
    }

    return !tools.includes(toolName);
  }
}

import type { ToolDefinition } from "../types";
import type { EnvironmentDocumentMap } from "../environment/types";
import type { Persona, ToolPermissionSet } from "./persona";

export interface BuildOptions {
  persona: Persona;
  availableTools?: ToolDefinition[];
  userContext?: string;
  additionalInstructions?: string[];
  currentDate?: Date;
  environmentDocuments?: EnvironmentDocumentMap;
}

export class SystemPromptBuilder {
  build(options: BuildOptions): string {
    if (!options.environmentDocuments) {
      return this.buildLegacyPrompt(options);
    }

    const sections: string[] = [];

    const identitySection = this.buildIdentitySection(options.persona, options.environmentDocuments);
    if (identitySection) {
      sections.push(identitySection);
    }

    const boundariesSection = this.buildEnvironmentDocumentSection(
      "## Boundaries",
      options.environmentDocuments.BOUNDARIES,
    );
    if (boundariesSection) {
      sections.push(boundariesSection);
    }

    const userSection = this.buildEnvironmentDocumentSection(
      "## User Context",
      options.environmentDocuments.USER,
    );
    if (userSection) {
      sections.push(userSection);
    } else if (options.userContext) {
      sections.push(this.buildUserContextSection(options.userContext));
    }

    if (options.currentDate) {
      sections.push(this.buildDateSection(options.currentDate));
    }

    const toolsSection = this.buildToolsSection(options.persona, options.availableTools ?? []);
    if (toolsSection) {
      sections.push(toolsSection);
    }

    const dynamicContextSection = this.buildDynamicContextSection(options.environmentDocuments);
    if (dynamicContextSection) {
      sections.push(dynamicContextSection);
    }

    const additionalInstructions = options.additionalInstructions?.filter(
      (instruction) => instruction.trim().length > 0,
    );

    if (additionalInstructions && additionalInstructions.length > 0) {
      sections.push(this.buildAdditionalInstructionsSection(additionalInstructions));
    }

    return sections.join("\n\n");
  }

  private buildLegacyPrompt(options: BuildOptions): string {
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

  private buildIdentitySection(persona: Persona, environmentDocuments: EnvironmentDocumentMap): string {
    const personalityDocument = environmentDocuments.PERSONALITY?.trim();

    if (personalityDocument && personalityDocument.length > 0) {
      return ["## Identity", personalityDocument].join("\n");
    }

    return persona.systemPrompt.trim();
  }

  private buildEnvironmentDocumentSection(header: string, content?: string): string | undefined {
    const normalizedContent = content?.trim();

    if (!normalizedContent || normalizedContent.length === 0) {
      return undefined;
    }

    return [header, normalizedContent].join("\n");
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

  private buildDynamicContextSection(environmentDocuments: EnvironmentDocumentMap): string | undefined {
    const lines: string[] = [];

    if (environmentDocuments.HEARTBEAT?.trim()) {
      lines.push("- Heartbeat context loaded from HEARTBEAT.md");
    }

    if (environmentDocuments.ROUTINES?.trim()) {
      lines.push("- Routine context loaded from ROUTINES.md");
    }

    if (environmentDocuments.GOALS?.trim()) {
      lines.push("- Goals context loaded from GOALS.md");
    }

    if (environmentDocuments.KNOWLEDGE?.trim()) {
      lines.push("- Knowledge context available from KNOWLEDGE.md");
    }

    if (environmentDocuments.TOOLS?.trim()) {
      lines.push("- Tool preferences available from TOOLS.md");
    }

    if (lines.length === 0) {
      return undefined;
    }

    return ["## Dynamic Context", ...lines].join("\n");
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

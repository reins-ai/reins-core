import type { ToolDefinition } from "../types";
import { parseBoundariesPolicy } from "../environment/boundaries-policy";
import { parseToolsPolicy } from "../environment/tools-policy";
import type { EnvironmentDocumentMap } from "../environment/types";
import { formatSkillIndex } from "../skills/prompt-formatter";
import type { SkillSummary } from "../skills/types";
import type { Persona, ToolPermissionSet } from "./persona";
import { DEFAULT_SECTION_BUDGETS } from "./prompt-budgets";
import { truncateSection } from "./truncate";

export interface BuildOptions {
  persona: Persona;
  availableTools?: ToolDefinition[];
  skillSummaries?: SkillSummary[];
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

    const personalityDocument = this.readDocumentWithBudget(
      options.environmentDocuments,
      "PERSONALITY",
    );
    const boundariesDocument = this.readDocumentWithBudget(
      options.environmentDocuments,
      "BOUNDARIES",
    );
    const userDocument = this.readDocumentWithBudget(options.environmentDocuments, "USER");

    const identitySection = this.buildIdentitySection(options.persona, personalityDocument);
    if (identitySection) {
      sections.push(identitySection);
    }

    const boundariesSection = this.buildEnvironmentDocumentSection(
      "## Boundaries",
      boundariesDocument,
    );
    if (boundariesSection) {
      sections.push(boundariesSection);
    }

    const userSection = this.buildEnvironmentDocumentSection(
      "## User Context",
      userDocument,
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

    const skillIndexSection = this.buildSkillIndexSection(options.skillSummaries);
    if (skillIndexSection) {
      sections.push(skillIndexSection);
    }

    const memoryDocument = this.readDocumentWithBudget(
      options.environmentDocuments,
      "MEMORY",
    );
    const memorySection = this.buildEnvironmentDocumentSection(
      "## Current Memories",
      memoryDocument,
    );
    if (memorySection) {
      sections.push(memorySection);
    }

    const dynamicContextSection = this.buildDynamicContextSection(
      options.environmentDocuments,
      boundariesDocument,
    );
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

    const skillIndexSection = this.buildSkillIndexSection(options.skillSummaries);
    if (skillIndexSection) {
      sections.push(skillIndexSection);
    }

    const additionalInstructions = options.additionalInstructions?.filter(
      (instruction) => instruction.trim().length > 0,
    );

    if (additionalInstructions && additionalInstructions.length > 0) {
      sections.push(this.buildAdditionalInstructionsSection(additionalInstructions));
    }

    return sections.join("\n\n");
  }

  private buildIdentitySection(persona: Persona, personalityDocument?: string): string {
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

  private buildDynamicContextSection(
    environmentDocuments: EnvironmentDocumentMap,
    boundariesDocument?: string,
  ): string | undefined {
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
      lines.push(...this.buildToolPreferenceHints(environmentDocuments.TOOLS));
    }

    if (boundariesDocument?.trim()) {
      lines.push(...this.buildBoundaryHints(boundariesDocument));
    }

    if (lines.length === 0) {
      return undefined;
    }

    return ["## Dynamic Context", ...lines].join("\n");
  }

  private buildToolPreferenceHints(toolsDocument: string): string[] {
    const policy = parseToolsPolicy(toolsDocument);
    const lines: string[] = [];

    if (policy.enabled.length > 0) {
      lines.push(`- Enabled tools policy: ${policy.enabled.slice(0, 6).join(", ")}`);
    }

    if (policy.disabled.length > 0) {
      lines.push(`- Disabled tools policy: ${policy.disabled.slice(0, 6).join(", ")}`);
    }

    const aggressivenessHints = Object.entries(policy.aggressiveness)
      .filter(([toolName]) => toolName !== "default")
      .slice(0, 6)
      .map(([toolName, level]) => `${toolName}=${level}`);

    lines.push(`- Default tool aggressiveness: ${policy.aggressiveness.default}`);

    if (aggressivenessHints.length > 0) {
      lines.push(`- Tool aggressiveness hints: ${aggressivenessHints.join(", ")}`);
    }

    return lines;
  }

  private buildBoundaryHints(boundariesDocument: string): string[] {
    const policy = parseBoundariesPolicy(boundariesDocument);
    if (policy.willNotDo.length === 0) {
      return [];
    }

    return [
      `- Decline requests matching explicit will-not-do boundaries (${policy.willNotDo.length} loaded)`,
    ];
  }

  private readDocumentWithBudget(
    environmentDocuments: EnvironmentDocumentMap,
    documentType: keyof typeof DEFAULT_SECTION_BUDGETS,
  ): string | undefined {
    const raw = environmentDocuments[documentType]?.trim();
    if (!raw || raw.length === 0) {
      return undefined;
    }

    return truncateSection(raw, DEFAULT_SECTION_BUDGETS[documentType].maxChars);
  }

  private buildAdditionalInstructionsSection(additionalInstructions: string[]): string {
    const lines = additionalInstructions.map((instruction) => `- ${instruction}`);
    return ["## Additional Instructions", ...lines].join("\n");
  }

  private buildSkillIndexSection(skillSummaries?: SkillSummary[]): string | undefined {
    if (!skillSummaries || skillSummaries.length === 0) {
      return undefined;
    }

    const formatted = formatSkillIndex(skillSummaries);
    return formatted.length > 0 ? formatted : undefined;
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

import { join } from "node:path";

import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../types";

import { getIntegrationStatus, type IntegrationStatus } from "./integration-reader";
import { SkillMatcher } from "./matcher";
import type { SkillMetadata } from "./metadata";
import { readSkillMd } from "./parser";
import type { SkillRegistry } from "./registry";
import type { SkillScanner } from "./scanner";

export const SKILL_TOOL_DEFINITION: ToolDefinition = {
  name: "load_skill",
  description: "Load full skill content and metadata for an enabled skill by name.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name to load.",
      },
    },
    required: ["name"],
  },
};

type SkillToolResult = {
  name: string;
  body: string;
  metadata: SkillMetadata;
  scripts: string[];
  integrationStatus: IntegrationStatus;
};

export class SkillTool implements Tool {
  readonly definition: ToolDefinition = SKILL_TOOL_DEFINITION;
  private readonly matcher = new SkillMatcher();

  constructor(
    private readonly registry: SkillRegistry,
    private readonly scanner: SkillScanner,
  ) {}

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const callId = this.readString(args.callId) ?? "unknown-call";
    const name = this.readString(args.name);

    if (!name) {
      return this.errorResult(callId, "Missing or invalid 'name' argument.");
    }

    const skill = this.resolveSkill(name);
    if (!skill) {
      return this.errorResult(callId, `Skill not found: ${name}`);
    }

    if (!skill.config.enabled) {
      return this.errorResult(callId, `Skill is disabled: ${skill.config.name}`);
    }

    try {
      const content = this.scanner.loadSkill(skill.config.name)
        ?? await this.loadFromDisk(skill.config.path);

      if (!content) {
        return this.errorResult(
          callId,
          `Failed to load content for skill: ${skill.config.name}`,
        );
      }

      const result: SkillToolResult = {
        name: skill.config.name,
        body: content.body,
        metadata: content.metadata,
        scripts: [...skill.scriptFiles],
        integrationStatus: getIntegrationStatus(skill.hasIntegration),
      };

      return this.successResult(callId, result);
    } catch (error) {
      return this.errorResult(callId, this.formatError(error));
    }
  }

  private successResult(callId: string, result: SkillToolResult): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result,
    };
  }

  private errorResult(callId: string, error: string): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result: null,
      error,
    };
  }

  private readString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Skill tool execution failed.";
  }

  /**
   * Fallback for skills not in the scanner cache (e.g. installed after daemon
   * startup). Reads SKILL.md directly from the skill directory on disk.
   */
  private async loadFromDisk(
    skillPath: string,
  ): Promise<{ body: string; metadata: SkillMetadata } | undefined> {
    const result = await readSkillMd(join(skillPath, "SKILL.md"));
    if (!result.ok) {
      return undefined;
    }
    return { body: result.value.body, metadata: result.value.metadata };
  }

  private resolveSkill(name: string) {
    const exactMatch = this.registry.get(name);
    if (exactMatch) {
      return exactMatch;
    }

    const matches = this.matcher.match(name, this.registry.listEnabled());
    if (matches.length === 1) {
      return matches[0]?.skill;
    }

    return undefined;
  }
}

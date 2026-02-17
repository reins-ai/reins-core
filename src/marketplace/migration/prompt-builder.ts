import { err, ok, type Result } from "../../result";
import { MARKETPLACE_ERROR_CODES, MarketplaceError } from "../errors";
import { MIGRATION_RULES } from "./mapping-rules";

interface ParsedLlmResponse {
  skillMd: string;
  integrationMd: string | null;
}

function renderMappingTable(): string {
  const rows = MIGRATION_RULES.map((rule) => `| \`${rule.source}\` | \`${rule.target}\` |`);

  return [
    "| OpenClaw Field | Reins Field |",
    "|---|---|",
    ...rows,
  ].join("\n");
}

export class MigrationPromptBuilder {
  buildPrompt(openClawContent: string): string {
    const mappingTable = renderMappingTable();

    return [
      "You are migrating an OpenClaw SKILL.md file into Reins format.",
      "",
      "## Goal",
      "Convert the provided OpenClaw skill to a valid Reins skill package output.",
      "",
      "## Reins SKILL.md requirements",
      "- YAML frontmatter followed by markdown body",
      "- Include: name, description, version, author",
      "- Include trust and runtime metadata where available: trustLevel, requiredTools, platforms, config.envVars, categories",
      "- Preserve emoji and homepage when available",
      "- Keep body content semantically equivalent and suitable for Reins runtime",
      "",
      "## Field mapping rules",
      mappingTable,
      "",
      "Alias rule: treat metadata.clawdbot and metadata.clawdis as metadata.openclaw before mapping.",
      "",
      "## Preservation rules",
      "- Any metadata.openclaw fields not mapped above MUST be preserved under frontmatter.openclawMetadata",
      "- Do not drop unknown keys silently",
      "",
      "## INTEGRATION.md requirements",
      "Create INTEGRATION.md only when OpenClaw metadata contains install/setup/config instructions (for example metadata.openclaw.config).",
      "If no integration/setup material exists, set integration markdown to null.",
      "INTEGRATION.md should include:",
      "- Purpose",
      "- Setup",
      "- Required environment variables",
      "- Required CLI tools",
      "- Verification steps",
      "",
      "## Output format (strict)",
      "Return exactly the following tagged sections:",
      "<skill_md>",
      "[full SKILL.md content including frontmatter + body]",
      "</skill_md>",
      "<integration_md>",
      "[full INTEGRATION.md content OR null]",
      "</integration_md>",
      "",
      "## Example",
      "Input OpenClaw frontmatter excerpt:",
      "```yaml",
      "name: shell-helper",
      "description: Useful shell automation",
      "metadata:",
      "  openclaw:",
      "    requires:",
      "      env: [OPENAI_API_KEY]",
      "      bins: [node, jq]",
      "    os: [linux, macos]",
      "    tags: [automation]",
      "    config:",
      "      setup_command: npm install",
      "```",
      "Expected converted frontmatter excerpt:",
      "```yaml",
      "name: shell-helper",
      "description: Useful shell automation",
      "requiredTools: [node, jq]",
      "platforms: [linux, macos]",
      "categories: [automation]",
      "config:",
      "  envVars: [OPENAI_API_KEY]",
      "openclawMetadata:",
      "  config:",
      "    setup_command: npm install",
      "```",
      "",
      "## OpenClaw input",
      "```markdown",
      openClawContent,
      "```",
    ].join("\n");
  }

  buildResponseParser(): (response: string) => Result<ParsedLlmResponse, MarketplaceError> {
    return (response: string) => {
      const skillMatch = response.match(/<skill_md>\s*([\s\S]*?)\s*<\/skill_md>/i);
      const integrationMatch = response.match(/<integration_md>\s*([\s\S]*?)\s*<\/integration_md>/i);

      if (!skillMatch) {
        return err(
          new MarketplaceError(
            "Migration response missing <skill_md> section",
            MARKETPLACE_ERROR_CODES.INVALID_RESPONSE,
          ),
        );
      }

      if (!integrationMatch) {
        return err(
          new MarketplaceError(
            "Migration response missing <integration_md> section",
            MARKETPLACE_ERROR_CODES.INVALID_RESPONSE,
          ),
        );
      }

      const integrationRaw = integrationMatch[1]?.trim() ?? "";
      const integrationMd = integrationRaw.toLowerCase() === "null" ? null : integrationRaw;

      return ok({
        skillMd: (skillMatch[1] ?? "").trim(),
        integrationMd,
      });
    };
  }
}

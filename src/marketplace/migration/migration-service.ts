import { ok, type Result } from "../../result";
import type { MarketplaceError } from "../errors";
import { deterministicMapper } from "./deterministic-mapper";
import { generateIntegrationMd } from "./integration-generator";
import { MigrationPromptBuilder } from "./prompt-builder";
import type { MigrationReport } from "./types";

export interface MigrationOutput {
  skillMd: string;
  integrationMd: string | null;
  report: MigrationReport;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export type ChatFn = (messages: ChatMessage[]) => Promise<string>;

interface MigrationServiceOptions {
  chatFn: ChatFn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function buildOpenclawMetadataFromDeterministic(
  deterministicFrontmatter: Record<string, unknown>,
): Record<string, unknown> | null {
  const openclawMetadata = isRecord(deterministicFrontmatter.openclawMetadata)
    ? structuredClone(deterministicFrontmatter.openclawMetadata)
    : {};

  const envVars = isRecord(deterministicFrontmatter.config)
    ? toStringArray(deterministicFrontmatter.config.envVars)
    : [];
  const requiredTools = toStringArray(deterministicFrontmatter.requiredTools);
  const platforms = toStringArray(deterministicFrontmatter.platforms);

  if (envVars.length > 0 || requiredTools.length > 0) {
    const existingRequires = isRecord(openclawMetadata.requires)
      ? openclawMetadata.requires
      : {};
    if (envVars.length > 0) {
      existingRequires.env = envVars;
    }
    if (requiredTools.length > 0) {
      existingRequires.bins = requiredTools;
    }
    openclawMetadata.requires = existingRequires;
  }

  if (platforms.length > 0 && openclawMetadata.os === undefined) {
    openclawMetadata.os = platforms;
  }

  return Object.keys(openclawMetadata).length > 0 ? openclawMetadata : null;
}

function toYamlScalar(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }

  if (typeof value === "string") {
    if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
      return value;
    }

    return JSON.stringify(value);
  }

  return JSON.stringify(String(value));
}

function toYaml(value: unknown, depth: number): string[] {
  const indent = "  ".repeat(depth);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${indent}[]`];
    }

    const lines: string[] = [];
    for (const entry of value) {
      if (isRecord(entry) || Array.isArray(entry)) {
        lines.push(`${indent}-`);
        lines.push(...toYaml(entry, depth + 1));
      } else {
        lines.push(`${indent}- ${toYamlScalar(entry)}`);
      }
    }
    return lines;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return [`${indent}{}`];
    }

    const lines: string[] = [];
    for (const [key, entry] of entries) {
      if (isRecord(entry) || Array.isArray(entry)) {
        lines.push(`${indent}${key}:`);
        lines.push(...toYaml(entry, depth + 1));
      } else {
        lines.push(`${indent}${key}: ${toYamlScalar(entry)}`);
      }
    }
    return lines;
  }

  return [`${indent}${toYamlScalar(value)}`];
}

function renderSkillMd(frontmatter: Record<string, unknown>, body: string): string {
  const yamlLines = toYaml(frontmatter, 0);
  const normalizedBody = body.startsWith("\n") ? body : `\n${body}`;

  return ["---", ...yamlLines, "---", normalizedBody].join("\n").trimEnd() + "\n";
}

function buildFallbackOutput(
  deterministicFrontmatter: Record<string, unknown>,
  body: string,
  baseReport: MigrationReport,
  warnings: string[],
): MigrationOutput {
  const openclawMetadata = buildOpenclawMetadataFromDeterministic(deterministicFrontmatter);
  const integrationMd = generateIntegrationMd(openclawMetadata);

  return {
    skillMd: renderSkillMd(deterministicFrontmatter, body),
    integrationMd,
    report: {
      ...baseReport,
      warnings: [...baseReport.warnings, ...warnings],
      usedLlm: false,
    },
  };
}

export class MigrationService {
  private readonly chatFn: ChatFn;

  private readonly promptBuilder: MigrationPromptBuilder;

  constructor(options: MigrationServiceOptions) {
    this.chatFn = options.chatFn;
    this.promptBuilder = new MigrationPromptBuilder();
  }

  async convert(openClawContent: string): Promise<Result<MigrationOutput, MarketplaceError>> {
    const deterministic = deterministicMapper(openClawContent);
    if (!deterministic.ok) {
      return deterministic;
    }

    const deterministicFrontmatter = deterministic.value.frontmatter;
    const openclawMetadata = buildOpenclawMetadataFromDeterministic(deterministicFrontmatter);
    const parseResponse = this.promptBuilder.buildResponseParser();
    const prompt = this.promptBuilder.buildPrompt(openClawContent);

    try {
      const llmResponse = await this.chatFn([{ role: "user", content: prompt }]);
      const parsed = parseResponse(llmResponse);

      if (parsed.ok) {
        const generatedIntegration =
          parsed.value.integrationMd ?? generateIntegrationMd(openclawMetadata);

        return ok({
          skillMd: parsed.value.skillMd,
          integrationMd: generatedIntegration,
          report: {
            warnings:
              parsed.value.integrationMd === null && generatedIntegration !== null
                ? ["INTEGRATION.md was generated deterministically because the LLM omitted it."]
                : [],
            mappedFields: deterministic.value.report.mappedFields,
            unmappedFields: deterministic.value.report.unmappedFields,
            usedLlm: true,
          },
        });
      }

      return ok(
        buildFallbackOutput(
          deterministicFrontmatter,
          deterministic.value.body,
          deterministic.value.report,
          [
            `LLM response was invalid and deterministic fallback was used: ${parsed.error.message}`,
          ],
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return ok(
        buildFallbackOutput(
          deterministicFrontmatter,
          deterministic.value.body,
          deterministic.value.report,
          [`LLM call failed and deterministic fallback was used: ${message}`],
        ),
      );
    }
  }
}

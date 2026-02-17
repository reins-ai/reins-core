import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { err, ok, type Result } from "../../result";
import { readIntegrationMd } from "../../skills/integration-reader";
import {
  MARKETPLACE_ERROR_CODES,
  MarketplaceError,
  type MarketplaceErrorCode,
} from "../errors";
import type { MigrationPipeline, MigrationReport, MigrationStep } from "../migration";
import { resolveAliases } from "../migration";
import type { MarketplaceSource } from "../types";
import { downloadAndExtract } from "./downloader";
import type { InstallProgressCallback, InstallResult, InstallStep, IntegrationInfo } from "./types";

interface SkillInstallerOptions {
  source: MarketplaceSource;
  migrationPipeline: MigrationPipeline;
  skillsDir?: string;
  onProgress?: InstallProgressCallback;
}

interface FrontmatterParseResult {
  frontmatter: Record<string, unknown>;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

interface ParsedBlock {
  value: Record<string, unknown>;
  nextIndex: number;
}

interface ParsedArray {
  value: unknown[];
  nextIndex: number;
}

interface MigrationPipelineInternals {
  onProgress?: (step: MigrationStep, message: string) => void;
}

const REQUIRED_FRONTMATTER_FIELDS = ["name", "description"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countIndent(line: string): number {
  let indent = 0;
  while (indent < line.length && line[indent] === " ") {
    indent += 1;
  }
  return indent;
}

function findNextMeaningfulLine(lines: string[], fromIndex: number): number {
  for (let index = fromIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }

    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    return index;
  }

  return -1;
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return "";
  }

  if (trimmed === "null" || trimmed === "~") {
    return null;
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  const isSingleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");
  if (isDoubleQuoted || isSingleQuoted) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") {
      return [];
    }

    return inner.split(",").map((item) => parseScalar(item));
  }

  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      return numeric;
    }
  }

  return trimmed;
}

function parseArray(lines: string[], startIndex: number, indent: number): ParsedArray {
  const value: unknown[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }

    if (line.trim() === "" || line.trim().startsWith("#")) {
      index += 1;
      continue;
    }

    const currentIndent = countIndent(line);
    if (currentIndent < indent) {
      break;
    }

    if (currentIndent > indent) {
      index += 1;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
      break;
    }

    const remainder = trimmed.slice(2).trim();
    if (remainder.length > 0) {
      value.push(parseScalar(remainder));
      index += 1;
      continue;
    }

    const nestedIndex = findNextMeaningfulLine(lines, index + 1);
    if (nestedIndex === -1) {
      value.push(null);
      index += 1;
      continue;
    }

    const nestedIndent = countIndent(lines[nestedIndex] ?? "");
    if (nestedIndent <= indent) {
      value.push(null);
      index += 1;
      continue;
    }

    const parsedNested = parseObject(lines, nestedIndex, nestedIndent);
    value.push(parsedNested.value);
    index = parsedNested.nextIndex;
  }

  return { value, nextIndex: index };
}

function parseObject(lines: string[], startIndex: number, indent: number): ParsedBlock {
  const value: Record<string, unknown> = {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }

    if (line.trim() === "" || line.trim().startsWith("#")) {
      index += 1;
      continue;
    }

    const currentIndent = countIndent(line);
    if (currentIndent < indent) {
      break;
    }

    if (currentIndent > indent) {
      index += 1;
      continue;
    }

    const trimmed = line.trim();
    const keyMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) {
      throw new Error(`Invalid YAML line: ${line}`);
    }

    const key = keyMatch[1] ?? "";
    const rawValue = keyMatch[2] ?? "";

    if (rawValue.length > 0) {
      value[key] = parseScalar(rawValue);
      index += 1;
      continue;
    }

    const nextIndex = findNextMeaningfulLine(lines, index + 1);
    if (nextIndex === -1) {
      value[key] = null;
      index += 1;
      continue;
    }

    const nextLine = lines[nextIndex] ?? "";
    const nextIndent = countIndent(nextLine);
    if (nextIndent <= currentIndent) {
      value[key] = null;
      index += 1;
      continue;
    }

    if (nextLine.trim().startsWith("- ")) {
      const parsedArray = parseArray(lines, nextIndex, nextIndent);
      value[key] = parsedArray.value;
      index = parsedArray.nextIndex;
      continue;
    }

    const parsedObject = parseObject(lines, nextIndex, nextIndent);
    value[key] = parsedObject.value;
    index = parsedObject.nextIndex;
  }

  return { value, nextIndex: index };
}

function parseYamlBlock(yaml: string): Record<string, unknown> {
  const lines = yaml.replace(/\r/g, "").split("\n");
  const startIndex = findNextMeaningfulLine(lines, 0);
  if (startIndex === -1) {
    return {};
  }

  const parsed = parseObject(lines, startIndex, countIndent(lines[startIndex] ?? ""));
  return parsed.value;
}

function parseFrontmatter(input: string): FrontmatterParseResult | null {
  const normalized = input.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
  if (!match) {
    return null;
  }

  const yaml = match[1] ?? "";
  return {
    frontmatter: parseYamlBlock(yaml),
  };
}

function extractOpenclawMetadata(skillContent: string): Record<string, unknown> | null {
  const parsed = parseFrontmatter(skillContent);
  if (!parsed) {
    return null;
  }

  const metadata = isRecord(parsed.frontmatter.metadata) ? parsed.frontmatter.metadata : null;
  if (!metadata) {
    return null;
  }

  const normalizedMetadata = resolveAliases(metadata);
  const openclaw = normalizedMetadata.openclaw;
  return isRecord(openclaw) ? openclaw : null;
}

function validateNativeSkillContent(skillContent: string): ValidationResult {
  const parsed = parseFrontmatter(skillContent);
  if (!parsed) {
    return {
      valid: false,
      errors: ["SKILL.md must include YAML frontmatter delimited by ---"],
    };
  }

  const errors: string[] = [];
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    const value = parsed.frontmatter[field];
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`Missing required frontmatter field: ${field}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function frontmatterHasVersion(skillContent: string): boolean {
  const parsed = parseFrontmatter(skillContent);
  if (!parsed) {
    return false;
  }

  const value = parsed.frontmatter.version;
  return typeof value === "string" && value.trim() !== "";
}

function injectVersionIntoFrontmatter(skillContent: string, version: string): string {
  const match = skillContent.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!match) {
    return skillContent;
  }

  const opening = match[1];
  const yaml = match[2] ?? "";
  const closing = match[3];
  const rest = skillContent.slice((match.index ?? 0) + match[0].length);

  return `${opening}${yaml}\nversion: ${version}${closing}${rest}`;
}

function wrapMarketplaceError(
  message: string,
  code: MarketplaceErrorCode,
  cause?: unknown,
): MarketplaceError {
  return new MarketplaceError(message, code, cause instanceof Error ? cause : undefined);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SkillInstaller {
  private readonly source: MarketplaceSource;

  private readonly migrationPipeline: MigrationPipeline;

  private readonly skillsDir: string;

  private readonly onProgress?: InstallProgressCallback;

  constructor(options: SkillInstallerOptions) {
    this.source = options.source;
    this.migrationPipeline = options.migrationPipeline;
    this.skillsDir = options.skillsDir ?? join(homedir(), ".reins", "skills");
    this.onProgress = options.onProgress;
  }

  async install(slug: string, version: string): Promise<Result<InstallResult>> {
    const installedPath = join(this.skillsDir, slug);

    try {
      this.emit("downloading", `Downloading ${slug}@${version} from ${this.source.name}`);
      const downloadResult = await this.source.download(slug, version);
      if (!downloadResult.ok) {
        return this.fail(
          `Failed to download ${slug}@${version}: ${downloadResult.error.message}`,
          MARKETPLACE_ERROR_CODES.DOWNLOAD_ERROR,
          downloadResult.error,
        );
      }

      this.emit("extracting", `Extracting ${downloadResult.value.filename}`);
      const extraction = await downloadAndExtract(downloadResult.value);
      if (!extraction.ok) {
        return this.fail(
          `Failed to extract ${slug}@${version}: ${extraction.error.message}`,
          MARKETPLACE_ERROR_CODES.DOWNLOAD_ERROR,
          extraction.error,
        );
      }

      const skillPath = join(extraction.value.extractedPath, "SKILL.md");
      this.emit("detecting", `Detecting source format for ${slug}`);

      let skillContent: string;
      try {
        skillContent = await readFile(skillPath, "utf8");
      } catch (error) {
        return this.fail(
          `Unable to read extracted SKILL.md for ${slug}: ${toErrorMessage(error)}`,
          MARKETPLACE_ERROR_CODES.DOWNLOAD_ERROR,
          error,
        );
      }

      const openclawMetadata = extractOpenclawMetadata(skillContent);
      const needsMigration = openclawMetadata !== null;
      let migrationReport: InstallResult["migrationReport"];

      await mkdir(this.skillsDir, { recursive: true });
      await rm(installedPath, { recursive: true, force: true });

      if (needsMigration) {
        this.emit("migrating", `Detected OpenClaw metadata for ${slug}; starting migration`);
        const migrationResult = await this.migrateWithProgressForwarding(
          extraction.value.extractedPath,
          installedPath,
          version,
        );

        if (!migrationResult.ok) {
          return this.fail(
            `Failed to migrate ${slug}@${version}: ${migrationResult.error.message}`,
            MARKETPLACE_ERROR_CODES.SOURCE_ERROR,
            migrationResult.error,
          );
        }

        migrationReport = migrationResult.value.report;
      } else {
        this.emit("validating", `Validating Reins-native skill package for ${slug}`);
        const validation = validateNativeSkillContent(skillContent);
        if (!validation.valid) {
          return this.fail(
            `Validation failed for ${slug}@${version}: ${validation.errors.join("; ")}`,
            MARKETPLACE_ERROR_CODES.INVALID_RESPONSE,
          );
        }

        // Inject marketplace-provided version when source frontmatter omits it
        if (!frontmatterHasVersion(skillContent)) {
          const normalizedContent = injectVersionIntoFrontmatter(skillContent, version);
          await writeFile(skillPath, normalizedContent, "utf8");
        }

        this.emit("installing", `Installing ${slug}@${version} to ${installedPath}`);
        try {
          await cp(extraction.value.extractedPath, installedPath, {
            recursive: true,
            force: true,
          });
        } catch (error) {
          return this.fail(
            `Failed to install ${slug}@${version}: ${toErrorMessage(error)}`,
            MARKETPLACE_ERROR_CODES.SOURCE_ERROR,
            error,
          );
        }
      }

      this.emit("installing", `Registering installed skill ${slug}`);
      const registrationResult = await this.registerInstalledSkill(installedPath);
      if (!registrationResult.ok) {
        return this.fail(
          `Skill installed but registration failed for ${slug}: ${registrationResult.error.message}`,
          MARKETPLACE_ERROR_CODES.SOURCE_ERROR,
          registrationResult.error,
        );
      }

      const integration = await this.readIntegrationGuide(installedPath);

      this.emit("complete", `Installed ${slug}@${version} successfully`);
      return ok({
        slug,
        version,
        installedPath,
        migrated: needsMigration,
        migrationReport,
        integration,
      });
    } catch (error) {
      return this.fail(
        `Install flow failed for ${slug}@${version}: ${toErrorMessage(error)}`,
        MARKETPLACE_ERROR_CODES.SOURCE_ERROR,
        error,
      );
    }
  }

  private async migrateWithProgressForwarding(
    sourcePath: string,
    targetPath: string,
    fallbackVersion?: string,
  ): Promise<Result<{ report: MigrationReport }, MarketplaceError>> {
    const internals = this.migrationPipeline as unknown as MigrationPipelineInternals;
    const originalOnProgress = internals.onProgress;

    internals.onProgress = (step, message) => {
      this.emit("migrating", `${step}: ${message}`);
      originalOnProgress?.(step, message);
    };

    try {
      const result = await this.migrationPipeline.migrate(sourcePath, targetPath, { fallbackVersion });
      if (!result.ok) {
        return err(result.error);
      }

      return ok({ report: result.value.report });
    } finally {
      internals.onProgress = originalOnProgress;
    }
  }

  private async readIntegrationGuide(installedPath: string): Promise<IntegrationInfo | undefined> {
    const guidePath = join(installedPath, "INTEGRATION.md");

    try {
      await access(guidePath);
    } catch {
      return undefined;
    }

    const result = await readIntegrationMd(guidePath);
    if (!result.ok) {
      return undefined;
    }

    return {
      setupRequired: result.value.hasSetupSteps,
      guidePath,
      sections: result.value.sections,
    };
  }

  private async registerInstalledSkill(installedPath: string): Promise<Result<void, MarketplaceError>> {
    const moduleCandidates = ["../../skills", "../../skills/registry"];

    for (const modulePath of moduleCandidates) {
      try {
        const mod = await import(modulePath);
        const moduleRecord = mod as Record<string, unknown>;

        const registerSkillDirectory = moduleRecord.registerSkillDirectory;
        if (typeof registerSkillDirectory === "function") {
          const outcome = await (
            registerSkillDirectory as (path: string) => Promise<unknown> | unknown
          )(installedPath);
          return this.normalizeRegistrationOutcome(outcome);
        }

        const SkillRegistry = moduleRecord.SkillRegistry;
        if (typeof SkillRegistry === "function") {
          const instance = new (SkillRegistry as new () => {
            registerFromDirectory?: (path: string) => Promise<unknown> | unknown;
            register?: (path: string) => Promise<unknown> | unknown;
          })();

          if (typeof instance.registerFromDirectory === "function") {
            const outcome = await instance.registerFromDirectory(installedPath);
            return this.normalizeRegistrationOutcome(outcome);
          }

          if (typeof instance.register === "function") {
            const outcome = await instance.register(installedPath);
            return this.normalizeRegistrationOutcome(outcome);
          }
        }
      } catch {
        continue;
      }
    }

    return ok(undefined);
  }

  private normalizeRegistrationOutcome(outcome: unknown): Result<void, MarketplaceError> {
    if (typeof outcome === "boolean") {
      if (outcome) {
        return ok(undefined);
      }

      return err(
        wrapMarketplaceError(
          "Skill registry rejected installed skill",
          MARKETPLACE_ERROR_CODES.SOURCE_ERROR,
        ),
      );
    }

    if (outcome && typeof outcome === "object" && "ok" in outcome) {
      const resultLike = outcome as { ok?: unknown; error?: unknown };
      if (resultLike.ok === true) {
        return ok(undefined);
      }

      if (resultLike.ok === false) {
        const message =
          resultLike.error instanceof Error
            ? resultLike.error.message
            : typeof resultLike.error === "string"
              ? resultLike.error
              : "Skill registration failed";

        return err(
          wrapMarketplaceError(message, MARKETPLACE_ERROR_CODES.SOURCE_ERROR, resultLike.error),
        );
      }
    }

    return ok(undefined);
  }

  private emit(step: InstallStep, message: string): void {
    this.onProgress?.(step, message);
  }

  private fail(message: string, code: MarketplaceErrorCode, cause?: unknown): Result<never> {
    const error = wrapMarketplaceError(message, code, cause);
    this.emit("failed", message);
    return err(error);
  }
}

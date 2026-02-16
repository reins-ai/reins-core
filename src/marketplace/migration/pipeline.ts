import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { err, ok, type Result } from "../../result";
import { MARKETPLACE_ERROR_CODES, MarketplaceError } from "../errors";
import type { MigrationOutput, MigrationService } from "./migration-service";
import type { MigrationResult, MigrationStep } from "./types";

export type ProgressCallback = (step: MigrationStep, message: string) => void;

interface MigrationConverter {
  convert: (openClawContent: string) => Promise<Result<MigrationOutput, MarketplaceError>>;
}

interface MigrationPipelineOptions {
  migrationService: Pick<MigrationService, "convert">;
  onProgress?: ProgressCallback;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function parseFrontmatter(content: string): { yaml: string } | null {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return null;
  }

  return { yaml: match[1] ?? "" };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function validateBasicYaml(yaml: string): ValidationResult {
  const lines = yaml.replace(/\r/g, "").split("\n");
  const values: Record<string, string> = {};
  const errors: string[] = [];
  let allowNestedValueIndent: number | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const listMatch = line.match(/^(\s*)-\s+.+$/);
    if (listMatch) {
      const indent = (listMatch[1] ?? "").length;
      if (allowNestedValueIndent === null || indent < allowNestedValueIndent) {
        errors.push(`Invalid YAML line ${index + 1}: unexpected list item indentation`);
      }
      continue;
    }

    const emptyCollectionMatch = line.match(/^(\s*)(\{\}|\[\])$/);
    if (emptyCollectionMatch) {
      const indent = (emptyCollectionMatch[1] ?? "").length;
      if (allowNestedValueIndent === null || indent < allowNestedValueIndent) {
        errors.push(`Invalid YAML line ${index + 1}: unexpected collection indentation`);
      }
      continue;
    }

    const keyMatch = line.match(/^(\s*)([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
    if (!keyMatch) {
      errors.push(`Invalid YAML line ${index + 1}: ${line}`);
      continue;
    }

    const indent = (keyMatch[1] ?? "").length;
    const key = keyMatch[2] ?? "";
    const rawValue = keyMatch[3];

    if (rawValue === undefined || rawValue.trim() === "") {
      allowNestedValueIndent = indent + 2;
    } else {
      allowNestedValueIndent = null;
      if (indent === 0) {
        values[key] = unquote(rawValue);
      }
    }
  }

  for (const requiredField of ["name", "description", "version"]) {
    const value = values[requiredField];
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`Missing required frontmatter field: ${requiredField}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MigrationPipeline {
  private readonly migrationService: MigrationConverter;

  private readonly onProgress?: ProgressCallback;

  constructor(options: MigrationPipelineOptions) {
    this.migrationService = options.migrationService;
    this.onProgress = options.onProgress;
  }

  async migrate(sourcePath: string, targetDir: string): Promise<Result<MigrationResult, MarketplaceError>> {
    let stagingDir: string | null = null;
    let migrationWarnings: string[] = [];

    try {
      this.emit("parsing", "Reading source SKILL.md");

      const sourceSkillPath = join(sourcePath, "SKILL.md");
      let sourceContent: string;
      try {
        sourceContent = await readFile(sourceSkillPath, "utf8");
      } catch (error) {
        const message = `Failed to read source SKILL.md at ${sourceSkillPath}: ${toErrorMessage(error)}`;
        this.emit("failed", message);
        return err(new MarketplaceError(message, MARKETPLACE_ERROR_CODES.NOT_FOUND));
      }

      this.emit("converting", "Converting skill using migration service");
      const converted = await this.migrationService.convert(sourceContent);
      if (!converted.ok) {
        const message = `Failed to convert source skill: ${converted.error.message}`;
        this.emit("failed", message);
        return err(
          new MarketplaceError(message, MARKETPLACE_ERROR_CODES.SOURCE_ERROR, converted.error),
        );
      }

      migrationWarnings = converted.value.report.warnings;

      this.emit("generating", "Staging converted files in temporary directory");
      stagingDir = await mkdtemp(join(tmpdir(), "reins-migration-"));
      const stagedSkillPath = join(stagingDir, "SKILL.md");
      await writeFile(stagedSkillPath, converted.value.skillMd, "utf8");

      if (converted.value.integrationMd !== null) {
        const stagedIntegrationPath = join(stagingDir, "INTEGRATION.md");
        await writeFile(stagedIntegrationPath, converted.value.integrationMd, "utf8");
      }

      this.emit("validating", "Validating staged skill package");
      const validationResult = await this.validateStagedSkill(stagingDir);
      if (!validationResult.valid) {
        const warningSuffix =
          migrationWarnings.length > 0
            ? ` Warnings: ${migrationWarnings.join(" | ")}`
            : "";
        const message = `Validation failed for staged migration at ${stagingDir}: ${validationResult.errors.join(
          "; ",
        )}.${warningSuffix}`;
        this.emit("failed", message);
        return err(new MarketplaceError(message, MARKETPLACE_ERROR_CODES.INVALID_RESPONSE));
      }

      await mkdir(targetDir, { recursive: true });
      await cp(join(stagingDir, "SKILL.md"), join(targetDir, "SKILL.md"), { force: true });

      if (converted.value.integrationMd !== null) {
        await cp(join(stagingDir, "INTEGRATION.md"), join(targetDir, "INTEGRATION.md"), {
          force: true,
        });
      }

      this.emit("complete", `Migration completed successfully into ${targetDir}`);

      await rm(stagingDir, { recursive: true, force: true });
      return ok(converted.value);
    } catch (error) {
      const message = `Migration pipeline failed${
        stagingDir ? ` (staging: ${stagingDir})` : ""
      }: ${toErrorMessage(error)}`;
      this.emit("failed", message);
      return err(
        new MarketplaceError(
          message,
          MARKETPLACE_ERROR_CODES.SOURCE_ERROR,
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  private emit(step: MigrationStep, message: string): void {
    this.onProgress?.(step, message);
  }

  private async validateStagedSkill(stagingDir: string): Promise<ValidationResult> {
    const externalValidation = await this.validateWithExternalSkillValidator(stagingDir);
    if (externalValidation !== null) {
      return externalValidation;
    }

    const skillPath = join(stagingDir, "SKILL.md");
    let skillContent: string;
    try {
      skillContent = await readFile(skillPath, "utf8");
    } catch (error) {
      return {
        valid: false,
        errors: [`SKILL.md is missing in staging directory: ${toErrorMessage(error)}`],
      };
    }

    const frontmatter = parseFrontmatter(skillContent);
    if (!frontmatter) {
      return {
        valid: false,
        errors: ["SKILL.md must include YAML frontmatter delimited by ---"],
      };
    }

    return validateBasicYaml(frontmatter.yaml);
  }

  private async validateWithExternalSkillValidator(stagingDir: string): Promise<ValidationResult | null> {
    const moduleCandidates = ["../../skills/validator", "../../skills"];

    for (const modulePath of moduleCandidates) {
      try {
        const mod = await import(modulePath);

        const validateSkillDirectory = (mod as Record<string, unknown>).validateSkillDirectory;
        if (typeof validateSkillDirectory === "function") {
          const outcome = await (validateSkillDirectory as (path: string) => Promise<unknown> | unknown)(
            stagingDir,
          );
          return this.normalizeValidationOutcome(outcome);
        }

        const SkillValidator = (mod as Record<string, unknown>).SkillValidator;
        if (typeof SkillValidator === "function") {
          const instance = new (SkillValidator as new () => {
            validateSkillDirectory?: (path: string) => Promise<unknown> | unknown;
          })();

          if (typeof instance.validateSkillDirectory === "function") {
            const outcome = await instance.validateSkillDirectory(stagingDir);
            return this.normalizeValidationOutcome(outcome);
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private normalizeValidationOutcome(outcome: unknown): ValidationResult {
    if (typeof outcome === "boolean") {
      return {
        valid: outcome,
        errors: outcome ? [] : ["External skill validator returned false"],
      };
    }

    if (typeof outcome === "object" && outcome !== null && "ok" in outcome) {
      const resultLike = outcome as { ok?: unknown; error?: unknown; value?: unknown };
      if (resultLike.ok === true) {
        return { valid: true, errors: [] };
      }

      if (resultLike.ok === false) {
        const message =
          resultLike.error instanceof Error
            ? resultLike.error.message
            : typeof resultLike.error === "string"
              ? resultLike.error
              : "External skill validator returned an error";
        return {
          valid: false,
          errors: [message],
        };
      }

      if (typeof resultLike.value === "boolean") {
        return {
          valid: resultLike.value,
          errors: resultLike.value ? [] : ["External skill validator returned invalid state"],
        };
      }
    }

    return {
      valid: true,
      errors: [],
    };
  }
}

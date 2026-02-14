import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import JSON5 from "json5";

import { ReinsError } from "../errors";
import { InvalidEnvironmentNameError } from "../environment/errors";
import { err, ok, type Result } from "../result";
import { DEFAULT_REINS_GLOBAL_CONFIG, type ReinsGlobalConfig } from "./format-decision";
import { isValidEnvironmentName, validateGlobalConfig } from "./schema";
import type { ConfigStoreOptions } from "./types";

const CONFIG_HEADER = [
  "// Reins global configuration (JSON5)",
  "// Global only: credentials, model defaults, billing, and active environment.",
  "// Environment documents (PERSONALITY.md, USER.md, etc.) are stored per environment.",
].join("\n");

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isMissingFileError(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "code" in value
    && value.code === "ENOENT";
}

export class ConfigStore {
  private readonly createIfMissing: boolean;

  constructor(
    private readonly configPath: string,
    options: ConfigStoreOptions = {},
  ) {
    this.createIfMissing = options.createIfMissing ?? true;
  }

  async read(): Promise<Result<ReinsGlobalConfig, ReinsError>> {
    const contentResult = await readFile(this.configPath, "utf8")
      .then((content) => ok(content))
      .catch((readError: unknown) => {
        if (isMissingFileError(readError) && this.createIfMissing) {
          return ok<string | null>(null);
        }

        return err(
          new ReinsError(
            `Unable to read global config at ${this.configPath}`,
            "CONFIG_READ_ERROR",
            toError(readError),
          ),
        );
      });

    if (!contentResult.ok) {
      return contentResult;
    }

    if (contentResult.value === null) {
      const writeDefaultResult = await this.write(DEFAULT_REINS_GLOBAL_CONFIG);
      if (!writeDefaultResult.ok) {
        return writeDefaultResult;
      }

      return ok(DEFAULT_REINS_GLOBAL_CONFIG);
    }

    const parsedResult = await Promise.resolve(contentResult.value)
      .then((content) => JSON5.parse(content) as unknown)
      .then((parsed) => ok(parsed))
      .catch((parseError: unknown) => err(
        new ReinsError(
          `Unable to parse global config at ${this.configPath}`,
          "CONFIG_PARSE_ERROR",
          toError(parseError),
        ),
      ));

    if (!parsedResult.ok) {
      return parsedResult;
    }

    const validation = validateGlobalConfig(parsedResult.value);
    if (!validation.isValid) {
      return err(
        new ReinsError(
          this.formatValidationErrorMessage(validation.issues),
          "CONFIG_VALIDATION_ERROR",
        ),
      );
    }

    return ok(validation.config);
  }

  async write(config: ReinsGlobalConfig): Promise<Result<void, ReinsError>> {
    const validation = validateGlobalConfig(config);
    if (!validation.isValid) {
      return err(
        new ReinsError(
          this.formatValidationErrorMessage(validation.issues),
          "CONFIG_VALIDATION_ERROR",
        ),
      );
    }

    const content = `${CONFIG_HEADER}\n${JSON5.stringify(validation.config, null, 2)}\n`;

    const ensureDirectoryResult = await mkdir(dirname(this.configPath), { recursive: true })
      .then(() => ok(undefined))
      .catch((mkdirError: unknown) => err(
        new ReinsError(
          `Unable to prepare config directory for ${this.configPath}`,
          "CONFIG_DIRECTORY_ERROR",
          toError(mkdirError),
        ),
      ));

    if (!ensureDirectoryResult.ok) {
      return ensureDirectoryResult;
    }

    return writeFile(this.configPath, content, "utf8")
      .then(() => ok(undefined))
      .catch((writeError: unknown) => err(
        new ReinsError(
          `Unable to write global config at ${this.configPath}`,
          "CONFIG_WRITE_ERROR",
          toError(writeError),
        ),
      ));
  }

  async getActiveEnvironment(): Promise<Result<string, ReinsError>> {
    const configResult = await this.read();
    if (!configResult.ok) {
      return configResult;
    }

    return ok(configResult.value.activeEnvironment);
  }

  async setActiveEnvironment(name: string): Promise<Result<void, ReinsError>> {
    if (!isValidEnvironmentName(name)) {
      return err(new InvalidEnvironmentNameError(name));
    }

    return this.updateSection("activeEnvironment", name);
  }

  async updateSection<K extends keyof ReinsGlobalConfig>(
    section: K,
    value: ReinsGlobalConfig[K],
  ): Promise<Result<void, ReinsError>> {
    const configResult = await this.read();
    if (!configResult.ok) {
      return configResult;
    }

    const nextConfig: ReinsGlobalConfig = {
      ...configResult.value,
      [section]: value,
    };

    return this.write(nextConfig);
  }

  private formatValidationErrorMessage(
    issues: Array<{ path: string; message: string }>,
  ): string {
    return [
      "Global config validation failed:",
      ...issues.map((issue) => `- ${issue.path}: ${issue.message}`),
    ].join("\n");
  }
}

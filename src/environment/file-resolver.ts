import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { err, ok, type Result } from "../result";
import {
  DocumentNotFoundError,
  type EnvironmentError,
  EnvironmentNotFoundError,
  InvalidEnvironmentNameError,
} from "./errors";
import type { EnvironmentResolver } from "./resolver";
import {
  ENVIRONMENT_DOCUMENTS,
  OPTIONAL_ENVIRONMENT_DOCUMENTS,
  type DocumentResolutionResult,
  type DocumentSource,
  type Environment,
  type EnvironmentDocument,
  type EnvironmentDocumentContent,
  type EnvironmentDocumentMap,
  type OverlayResolution,
} from "./types";

const DEFAULT_ENVIRONMENT = "default";

/**
 * Maps each EnvironmentDocument type to its on-disk filename.
 */
const DOCUMENT_FILENAMES: Record<EnvironmentDocument, string> = {
  PERSONALITY: "PERSONALITY.md",
  USER: "USER.md",
  HEARTBEAT: "HEARTBEAT.md",
  ROUTINES: "ROUTINES.md",
  GOALS: "GOALS.md",
  KNOWLEDGE: "KNOWLEDGE.md",
  TOOLS: "TOOLS.md",
  BOUNDARIES: "BOUNDARIES.md",
  MEMORY: "MEMORY.md",
  PERSONA: "PERSONA.yaml",
};

/**
 * Validates that an environment name is safe for filesystem use.
 *
 * Allowed: lowercase alphanumeric, hyphens, underscores. Must start with a letter.
 * Disallowed: empty, dots, slashes, spaces, special characters.
 */
function isValidEnvironmentName(name: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(name);
}

/**
 * Filesystem-backed overlay resolver that reads environment documents from
 * a directory tree and applies full-file replacement precedence.
 *
 * Directory layout:
 * ```
 * environmentsRoot/
 *   default/
 *     PERSONALITY.md
 *     USER.md
 *     ...
 *   work/
 *     PERSONALITY.md   ← overrides default
 *     ...
 * ```
 *
 * Resolution rule: if the active environment directory contains the file,
 * that complete file wins. Otherwise, fall back to `default/`. No deep
 * merge or partial merge of document content is performed.
 */
export class FileEnvironmentResolver implements EnvironmentResolver {
  constructor(private readonly environmentsRoot: string) {}

  async resolveDocument(
    documentType: EnvironmentDocument,
    environmentName: string,
  ): Promise<Result<DocumentResolutionResult, EnvironmentError>> {
    if (!isValidEnvironmentName(environmentName)) {
      return err(new InvalidEnvironmentNameError(environmentName));
    }

    const filename = DOCUMENT_FILENAMES[documentType];

    // Try active environment first (unless it IS default)
    if (environmentName !== DEFAULT_ENVIRONMENT) {
      const activeDir = join(this.environmentsRoot, environmentName);
      const activeDirExists = await directoryExists(activeDir);

      if (!activeDirExists) {
        return err(new EnvironmentNotFoundError(environmentName));
      }

      const activePath = join(activeDir, filename);
      const activeContent = await readFileSafe(activePath);

      if (activeContent !== null) {
        return ok(
          buildResolutionResult(documentType, "active", environmentName, activePath, activeContent),
        );
      }
    }

    // Fall back to default
    const defaultDir = join(this.environmentsRoot, DEFAULT_ENVIRONMENT);
    const defaultDirExists = await directoryExists(defaultDir);

    if (!defaultDirExists) {
      return err(new EnvironmentNotFoundError(DEFAULT_ENVIRONMENT));
    }

    const defaultPath = join(defaultDir, filename);
    const defaultContent = await readFileSafe(defaultPath);

    if (defaultContent !== null) {
      const source: DocumentSource =
        environmentName === DEFAULT_ENVIRONMENT ? "active" : "default";
      const sourceEnv =
        environmentName === DEFAULT_ENVIRONMENT ? environmentName : DEFAULT_ENVIRONMENT;

      return ok(
        buildResolutionResult(documentType, source, sourceEnv, defaultPath, defaultContent),
      );
    }

    return err(new DocumentNotFoundError(documentType, environmentName));
  }

  async resolveAll(
    environmentName: string,
  ): Promise<Result<OverlayResolution, EnvironmentError>> {
    if (!isValidEnvironmentName(environmentName)) {
      return err(new InvalidEnvironmentNameError(environmentName));
    }

    // Verify the active environment directory exists (unless it's default)
    if (environmentName !== DEFAULT_ENVIRONMENT) {
      const activeDir = join(this.environmentsRoot, environmentName);
      if (!(await directoryExists(activeDir))) {
        return err(new EnvironmentNotFoundError(environmentName));
      }
    }

    // Verify default directory exists
    const defaultDir = join(this.environmentsRoot, DEFAULT_ENVIRONMENT);
    if (!(await directoryExists(defaultDir))) {
      return err(new EnvironmentNotFoundError(DEFAULT_ENVIRONMENT));
    }

    const documents = {} as Record<EnvironmentDocument, DocumentResolutionResult>;

    for (const docType of ENVIRONMENT_DOCUMENTS) {
      const result = await this.resolveDocument(docType, environmentName);

      if (!result.ok) {
        if (OPTIONAL_ENVIRONMENT_DOCUMENTS.has(docType)) {
          continue;
        }
        return err(result.error);
      }

      documents[docType] = result.value;
    }

    return ok({
      activeEnvironment: environmentName,
      fallbackEnvironment: DEFAULT_ENVIRONMENT,
      documents,
    });
  }

  async listEnvironments(): Promise<Result<Environment[], EnvironmentError>> {
    const rootExists = await directoryExists(this.environmentsRoot);

    if (!rootExists) {
      return ok([]);
    }

    try {
      const entries = await readdir(this.environmentsRoot, { withFileTypes: true });
      const environments: Environment[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        if (!isValidEnvironmentName(entry.name)) {
          continue;
        }

        const envPath = join(this.environmentsRoot, entry.name);
        const documents = await scanDocuments(envPath);

        environments.push({
          name: entry.name,
          path: envPath,
          documents,
        });
      }

      // Sort alphabetically, but ensure "default" comes first
      environments.sort((a, b) => {
        if (a.name === DEFAULT_ENVIRONMENT) return -1;
        if (b.name === DEFAULT_ENVIRONMENT) return 1;
        return a.name.localeCompare(b.name);
      });

      return ok(environments);
    } catch (error) {
      return err(
        new EnvironmentNotFoundError(
          `environments root: ${this.environmentsRoot}`,
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }
}

/**
 * Build a DocumentResolutionResult from resolved file data.
 */
function buildResolutionResult(
  type: EnvironmentDocument,
  source: DocumentSource,
  sourceEnvironment: string,
  path: string,
  content: string,
): DocumentResolutionResult {
  const document: EnvironmentDocumentContent = {
    type,
    path,
    content,
    environmentName: sourceEnvironment,
    loadedAt: new Date(),
  };

  return { type, source, sourceEnvironment, document };
}

/**
 * Read a file and return its content, or null if the file does not exist.
 */
async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Check whether a path exists and is a directory.
 */
async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scan an environment directory for known document files and return
 * a partial map of document type → content.
 */
async function scanDocuments(envPath: string): Promise<EnvironmentDocumentMap> {
  const documents: EnvironmentDocumentMap = {};

  for (const docType of ENVIRONMENT_DOCUMENTS) {
    const filename = DOCUMENT_FILENAMES[docType];
    const filePath = join(envPath, filename);
    const content = await readFileSafe(filePath);

    if (content !== null) {
      documents[docType] = content;
    }
  }

  return documents;
}

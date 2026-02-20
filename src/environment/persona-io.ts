import { join } from "node:path";
import { mkdir } from "node:fs/promises";

import { zipSync, strToU8, unzipSync } from "fflate";

import { err, ok, type Result } from "../result";
import { EnvironmentError } from "./errors";
import { generateDefaultPersonaYaml, parsePersonaYaml } from "./persona";

export interface PersonaExportResult {
  path: string;
  exportedAt: string;
}

/**
 * Format a Date as `YYYY-MM-DD-HHmm` for timestamped filenames.
 */
function formatTimestamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}${min}`;
}

/**
 * Read a file using Bun.file, returning a fallback value if the file
 * does not exist or cannot be read.
 */
async function readFileOrFallback(filePath: string, fallback: string): Promise<string> {
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) {
      return fallback;
    }
    return await file.text();
  } catch {
    return fallback;
  }
}

/**
 * Export the active persona (PERSONA.yaml + PERSONALITY.md) as a
 * timestamped zip archive.
 *
 * Missing source files are handled gracefully:
 * - PERSONA.yaml falls back to the default generated content
 * - PERSONALITY.md falls back to an empty string
 */
export async function exportPersona(
  envDir: string,
  outputDir: string,
): Promise<Result<PersonaExportResult, EnvironmentError>> {
  try {
    const personaYaml = await readFileOrFallback(
      join(envDir, "PERSONA.yaml"),
      generateDefaultPersonaYaml(),
    );

    const personalityMd = await readFileOrFallback(
      join(envDir, "PERSONALITY.md"),
      "",
    );

    const now = new Date();
    const timestamp = formatTimestamp(now);
    const filename = `persona-${timestamp}.zip`;
    const outputPath = join(outputDir, filename);

    // Ensure the output directory exists
    await mkdir(outputDir, { recursive: true });

    const zipData = zipSync({
      "PERSONA.yaml": strToU8(personaYaml),
      "PERSONALITY.md": strToU8(personalityMd),
    });

    await Bun.write(outputPath, zipData);

    return ok({
      path: outputPath,
      exportedAt: now.toISOString(),
    });
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    return err(
      new EnvironmentError(
        `Failed to export persona: ${cause?.message ?? String(error)}`,
        "EXPORT_FAILED",
        cause,
      ),
    );
  }
}

export interface PersonaImportResult {
  personaName: string;
  envDir: string;
  importedAt: string;
}

/**
 * Import a persona pack (zip containing PERSONA.yaml + PERSONALITY.md)
 * into the given environment directory.
 *
 * The zip must have been created by `exportPersona()` and contain both
 * files at the root level. PERSONA.yaml is validated against the Zod
 * schema and PERSONALITY.md must be non-empty.
 */
export async function importPersona(
  zipPath: string,
  envDir: string,
): Promise<Result<PersonaImportResult, EnvironmentError>> {
  try {
    const zipFile = Bun.file(zipPath);
    const exists = await zipFile.exists();
    if (!exists) {
      return err(
        new EnvironmentError(
          `Persona zip not found: ${zipPath}`,
          "IMPORT_FAILED",
        ),
      );
    }

    const zipBuffer = await zipFile.arrayBuffer();
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(zipBuffer));
    } catch (unzipError) {
      const cause = unzipError instanceof Error ? unzipError : undefined;
      return err(
        new EnvironmentError(
          `Failed to extract persona zip: ${cause?.message ?? String(unzipError)}`,
          "IMPORT_FAILED",
          cause,
        ),
      );
    }

    const personaEntry = entries["PERSONA.yaml"];
    if (!personaEntry) {
      return err(
        new EnvironmentError(
          "Invalid persona pack: missing PERSONA.yaml",
          "IMPORT_FAILED",
        ),
      );
    }

    const personalityEntry = entries["PERSONALITY.md"];
    if (!personalityEntry) {
      return err(
        new EnvironmentError(
          "Invalid persona pack: missing PERSONALITY.md",
          "IMPORT_FAILED",
        ),
      );
    }

    const decoder = new TextDecoder();
    const personaYamlContent = decoder.decode(personaEntry);
    const personalityMdContent = decoder.decode(personalityEntry);

    const parseResult = parsePersonaYaml(personaYamlContent);
    if (!parseResult.ok) {
      return err(
        new EnvironmentError(
          `Invalid PERSONA.yaml: ${parseResult.error.message}`,
          "IMPORT_FAILED",
          parseResult.error,
        ),
      );
    }

    if (personalityMdContent.trim().length === 0) {
      return err(
        new EnvironmentError(
          "Invalid persona pack: PERSONALITY.md is empty",
          "IMPORT_FAILED",
        ),
      );
    }

    await mkdir(envDir, { recursive: true });
    await Bun.write(join(envDir, "PERSONA.yaml"), personaYamlContent);
    await Bun.write(join(envDir, "PERSONALITY.md"), personalityMdContent);

    return ok({
      personaName: parseResult.value.name,
      envDir,
      importedAt: new Date().toISOString(),
    });
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    return err(
      new EnvironmentError(
        `Failed to import persona: ${cause?.message ?? String(error)}`,
        "IMPORT_FAILED",
        cause,
      ),
    );
  }
}

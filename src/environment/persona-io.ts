import { join } from "node:path";
import { mkdir } from "node:fs/promises";

import { zipSync, strToU8 } from "fflate";

import { err, ok, type Result } from "../result";
import { EnvironmentError } from "./errors";
import { generateDefaultPersonaYaml } from "./persona";

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

import type { IntegrationSection } from "../../skills/integration-reader";
import type { MigrationReport } from "../migration";

export type InstallStep =
  | "downloading"
  | "extracting"
  | "detecting"
  | "migrating"
  | "validating"
  | "installing"
  | "complete"
  | "failed";

export type InstallProgressCallback = (step: InstallStep, message: string) => void;

/**
 * Structured summary of an INTEGRATION.md found in the installed skill
 * directory. Provides enough information for the UI to surface post-install
 * setup requirements without re-reading the file.
 */
export interface IntegrationInfo {
  /** Whether the guide contains actionable setup steps */
  setupRequired: boolean;
  /** Absolute path to the INTEGRATION.md file */
  guidePath: string;
  /** Parsed sections from the guide (headings + content) */
  sections: IntegrationSection[];
}

export interface InstallResult {
  slug: string;
  version: string;
  installedPath: string;
  migrated: boolean;
  migrationReport?: MigrationReport;
  /** Present when the installed skill includes an INTEGRATION.md guide */
  integration?: IntegrationInfo;
}

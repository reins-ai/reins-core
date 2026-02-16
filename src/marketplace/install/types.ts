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

export interface InstallResult {
  slug: string;
  version: string;
  installedPath: string;
  migrated: boolean;
  migrationReport?: MigrationReport;
}

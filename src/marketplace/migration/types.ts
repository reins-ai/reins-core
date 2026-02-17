export interface MappingRule {
  source: string;
  target: string;
  transform?: (value: unknown) => unknown;
}

export interface MigrationReport {
  warnings: string[];
  mappedFields: string[];
  unmappedFields: string[];
  usedLlm: boolean;
}

export interface MigrationResult {
  skillMd: string;
  integrationMd: string | null;
  report: MigrationReport;
}

export interface DeterministicMigrationResult {
  frontmatter: Record<string, unknown>;
  body: string;
  report: MigrationReport;
}

export type MigrationStep =
  | "parsing"
  | "converting"
  | "generating"
  | "validating"
  | "complete"
  | "failed";

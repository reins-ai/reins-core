import type { Result } from "../result";
import type { EnvironmentError } from "./errors";
import type {
  DocumentResolutionResult,
  Environment,
  EnvironmentDocument,
  OverlayResolution,
} from "./types";

/**
 * Resolves environment-scoped documents with strict full-file overlay precedence.
 *
 * Semantics:
 * - If the active environment has a document, that complete file wins.
 * - If the active environment does not have that document, resolver falls back to default.
 * - No deep merge or partial merge of document content is allowed.
 */
export interface EnvironmentResolver {
  resolveDocument(
    documentType: EnvironmentDocument,
    environmentName: string,
  ): Promise<Result<DocumentResolutionResult, EnvironmentError>>;

  resolveAll(environmentName: string): Promise<Result<OverlayResolution, EnvironmentError>>;

  listEnvironments(): Promise<Result<Environment[], EnvironmentError>>;
}

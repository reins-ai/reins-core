export const ENVIRONMENT_DOCUMENTS = [
  "PERSONALITY",
  "USER",
  "HEARTBEAT",
  "ROUTINES",
  "GOALS",
  "KNOWLEDGE",
  "TOOLS",
  "BOUNDARIES",
] as const;

export type EnvironmentDocument = (typeof ENVIRONMENT_DOCUMENTS)[number];

export type EnvironmentDocumentMap = Partial<Record<EnvironmentDocument, string>>;

export interface Environment {
  name: string;
  path: string;
  documents: EnvironmentDocumentMap;
}

export interface EnvironmentDocumentContent {
  type: EnvironmentDocument;
  path: string;
  content: string;
  environmentName: string;
  loadedAt: Date;
}

export type DocumentSource = "active" | "default";

export interface DocumentResolutionResult {
  type: EnvironmentDocument;
  source: DocumentSource;
  sourceEnvironment: string;
  document: EnvironmentDocumentContent;
}

export interface OverlayResolution {
  activeEnvironment: string;
  fallbackEnvironment: string;
  documents: Record<EnvironmentDocument, DocumentResolutionResult>;
}

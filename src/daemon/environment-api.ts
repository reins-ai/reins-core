import type { EnvironmentErrorCode } from "../environment/errors";
import type { EnvironmentDocument, OverlayResolution } from "../environment/types";

export interface EnvironmentSwitchRequest {
  name: string;
}

export interface EnvironmentSwitchResponse {
  activeEnvironment: string;
  previousEnvironment: string;
  switchedAt: string;
  resolution: OverlayResolutionDto;
}

export interface EnvironmentListRequest {
  includeDocumentTypes?: boolean;
}

export interface EnvironmentListResponse {
  activeEnvironment: string;
  environments: EnvironmentSummaryDto[];
}

export interface EnvironmentStatusRequest {
  environmentName?: string;
}

export interface EnvironmentStatusResponse {
  activeEnvironment: string;
  resolution: OverlayResolutionDto;
}

export interface EnvironmentErrorResponse {
  error: string;
  code: EnvironmentErrorCode;
}

export interface EnvironmentSummaryDto {
  name: string;
  path: string;
  availableDocumentTypes: EnvironmentDocument[];
}

export interface OverlayResolutionDto {
  activeEnvironment: string;
  fallbackEnvironment: string;
  documents: Record<EnvironmentDocument, DocumentResolutionDto>;
}

export interface DocumentResolutionDto {
  type: EnvironmentDocument;
  source: "active" | "default";
  sourceEnvironment: string;
  document: EnvironmentDocumentDto;
}

export interface EnvironmentDocumentDto {
  type: EnvironmentDocument;
  path: string;
  content: string;
  environmentName: string;
  loadedAt: string;
}

export function toOverlayResolutionDto(resolution: OverlayResolution): OverlayResolutionDto {
  const documents = {} as Record<EnvironmentDocument, DocumentResolutionDto>;

  for (const [documentType, result] of Object.entries(resolution.documents)) {
    const type = documentType as EnvironmentDocument;

    documents[type] = {
      type,
      source: result.source,
      sourceEnvironment: result.sourceEnvironment,
      document: {
        type,
        path: result.document.path,
        content: result.document.content,
        environmentName: result.document.environmentName,
        loadedAt: result.document.loadedAt.toISOString(),
      },
    };
  }

  return {
    activeEnvironment: resolution.activeEnvironment,
    fallbackEnvironment: resolution.fallbackEnvironment,
    documents,
  };
}

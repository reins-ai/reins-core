export const TRUNCATION_MARKER =
  "\n\n[Content truncated — full document available on request]";

export function truncateSection(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  const maxContentChars = maxChars - TRUNCATION_MARKER.length;

  if (maxContentChars <= 0) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }

  const candidate = content.slice(0, maxContentChars).trimEnd();
  const truncationPoint = findTruncationPoint(candidate);
  const truncatedContent = candidate.slice(0, truncationPoint).trimEnd();

  if (truncatedContent.length === 0) {
    return TRUNCATION_MARKER.trimStart();
  }

  return `${truncatedContent}${TRUNCATION_MARKER}`;
}

function findTruncationPoint(candidate: string): number {
  const paragraphBoundary = candidate.lastIndexOf("\n\n");

  if (paragraphBoundary > 0) {
    return paragraphBoundary;
  }

  const lineBoundary = candidate.lastIndexOf("\n");

  if (lineBoundary > 0) {
    return lineBoundary;
  }

  return candidate.length;
}

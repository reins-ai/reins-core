import { err, ok, type Result } from "../result";
import { DocumentNotFoundError, type EnvironmentError } from "./errors";
import type { EnvironmentResolver } from "./resolver";
import type { EnvironmentDocument } from "./types";

const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;

export class DocumentLoader {
  constructor(private readonly resolver: EnvironmentResolver) {}

  async loadDocument(
    docType: EnvironmentDocument,
    envName: string,
  ): Promise<Result<string, EnvironmentError>> {
    const result = await this.resolver.resolveDocument(docType, envName);

    if (!result.ok) {
      return err(result.error);
    }

    return ok(result.value.document.content);
  }

  async loadSection(
    docType: EnvironmentDocument,
    envName: string,
    sectionHeading: string,
  ): Promise<Result<string, EnvironmentError>> {
    const documentResult = await this.loadDocument(docType, envName);

    if (!documentResult.ok) {
      return err(documentResult.error);
    }

    const section = extractMarkdownSection(documentResult.value, sectionHeading);

    if (!section) {
      return err(new DocumentNotFoundError(`${docType} section \"${sectionHeading}\"`, envName));
    }

    return ok(section);
  }
}

function extractMarkdownSection(content: string, sectionHeading: string): string | undefined {
  const lines = content.split("\n");
  const target = normalizeHeading(sectionHeading);

  let startIndex = -1;
  let sectionLevel = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(HEADING_PATTERN);

    if (!match) {
      continue;
    }

    const heading = normalizeHeading(match[2]);

    if (heading === target) {
      startIndex = index;
      sectionLevel = match[1].length;
      break;
    }
  }

  if (startIndex === -1) {
    return undefined;
  }

  let endIndex = lines.length;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const match = lines[index].match(HEADING_PATTERN);

    if (!match) {
      continue;
    }

    const headingLevel = match[1].length;

    if (headingLevel <= sectionLevel) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join("\n").trim();
}

function normalizeHeading(heading: string): string {
  return heading.replace(/^#+\s*/, "").replace(/\s+#+\s*$/, "").trim().toLowerCase();
}

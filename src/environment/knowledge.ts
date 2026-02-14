/**
 * On-demand retrieval service for structured KNOWLEDGE.md entries.
 *
 * Parses markdown into section/entry structure and supports lookup by
 * section name or keyword. This is a static file-based retrieval path,
 * not a vector/semantic search.
 */

const H2_PATTERN = /^##\s+(.+)$/;
const H3_PATTERN = /^###\s+(.+)$/;

export interface KnowledgeEntry {
  /** Top-level section name (e.g., "People") */
  section: string;
  /** Sub-entry heading or identifier */
  key: string;
  /** Content of the entry (without the heading line) */
  value: string;
  /** Raw markdown of the entry (including heading) */
  raw: string;
}

export interface KnowledgeDocument {
  sections: string[];
  entries: KnowledgeEntry[];
}

/**
 * Parse a KNOWLEDGE.md document into structured sections and entries.
 *
 * Structure expectations:
 * - `## Heading` defines a top-level section (People, Places, Health, etc.)
 * - `### Heading` defines a sub-entry within the current section
 * - Content between sub-headings (or between a section heading and the next
 *   heading) is captured as the entry value.
 * - Sections without `###` sub-entries produce a single entry keyed by the
 *   section name with all section content as the value.
 */
export function parseKnowledgeDocument(content: string): KnowledgeDocument {
  if (!content.trim()) {
    return { sections: [], entries: [] };
  }

  const lines = content.split("\n");
  const sections: string[] = [];
  const entries: KnowledgeEntry[] = [];

  let currentSection: string | null = null;
  let currentKey: string | null = null;
  let currentRawLines: string[] = [];
  let currentValueLines: string[] = [];
  let sectionContentLines: string[] = [];
  let hasSubEntries = false;

  function flushEntry(): void {
    if (currentSection && currentKey) {
      const raw = currentRawLines.join("\n").trim();
      const value = currentValueLines.join("\n").trim();

      if (raw) {
        entries.push({
          section: currentSection,
          key: currentKey,
          value,
          raw,
        });
      }
    }
    currentKey = null;
    currentRawLines = [];
    currentValueLines = [];
  }

  function flushSectionContent(): void {
    if (currentSection && !hasSubEntries && sectionContentLines.length > 0) {
      const raw = sectionContentLines.join("\n").trim();
      const value = raw;

      if (raw) {
        entries.push({
          section: currentSection,
          key: currentSection,
          value,
          raw,
        });
      }
    }
    sectionContentLines = [];
    hasSubEntries = false;
  }

  for (const line of lines) {
    const h2Match = line.match(H2_PATTERN);

    if (h2Match) {
      const sectionName = h2Match[1].trim();

      // Flush any pending sub-entry
      flushEntry();
      // Flush section-level content if no sub-entries existed
      flushSectionContent();

      // Skip meta sections that aren't knowledge content
      if (isMetaSection(sectionName)) {
        currentSection = null;
        continue;
      }

      currentSection = sectionName;
      sections.push(sectionName);
      continue;
    }

    if (!currentSection) {
      continue;
    }

    const h3Match = line.match(H3_PATTERN);

    if (h3Match) {
      // Flush previous sub-entry
      flushEntry();
      hasSubEntries = true;

      currentKey = h3Match[1].trim();
      currentRawLines = [line];
      currentValueLines = [];
      continue;
    }

    if (currentKey) {
      // Accumulate lines for the current sub-entry
      currentRawLines.push(line);
      currentValueLines.push(line);
    } else {
      // Accumulate section-level content (no sub-entry yet)
      sectionContentLines.push(line);
    }
  }

  // Flush final pending entry and section content
  flushEntry();
  flushSectionContent();

  return { sections, entries };
}

/**
 * Sections that are structural/meta and should not be treated as knowledge entries.
 */
function isMetaSection(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "how this works" ||
    lower === "custom sections" ||
    lower === "usage notes"
  );
}

/**
 * Stateless knowledge retrieval service.
 *
 * Accepts pre-parsed knowledge or raw markdown and provides query methods
 * for section-based and keyword-based lookup.
 */
export class KnowledgeService {
  private readonly doc: KnowledgeDocument;

  constructor(content: string) {
    this.doc = parseKnowledgeDocument(content);
  }

  /**
   * List all available top-level section names.
   */
  listSections(): string[] {
    return [...this.doc.sections];
  }

  /**
   * Get all entries within a section (case-insensitive match).
   */
  getSection(name: string): KnowledgeEntry[] {
    const target = name.toLowerCase();
    return this.doc.entries.filter(
      (entry) => entry.section.toLowerCase() === target,
    );
  }

  /**
   * Query entries by section name or content keyword (case-insensitive).
   *
   * Matches if the query appears in:
   * - The section name
   * - The entry key (sub-heading)
   * - The entry value (content body)
   */
  query(sectionOrKeyword: string): KnowledgeEntry[] {
    const target = sectionOrKeyword.toLowerCase();

    return this.doc.entries.filter((entry) => {
      const sectionMatch = entry.section.toLowerCase().includes(target);
      const keyMatch = entry.key.toLowerCase().includes(target);
      const valueMatch = entry.value.toLowerCase().includes(target);
      return sectionMatch || keyMatch || valueMatch;
    });
  }

  /**
   * Returns the total number of parsed entries.
   */
  get entryCount(): number {
    return this.doc.entries.length;
  }
}

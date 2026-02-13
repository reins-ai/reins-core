import { createHash } from "node:crypto";

import { ok, err, type Result } from "../../result";
import { ReinsError } from "../../errors";

export const CHUNKING_STRATEGIES = ["heading", "fixed", "paragraph"] as const;

export type ChunkingStrategy = (typeof CHUNKING_STRATEGIES)[number];

export interface ChunkingConfig {
  strategy: ChunkingStrategy;
  maxChunkSize: number;
  minChunkSize: number;
  overlapSize: number;
  respectHeadings: boolean;
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  strategy: "heading",
  maxChunkSize: 1000,
  minChunkSize: 100,
  overlapSize: 100,
  respectHeadings: true,
};

export interface ChunkMetadata {
  wordCount: number;
  hasCode: boolean;
  hasLinks: boolean;
}

export interface DocumentChunk {
  id: string;
  sourcePath: string;
  sourceId: string;
  heading: string | null;
  headingHierarchy: string[];
  content: string;
  startOffset: number;
  endOffset: number;
  chunkIndex: number;
  totalChunks: number;
  metadata: ChunkMetadata;
}

export class ChunkingError extends ReinsError {
  constructor(message: string) {
    super(message, "CHUNKING_ERROR");
    this.name = "ChunkingError";
  }
}

interface HeadingSection {
  heading: string | null;
  headingLevel: number;
  headingHierarchy: string[];
  content: string;
  startOffset: number;
  endOffset: number;
}

export class MarkdownChunker {
  private readonly config: ChunkingConfig;

  constructor(config?: Partial<ChunkingConfig>) {
    this.config = { ...DEFAULT_CHUNKING_CONFIG, ...config };
  }

  chunk(content: string, sourcePath: string, sourceId: string): Result<DocumentChunk[]> {
    if (content.length === 0) {
      return ok([]);
    }

    let rawChunks: Array<{
      content: string;
      startOffset: number;
      endOffset: number;
      heading: string | null;
      headingHierarchy: string[];
    }>;

    switch (this.config.strategy) {
      case "heading":
        rawChunks = this.chunkByHeadings(content);
        break;
      case "fixed":
        rawChunks = this.chunkByFixedSize(content);
        break;
      case "paragraph":
        rawChunks = this.chunkByParagraphs(content);
        break;
      default:
        return err(new ChunkingError(`Unknown chunking strategy: ${this.config.strategy as string}`));
    }

    if (rawChunks.length === 0) {
      return ok([]);
    }

    const totalChunks = rawChunks.length;
    const chunks: DocumentChunk[] = rawChunks.map((raw, index) => ({
      id: this.generateChunkId(sourcePath, raw.startOffset, this.hashContent(raw.content)),
      sourcePath,
      sourceId,
      heading: raw.heading,
      headingHierarchy: raw.headingHierarchy,
      content: raw.content,
      startOffset: raw.startOffset,
      endOffset: raw.endOffset,
      chunkIndex: index,
      totalChunks,
      metadata: this.extractMetadata(raw.content),
    }));

    return ok(chunks);
  }

  generateChunkId(sourcePath: string, startOffset: number, contentHash: string): string {
    const input = `${sourcePath}:${startOffset}:${contentHash}`;
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
  }

  private chunkByHeadings(content: string): Array<{
    content: string;
    startOffset: number;
    endOffset: number;
    heading: string | null;
    headingHierarchy: string[];
  }> {
    const sections = this.parseHeadingSections(content);
    const result: Array<{
      content: string;
      startOffset: number;
      endOffset: number;
      heading: string | null;
      headingHierarchy: string[];
    }> = [];

    for (const section of sections) {
      if (section.content.length <= this.config.maxChunkSize) {
        if (section.content.trim().length > 0) {
          result.push({
            content: section.content,
            startOffset: section.startOffset,
            endOffset: section.endOffset,
            heading: section.heading,
            headingHierarchy: section.headingHierarchy,
          });
        }
      } else {
        const subChunks = this.splitLargeSection(section);
        result.push(...subChunks);
      }
    }

    return this.applyOverlap(result);
  }

  private parseHeadingSections(content: string): HeadingSection[] {
    const headingRegex = /^(#{1,4})\s+(.+)$/gm;
    const sections: HeadingSection[] = [];
    const matches: Array<{ level: number; text: string; index: number }> = [];

    let match: RegExpExecArray | null;
    while ((match = headingRegex.exec(content)) !== null) {
      matches.push({
        level: match[1].length,
        text: match[0],
        index: match.index,
      });
    }

    if (matches.length === 0) {
      return [{
        heading: null,
        headingLevel: 0,
        headingHierarchy: [],
        content,
        startOffset: 0,
        endOffset: content.length,
      }];
    }

    // Content before first heading
    if (matches[0].index > 0) {
      const preContent = content.slice(0, matches[0].index);
      if (preContent.trim().length > 0) {
        sections.push({
          heading: null,
          headingLevel: 0,
          headingHierarchy: [],
          content: preContent,
          startOffset: 0,
          endOffset: matches[0].index,
        });
      }
    }

    const hierarchyStack: Array<{ level: number; text: string }> = [];

    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const nextIndex = i + 1 < matches.length ? matches[i + 1].index : content.length;
      const sectionContent = content.slice(current.index, nextIndex);

      // Update hierarchy stack
      while (hierarchyStack.length > 0 && hierarchyStack[hierarchyStack.length - 1].level >= current.level) {
        hierarchyStack.pop();
      }
      hierarchyStack.push({ level: current.level, text: current.text });

      sections.push({
        heading: current.text,
        headingLevel: current.level,
        headingHierarchy: hierarchyStack.map((h) => h.text),
        content: sectionContent,
        startOffset: current.index,
        endOffset: nextIndex,
      });
    }

    return sections;
  }

  private splitLargeSection(section: HeadingSection): Array<{
    content: string;
    startOffset: number;
    endOffset: number;
    heading: string | null;
    headingHierarchy: string[];
  }> {
    const paragraphs = section.content.split(/\n\n+/);
    const result: Array<{
      content: string;
      startOffset: number;
      endOffset: number;
      heading: string | null;
      headingHierarchy: string[];
    }> = [];

    let currentChunk = "";
    let currentStart = section.startOffset;
    let runningOffset = section.startOffset;

    for (const paragraph of paragraphs) {
      const paragraphWithSeparator = paragraph + "\n\n";
      const candidateLength = currentChunk.length + paragraphWithSeparator.length;

      if (candidateLength > this.config.maxChunkSize && currentChunk.length > 0) {
        result.push({
          content: currentChunk.trimEnd(),
          startOffset: currentStart,
          endOffset: currentStart + currentChunk.trimEnd().length,
          heading: section.heading,
          headingHierarchy: section.headingHierarchy,
        });
        currentStart = runningOffset;
        currentChunk = "";
      }

      if (paragraphWithSeparator.length > this.config.maxChunkSize) {
        if (currentChunk.length > 0) {
          result.push({
            content: currentChunk.trimEnd(),
            startOffset: currentStart,
            endOffset: currentStart + currentChunk.trimEnd().length,
            heading: section.heading,
            headingHierarchy: section.headingHierarchy,
          });
          currentChunk = "";
          currentStart = runningOffset;
        }

        const sentenceChunks = this.splitBySentences(paragraph, runningOffset, section);
        result.push(...sentenceChunks);
        runningOffset += paragraphWithSeparator.length;
        currentStart = runningOffset;
      } else {
        currentChunk += paragraphWithSeparator;
        runningOffset += paragraphWithSeparator.length;
      }
    }

    if (currentChunk.trim().length > 0) {
      result.push({
        content: currentChunk.trimEnd(),
        startOffset: currentStart,
        endOffset: currentStart + currentChunk.trimEnd().length,
        heading: section.heading,
        headingHierarchy: section.headingHierarchy,
      });
    }

    return result;
  }

  private splitBySentences(
    text: string,
    baseOffset: number,
    section: HeadingSection,
  ): Array<{
    content: string;
    startOffset: number;
    endOffset: number;
    heading: string | null;
    headingHierarchy: string[];
  }> {
    const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text];
    const result: Array<{
      content: string;
      startOffset: number;
      endOffset: number;
      heading: string | null;
      headingHierarchy: string[];
    }> = [];

    let currentChunk = "";
    let currentStart = baseOffset;
    let runningOffset = baseOffset;

    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > this.config.maxChunkSize && currentChunk.length > 0) {
        result.push({
          content: currentChunk.trimEnd(),
          startOffset: currentStart,
          endOffset: currentStart + currentChunk.trimEnd().length,
          heading: section.heading,
          headingHierarchy: section.headingHierarchy,
        });
        currentStart = runningOffset;
        currentChunk = "";
      }
      currentChunk += sentence;
      runningOffset += sentence.length;
    }

    if (currentChunk.trim().length > 0) {
      result.push({
        content: currentChunk.trimEnd(),
        startOffset: currentStart,
        endOffset: currentStart + currentChunk.trimEnd().length,
        heading: section.heading,
        headingHierarchy: section.headingHierarchy,
      });
    }

    return result;
  }

  private chunkByFixedSize(content: string): Array<{
    content: string;
    startOffset: number;
    endOffset: number;
    heading: string | null;
    headingHierarchy: string[];
  }> {
    const result: Array<{
      content: string;
      startOffset: number;
      endOffset: number;
      heading: string | null;
      headingHierarchy: string[];
    }> = [];

    const step = this.config.maxChunkSize - this.config.overlapSize;
    let offset = 0;

    while (offset < content.length) {
      const end = Math.min(offset + this.config.maxChunkSize, content.length);
      const chunkContent = content.slice(offset, end);

      if (chunkContent.trim().length > 0) {
        result.push({
          content: chunkContent,
          startOffset: offset,
          endOffset: end,
          heading: null,
          headingHierarchy: [],
        });
      }

      if (end >= content.length) break;
      offset += step;
    }

    return result;
  }

  private chunkByParagraphs(content: string): Array<{
    content: string;
    startOffset: number;
    endOffset: number;
    heading: string | null;
    headingHierarchy: string[];
  }> {
    const paragraphs = content.split(/\n\n+/);
    const result: Array<{
      content: string;
      startOffset: number;
      endOffset: number;
      heading: string | null;
      headingHierarchy: string[];
    }> = [];

    let currentChunk = "";
    let currentStart = 0;
    let runningOffset = 0;

    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      const separator = i < paragraphs.length - 1 ? "\n\n" : "";
      const paragraphWithSep = paragraph + separator;

      if (currentChunk.length + paragraphWithSep.length > this.config.maxChunkSize && currentChunk.length > 0) {
        result.push({
          content: currentChunk.trimEnd(),
          startOffset: currentStart,
          endOffset: currentStart + currentChunk.trimEnd().length,
          heading: null,
          headingHierarchy: [],
        });
        currentStart = runningOffset;
        currentChunk = "";
      }

      currentChunk += paragraphWithSep;

      // Advance offset past the paragraph and the separator that follows it in the original
      const nextParagraphStart = content.indexOf(paragraph, runningOffset) + paragraph.length;
      const nextNonNewline = content.slice(nextParagraphStart).search(/[^\n]/);
      runningOffset = nextNonNewline === -1 ? content.length : nextParagraphStart + nextNonNewline;
    }

    if (currentChunk.trim().length > 0) {
      result.push({
        content: currentChunk.trimEnd(),
        startOffset: currentStart,
        endOffset: currentStart + currentChunk.trimEnd().length,
        heading: null,
        headingHierarchy: [],
      });
    }

    return this.applyOverlap(result);
  }

  private applyOverlap(chunks: Array<{
    content: string;
    startOffset: number;
    endOffset: number;
    heading: string | null;
    headingHierarchy: string[];
  }>): Array<{
    content: string;
    startOffset: number;
    endOffset: number;
    heading: string | null;
    headingHierarchy: string[];
  }> {
    if (chunks.length <= 1 || this.config.overlapSize <= 0) {
      return chunks;
    }

    const result = [chunks[0]];

    for (let i = 1; i < chunks.length; i++) {
      const prevChunk = chunks[i - 1];
      const overlapText = prevChunk.content.slice(-this.config.overlapSize);
      const overlapStart = prevChunk.endOffset - overlapText.length;

      result.push({
        ...chunks[i],
        content: overlapText + chunks[i].content,
        startOffset: overlapStart,
      });
    }

    return result;
  }

  private extractMetadata(content: string): ChunkMetadata {
    const words = content.split(/\s+/).filter((w) => w.length > 0);
    const hasCode = /```[\s\S]*?```|`[^`]+`/.test(content);
    const hasLinks = /\[.+?\]\(.+?\)|https?:\/\/\S+/.test(content);

    return {
      wordCount: words.length,
      hasCode,
      hasLinks,
    };
  }

  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  }
}

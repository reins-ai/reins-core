import type { MemoryPrimingItem } from "../memory-priming-contract";

const CHARS_PER_TOKEN = 4;

export interface PackedContext {
  text: string;
  memoriesIncluded: number;
  tokensUsed: number;
  memoriesTruncated: number;
}

export interface ContextPackerConfig {
  tokenBudget: number;
  format: "brief" | "detailed";
  includeSources: boolean;
}

interface RankedMemory {
  memory: MemoryPrimingItem;
  index: number;
}

function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
}

function formatMemoryLine(memory: MemoryPrimingItem, config: ContextPackerConfig): string {
  const relevance = clampScore(memory.relevanceScore).toFixed(2);
  const importance = clampScore(memory.importance).toFixed(2);

  if (config.format === "detailed") {
    const sourceLine = config.includeSources && memory.source
      ? `\n  Source: ${memory.source}`
      : "";

    return [
      `- Type: ${memory.type}`,
      `  Relevance: ${relevance}`,
      `  Importance: ${importance}`,
      `  Content: ${memory.content}${sourceLine}`,
    ].join("\n");
  }

  const sourceSuffix = config.includeSources && memory.source ? ` | source: ${memory.source}` : "";
  return `- [${memory.type}] rel:${relevance} imp:${importance} ${memory.content}${sourceSuffix}`;
}

function rankMemories(memories: MemoryPrimingItem[]): MemoryPrimingItem[] {
  const withIndex: RankedMemory[] = memories.map((memory, index) => ({
    memory,
    index,
  }));

  withIndex.sort((left, right) => {
    if (right.memory.relevanceScore !== left.memory.relevanceScore) {
      return right.memory.relevanceScore - left.memory.relevanceScore;
    }

    if (right.memory.importance !== left.memory.importance) {
      return right.memory.importance - left.memory.importance;
    }

    return left.index - right.index;
  });

  return withIndex.map((item) => item.memory);
}

export class ContextPacker {
  pack(memories: MemoryPrimingItem[], config: ContextPackerConfig): PackedContext {
    if (memories.length === 0 || config.tokenBudget <= 0) {
      return {
        text: "",
        memoriesIncluded: 0,
        tokensUsed: 0,
        memoriesTruncated: memories.length,
      };
    }

    const ranked = rankMemories(memories);
    const header = "Relevant memory context:\n";
    const headerTokens = estimateTokens(header);

    if (headerTokens >= config.tokenBudget) {
      return {
        text: "",
        memoriesIncluded: 0,
        tokensUsed: 0,
        memoriesTruncated: memories.length,
      };
    }

    const includedLines: string[] = [];
    let tokensUsed = headerTokens;

    for (let index = 0; index < ranked.length; index += 1) {
      const candidateLine = formatMemoryLine(ranked[index], config);
      const nextLine = `${candidateLine}\n`;
      const lineTokens = estimateTokens(nextLine);

      if (tokensUsed + lineTokens > config.tokenBudget) {
        return {
          text: includedLines.length === 0 ? "" : `${header}${includedLines.join("\n")}`,
          memoriesIncluded: includedLines.length,
          tokensUsed: includedLines.length === 0 ? 0 : tokensUsed,
          memoriesTruncated: ranked.length - includedLines.length,
        };
      }

      includedLines.push(candidateLine);
      tokensUsed += lineTokens;
    }

    return {
      text: `${header}${includedLines.join("\n")}`,
      memoriesIncluded: includedLines.length,
      tokensUsed,
      memoriesTruncated: 0,
    };
  }
}

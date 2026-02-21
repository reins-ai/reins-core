import type {
  UnifiedDocumentResultMetadata,
  UnifiedMemoryRetrieval,
  UnifiedSearchResult,
} from "../search/unified-memory-retrieval";

const DOCUMENT_TOP_K = 3;
const WORDS_PER_TOKEN = 0.75;

interface RagContextInjectorOptions {
  retrieval?: UnifiedMemoryRetrieval | null;
}

interface ContextChunk {
  source: string;
  score: number;
  words: string[];
}

interface DocumentUnifiedSearchResult extends UnifiedSearchResult {
  source: "document";
  metadata: UnifiedDocumentResultMetadata;
}

export class RagContextInjector {
  private readonly retrieval: UnifiedMemoryRetrieval | null;

  constructor(options: RagContextInjectorOptions) {
    this.retrieval = options.retrieval ?? null;
  }

  async getRelevantContext(userMessage: string, maxTokens: number): Promise<string | null> {
    const normalizedMessage = userMessage.trim();
    if (normalizedMessage.length === 0 || maxTokens <= 0 || !this.retrieval) {
      return null;
    }

    const searchResult = await this.retrieval.searchDocumentsOnly(normalizedMessage, DOCUMENT_TOP_K);
    if (!searchResult.ok || searchResult.value.length === 0) {
      return null;
    }

    const sortedChunks = searchResult.value
      .filter((result): result is DocumentUnifiedSearchResult => isDocumentSearchResult(result))
      .map((result) => ({
        source: result.metadata.sourcePath,
        score: result.score,
        rank: result.rank,
        words: splitWords(result.content),
      }))
      .filter((chunk) => chunk.words.length > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.rank - right.rank;
      })
      .map((chunk) => ({
        source: chunk.source,
        score: chunk.score,
        words: chunk.words,
      }));

    if (sortedChunks.length === 0) {
      return null;
    }

    const fittedChunks = this.fitChunksToBudget(sortedChunks, maxTokens);
    if (fittedChunks.length === 0) {
      return null;
    }

    return fittedChunks
      .map((chunk) => formatContextBlock(chunk.source, chunk.words.join(" ")))
      .join("\n\n");
  }

  private fitChunksToBudget(chunks: ContextChunk[], maxTokens: number): ContextChunk[] {
    const working = chunks.map((chunk) => ({
      source: chunk.source,
      score: chunk.score,
      words: [...chunk.words],
    }));

    if (this.estimateTotalTokens(working) <= maxTokens) {
      return working;
    }

    for (let index = working.length - 1; index >= 0; index -= 1) {
      const others = working.filter((_, itemIndex) => itemIndex !== index);
      const budgetWithoutCurrent = this.estimateTotalTokens(others);
      const current = working[index];
      const wrapperTokens = estimateTokens(`[Document context from: ${current.source}]\n[End context]`);
      const remainingTokensForContent = maxTokens - budgetWithoutCurrent - wrapperTokens;

      if (remainingTokensForContent <= 0) {
        working.splice(index, 1);
      } else {
        const allowedWords = Math.max(0, Math.floor(remainingTokensForContent * WORDS_PER_TOKEN));
        if (allowedWords === 0) {
          working.splice(index, 1);
        } else if (allowedWords < current.words.length) {
          current.words = current.words.slice(0, allowedWords);
        }
      }

      if (this.estimateTotalTokens(working) <= maxTokens) {
        return working;
      }
    }

    while (working.length > 0 && this.estimateTotalTokens(working) > maxTokens) {
      working.pop();
    }

    return working;
  }

  private estimateTotalTokens(chunks: ContextChunk[]): number {
    const context = chunks
      .map((chunk) => formatContextBlock(chunk.source, chunk.words.join(" ")))
      .join("\n\n");

    return estimateTokens(context);
  }
}

function isDocumentMetadata(
  metadata: UnifiedSearchResult["metadata"],
): metadata is UnifiedDocumentResultMetadata {
  return typeof (metadata as UnifiedDocumentResultMetadata).sourcePath === "string";
}

function isDocumentSearchResult(result: UnifiedSearchResult): result is DocumentUnifiedSearchResult {
  return result.source === "document" && isDocumentMetadata(result.metadata);
}

function splitWords(content: string): string[] {
  return content
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function estimateTokens(content: string): number {
  const words = splitWords(content).length;
  if (words === 0) {
    return 0;
  }

  return Math.ceil(words / WORDS_PER_TOKEN);
}

function formatContextBlock(source: string, content: string): string {
  return `[Document context from: ${source}]\n${content}\n[End context]`;
}

import { err, ok, type Result } from "../../result";
import { ReinsError } from "../../errors";
import type {
  DocumentSearchProvider,
  DocumentSearchResult,
} from "../search/unified-memory-retrieval";
import type { HybridDocumentSearch } from "./document-semantic-search";
import type { DocumentIndexer, IndexedChunk } from "./document-indexer";
import type { DocumentSourceRegistry } from "./document-source-registry";

export class DocumentSearchAdapterError extends ReinsError {
  constructor(message: string, code = "DOCUMENT_SEARCH_ADAPTER_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "DocumentSearchAdapterError";
  }
}

export interface DocumentSearchAdapterDependencies {
  hybridSearch: HybridDocumentSearch;
  indexer: DocumentIndexer;
  registry: DocumentSourceRegistry;
}

/**
 * Adapts `HybridDocumentSearch` to the `DocumentSearchProvider` interface
 * expected by `UnifiedMemoryRetrieval`.
 *
 * Bridges the gap between the indexer's chunk storage and the hybrid search
 * engine by enumerating registered sources via the registry and fetching
 * their chunks from the indexer.
 */
export class DocumentSearchAdapter implements DocumentSearchProvider {
  private readonly hybridSearch: HybridDocumentSearch;
  private readonly indexer: DocumentIndexer;
  private readonly registry: DocumentSourceRegistry;

  constructor(dependencies: DocumentSearchAdapterDependencies) {
    this.hybridSearch = dependencies.hybridSearch;
    this.indexer = dependencies.indexer;
    this.registry = dependencies.registry;
  }

  async search(
    query: string,
    topK: number,
    filters?: { sourceIds?: string[] },
  ): Promise<Result<DocumentSearchResult[]>> {
    try {
      const chunks = this.getChunksFromIndexer(filters);
      if (chunks.length === 0) {
        return ok([]);
      }

      const ranked = await this.hybridSearch.search(query, chunks, { topK });
      const results: DocumentSearchResult[] = ranked.map((item) => ({
        chunkId: item.chunk.id,
        content: item.chunk.content,
        score: item.score,
        sourcePath: item.chunk.sourcePath,
        heading: item.chunk.heading,
        headingHierarchy: item.chunk.headingHierarchy,
        sourceId: item.chunk.sourceId,
        chunkIndex: item.chunk.chunkIndex,
      }));

      return ok(results);
    } catch (error) {
      return err(
        new DocumentSearchAdapterError(
          "Document search adapter query failed",
          "DOCUMENT_SEARCH_ADAPTER_QUERY_ERROR",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  private getChunksFromIndexer(filters?: { sourceIds?: string[] }): IndexedChunk[] {
    const sourceIds = filters?.sourceIds;
    if (sourceIds && sourceIds.length > 0) {
      return this.getChunksBySourceIds(sourceIds);
    }

    return this.getAllChunks();
  }

  private getChunksBySourceIds(sourceIds: string[]): IndexedChunk[] {
    const chunks: IndexedChunk[] = [];
    for (const sourceId of sourceIds) {
      const sourceChunks = this.indexer.getChunksBySource(sourceId);
      for (const chunk of sourceChunks) {
        chunks.push(chunk);
      }
    }

    return chunks;
  }

  private getAllChunks(): IndexedChunk[] {
    const sources = this.registry.list({ status: "indexed" });
    const chunks: IndexedChunk[] = [];

    for (const source of sources) {
      const sourceChunks = this.indexer.getChunksBySource(source.id);
      for (const chunk of sourceChunks) {
        chunks.push(chunk);
      }
    }

    return chunks;
  }
}

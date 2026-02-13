import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type {
  MemoryLayer,
  MemoryType,
  ProvenanceRecord,
} from "../types/index";

const DEFAULT_TOP_K = 10;
const DEFAULT_MIN_SCORE = 0.1;
const DEFAULT_MEMORY_WEIGHT = 0.5;
const DEFAULT_DOCUMENT_WEIGHT = 0.5;
const DEFAULT_NORMALIZE_SCORES = true;
const DEFAULT_MAX_RESULTS_PER_SOURCE = 20;

export type UnifiedResultSource = "memory" | "document";

export interface UnifiedMemoryResultMetadata {
  type: MemoryType;
  layer: MemoryLayer;
  importance: number;
  tags: string[];
  conversationId?: string;
}

export interface UnifiedDocumentResultMetadata {
  sourcePath: string;
  heading: string | null;
  headingHierarchy: string[];
  sourceId: string;
  chunkIndex: number;
}

export interface UnifiedSearchResult {
  id: string;
  source: UnifiedResultSource;
  content: string;
  score: number;
  rank: number;
  metadata: UnifiedMemoryResultMetadata | UnifiedDocumentResultMetadata;
  provenance?: ProvenanceRecord;
}

export interface UnifiedSearchQuery {
  query: string;
  topK?: number;
  sources?: UnifiedResultSource[];
  memoryFilters?: {
    types?: MemoryType[];
    layers?: MemoryLayer[];
    minImportance?: number;
  };
  documentFilters?: {
    sourceIds?: string[];
    paths?: string[];
  };
  minScore?: number;
}

export interface UnifiedSearchConfig {
  memoryWeight?: number;
  documentWeight?: number;
  normalizeScores?: boolean;
  maxResultsPerSource?: number;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  score: number;
  type: MemoryType;
  layer: MemoryLayer;
  importance: number;
  tags: string[];
  conversationId?: string;
  provenance?: ProvenanceRecord;
}

export interface MemorySearchProvider {
  search(
    query: string,
    options: {
      topK: number;
      types?: MemoryType[];
      layers?: MemoryLayer[];
      minImportance?: number;
    },
  ): Promise<Result<MemorySearchResult[]>>;
}

export interface DocumentSearchResult {
  chunkId: string;
  content: string;
  score: number;
  sourcePath: string;
  heading: string | null;
  headingHierarchy: string[];
  sourceId: string;
  chunkIndex: number;
}

export interface DocumentSearchProvider {
  search(
    query: string,
    topK: number,
    filters?: { sourceIds?: string[] },
  ): Promise<Result<DocumentSearchResult[]>>;
}

export interface UnifiedMemoryRetrievalDependencies {
  memorySearch: MemorySearchProvider;
  documentSearch: DocumentSearchProvider;
  config?: UnifiedSearchConfig;
}

export class UnifiedMemoryRetrievalError extends ReinsError {
  constructor(message: string, code = "UNIFIED_MEMORY_RETRIEVAL_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "UnifiedMemoryRetrievalError";
  }
}

interface SourceWeights {
  memory: number;
  document: number;
}

interface ScoredMemoryResult {
  source: "memory";
  normalizedScore: number;
  result: MemorySearchResult;
}

interface ScoredDocumentResult {
  source: "document";
  normalizedScore: number;
  result: DocumentSearchResult;
}

type ScoredResult = ScoredMemoryResult | ScoredDocumentResult;

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

function clamp01(value: number): number {
  if (value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
}

function normalizeValues(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }

  let min = values[0];
  let max = values[0];

  for (let index = 1; index < values.length; index += 1) {
    min = Math.min(min, values[index]);
    max = Math.max(max, values[index]);
  }

  if (max === min) {
    if (max <= 0) {
      return values.map(() => 0);
    }

    return values.map(() => 1);
  }

  const range = max - min;
  return values.map((value) => clamp01((value - min) / range));
}

function normalizeWeightPair(memoryWeight: number, documentWeight: number): SourceWeights {
  const safeMemory = Math.max(0, memoryWeight);
  const safeDocument = Math.max(0, documentWeight);
  const total = safeMemory + safeDocument;

  if (total === 0) {
    return {
      memory: DEFAULT_MEMORY_WEIGHT,
      document: DEFAULT_DOCUMENT_WEIGHT,
    };
  }

  return {
    memory: safeMemory / total,
    document: safeDocument / total,
  };
}

function normalizeSelectedSourceWeights(
  sources: Set<UnifiedResultSource>,
  config: Required<UnifiedSearchConfig>,
): SourceWeights {
  const includeMemory = sources.has("memory");
  const includeDocument = sources.has("document");

  if (includeMemory && includeDocument) {
    return normalizeWeightPair(config.memoryWeight, config.documentWeight);
  }

  if (includeMemory) {
    return { memory: 1, document: 0 };
  }

  return { memory: 0, document: 1 };
}

function isPathAllowed(sourcePath: string, filters?: { paths?: string[] }): boolean {
  const paths = filters?.paths;
  if (!paths || paths.length === 0) {
    return true;
  }

  for (const path of paths) {
    if (sourcePath === path || sourcePath.startsWith(`${path}/`)) {
      return true;
    }
  }

  return false;
}

function buildConfig(config?: UnifiedSearchConfig): Required<UnifiedSearchConfig> {
  return {
    memoryWeight: config?.memoryWeight ?? DEFAULT_MEMORY_WEIGHT,
    documentWeight: config?.documentWeight ?? DEFAULT_DOCUMENT_WEIGHT,
    normalizeScores: config?.normalizeScores ?? DEFAULT_NORMALIZE_SCORES,
    maxResultsPerSource: config?.maxResultsPerSource ?? DEFAULT_MAX_RESULTS_PER_SOURCE,
  };
}

function validateQuery(query: UnifiedSearchQuery): Result<void, UnifiedMemoryRetrievalError> {
  if (query.query.trim().length === 0) {
    return ok(undefined);
  }

  if (typeof query.topK !== "undefined" && (!Number.isInteger(query.topK) || query.topK <= 0)) {
    return err(
      new UnifiedMemoryRetrievalError(
        "Unified search option 'topK' must be a positive integer",
        "UNIFIED_MEMORY_RETRIEVAL_INVALID_QUERY",
      ),
    );
  }

  if (
    typeof query.minScore !== "undefined" &&
    (!Number.isFinite(query.minScore) || query.minScore < 0 || query.minScore > 1)
  ) {
    return err(
      new UnifiedMemoryRetrievalError(
        "Unified search option 'minScore' must be between 0 and 1",
        "UNIFIED_MEMORY_RETRIEVAL_INVALID_QUERY",
      ),
    );
  }

  if (
    typeof query.memoryFilters?.minImportance !== "undefined" &&
    (!Number.isFinite(query.memoryFilters.minImportance) ||
      query.memoryFilters.minImportance < 0 ||
      query.memoryFilters.minImportance > 1)
  ) {
    return err(
      new UnifiedMemoryRetrievalError(
        "Unified search option 'memoryFilters.minImportance' must be between 0 and 1",
        "UNIFIED_MEMORY_RETRIEVAL_INVALID_QUERY",
      ),
    );
  }

  return ok(undefined);
}

function validateConfig(config: Required<UnifiedSearchConfig>): Result<void, UnifiedMemoryRetrievalError> {
  if (!Number.isFinite(config.memoryWeight) || config.memoryWeight < 0) {
    return err(
      new UnifiedMemoryRetrievalError(
        "Unified search config 'memoryWeight' must be a non-negative number",
        "UNIFIED_MEMORY_RETRIEVAL_INVALID_CONFIG",
      ),
    );
  }

  if (!Number.isFinite(config.documentWeight) || config.documentWeight < 0) {
    return err(
      new UnifiedMemoryRetrievalError(
        "Unified search config 'documentWeight' must be a non-negative number",
        "UNIFIED_MEMORY_RETRIEVAL_INVALID_CONFIG",
      ),
    );
  }

  if (!Number.isInteger(config.maxResultsPerSource) || config.maxResultsPerSource <= 0) {
    return err(
      new UnifiedMemoryRetrievalError(
        "Unified search config 'maxResultsPerSource' must be a positive integer",
        "UNIFIED_MEMORY_RETRIEVAL_INVALID_CONFIG",
      ),
    );
  }

  return ok(undefined);
}

export class UnifiedMemoryRetrieval {
  private readonly memorySearch: MemorySearchProvider;
  private readonly documentSearch: DocumentSearchProvider;
  private readonly config: Required<UnifiedSearchConfig>;

  constructor(dependencies: UnifiedMemoryRetrievalDependencies) {
    this.memorySearch = dependencies.memorySearch;
    this.documentSearch = dependencies.documentSearch;
    this.config = buildConfig(dependencies.config);
  }

  async search(
    query: UnifiedSearchQuery,
  ): Promise<Result<UnifiedSearchResult[], UnifiedMemoryRetrievalError>> {
    const configValidation = validateConfig(this.config);
    if (!configValidation.ok) {
      return configValidation;
    }

    const queryValidation = validateQuery(query);
    if (!queryValidation.ok) {
      return queryValidation;
    }

    const trimmedQuery = query.query.trim();
    if (trimmedQuery.length === 0) {
      return ok([]);
    }

    const topK = query.topK ?? DEFAULT_TOP_K;
    const minScore = query.minScore ?? DEFAULT_MIN_SCORE;
    const requestedSources = query.sources ?? ["memory", "document"];
    const sources = new Set<UnifiedResultSource>(requestedSources);

    if (!sources.has("memory") && !sources.has("document")) {
      return ok([]);
    }

    const perSourceLimit = Math.max(topK, this.config.maxResultsPerSource);

    const settled = await Promise.allSettled([
      sources.has("memory")
        ? this.memorySearch.search(trimmedQuery, {
            topK: perSourceLimit,
            types: query.memoryFilters?.types,
            layers: query.memoryFilters?.layers,
            minImportance: query.memoryFilters?.minImportance,
          })
        : Promise.resolve(ok([] as MemorySearchResult[])),
      sources.has("document")
        ? this.documentSearch.search(trimmedQuery, perSourceLimit, {
            sourceIds: query.documentFilters?.sourceIds,
          })
        : Promise.resolve(ok([] as DocumentSearchResult[])),
    ]);

    const memorySettled = settled[0];
    const documentSettled = settled[1];

    const memoryFailed =
      memorySettled.status === "rejected" || (memorySettled.status === "fulfilled" && !memorySettled.value.ok);
    const documentFailed =
      documentSettled.status === "rejected" ||
      (documentSettled.status === "fulfilled" && !documentSettled.value.ok);

    const memoryRequested = sources.has("memory");
    const documentRequested = sources.has("document");

    if (
      (memoryRequested && documentRequested && memoryFailed && documentFailed) ||
      (memoryRequested && !documentRequested && memoryFailed) ||
      (!memoryRequested && documentRequested && documentFailed)
    ) {
      const memoryError =
        memorySettled.status === "rejected"
          ? asError(memorySettled.reason)
          : memorySettled.status === "fulfilled" && !memorySettled.value.ok
            ? memorySettled.value.error
            : undefined;

      const documentError =
        documentSettled.status === "rejected"
          ? asError(documentSettled.reason)
          : documentSettled.status === "fulfilled" && !documentSettled.value.ok
            ? documentSettled.value.error
            : undefined;

      return err(
        new UnifiedMemoryRetrievalError(
          "Unified retrieval failed: all requested sources failed",
          "UNIFIED_MEMORY_RETRIEVAL_SOURCE_FAILURE",
          memoryError ?? documentError,
        ),
      );
    }

    const memoryResults =
      memorySettled.status === "fulfilled" && memorySettled.value.ok ? memorySettled.value.value : [];
    const documentResultsRaw =
      documentSettled.status === "fulfilled" && documentSettled.value.ok ? documentSettled.value.value : [];

    const documentResults = documentResultsRaw.filter((item) =>
      isPathAllowed(item.sourcePath, query.documentFilters),
    );

    const weights = normalizeSelectedSourceWeights(sources, this.config);
    const scoredMemoryResults = this.scoreMemoryResults(memoryResults, weights.memory);
    const scoredDocumentResults = this.scoreDocumentResults(documentResults, weights.document);

    const merged: ScoredResult[] = [...scoredMemoryResults, ...scoredDocumentResults]
      .filter((result) => result.normalizedScore >= minScore)
      .sort((left, right) => {
        if (right.normalizedScore !== left.normalizedScore) {
          return right.normalizedScore - left.normalizedScore;
        }

        const leftId = left.source === "memory" ? left.result.id : left.result.chunkId;
        const rightId = right.source === "memory" ? right.result.id : right.result.chunkId;
        return leftId.localeCompare(rightId);
      })
      .slice(0, topK);

    const unified = merged.map((item, index): UnifiedSearchResult => {
      if (item.source === "memory") {
        return {
          id: item.result.id,
          source: "memory",
          content: item.result.content,
          score: item.normalizedScore,
          rank: index + 1,
          metadata: {
            type: item.result.type,
            layer: item.result.layer,
            importance: item.result.importance,
            tags: item.result.tags,
            conversationId: item.result.conversationId,
          },
          provenance: item.result.provenance,
        };
      }

      return {
        id: item.result.chunkId,
        source: "document",
        content: item.result.content,
        score: item.normalizedScore,
        rank: index + 1,
        metadata: {
          sourcePath: item.result.sourcePath,
          heading: item.result.heading,
          headingHierarchy: item.result.headingHierarchy,
          sourceId: item.result.sourceId,
          chunkIndex: item.result.chunkIndex,
        },
      };
    });

    return ok(unified);
  }

  async searchMemoryOnly(
    query: string,
    topK = DEFAULT_TOP_K,
  ): Promise<Result<UnifiedSearchResult[], UnifiedMemoryRetrievalError>> {
    return this.search({
      query,
      topK,
      sources: ["memory"],
    });
  }

  async searchDocumentsOnly(
    query: string,
    topK = DEFAULT_TOP_K,
  ): Promise<Result<UnifiedSearchResult[], UnifiedMemoryRetrievalError>> {
    return this.search({
      query,
      topK,
      sources: ["document"],
    });
  }

  private scoreMemoryResults(results: MemorySearchResult[], sourceWeight: number): ScoredMemoryResult[] {
    const baseScores = this.config.normalizeScores
      ? normalizeValues(results.map((result) => result.score))
      : results.map((result) => clamp01(result.score));

    return results.map((result, index) => ({
      source: "memory",
      normalizedScore: clamp01(baseScores[index] * sourceWeight),
      result,
    }));
  }

  private scoreDocumentResults(
    results: DocumentSearchResult[],
    sourceWeight: number,
  ): ScoredDocumentResult[] {
    const baseScores = this.config.normalizeScores
      ? normalizeValues(results.map((result) => result.score))
      : results.map((result) => clamp01(result.score));

    return results.map((result, index) => ({
      source: "document",
      normalizedScore: clamp01(baseScores[index] * sourceWeight),
      result,
    }));
  }
}

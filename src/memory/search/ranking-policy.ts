export interface FusionParams {
  bm25Score: number;
  vectorScore: number;
  importance: number;
  bm25Weight: number;
  vectorWeight: number;
  importanceBoost: number;
  bm25Rank?: number;
  vectorRank?: number;
}

export interface RankingPolicy {
  readonly name: string;
  fuse(params: FusionParams): number;
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

export class WeightedSumPolicy implements RankingPolicy {
  readonly name = "weighted-sum";

  fuse(params: FusionParams): number {
    const base = params.bm25Score * params.bm25Weight + params.vectorScore * params.vectorWeight;
    const boost = params.importance * params.importanceBoost;
    return clamp01(base + boost);
  }
}

export class ReciprocalRankFusionPolicy implements RankingPolicy {
  readonly name = "rrf";

  private readonly k: number;

  constructor(k = 60) {
    this.k = k;
  }

  fuse(params: FusionParams): number {
    const bm25Rank = params.bm25Rank;
    const vectorRank = params.vectorRank;

    const bm25Rrf = typeof bm25Rank === "number" ? 1 / (this.k + bm25Rank) : 0;
    const vectorRrf = typeof vectorRank === "number" ? 1 / (this.k + vectorRank) : 0;

    const maxRrf = 2 / (this.k + 1);
    const rrfScore = maxRrf === 0 ? 0 : (bm25Rrf + vectorRrf) / maxRrf;
    const boost = params.importance * params.importanceBoost;

    return clamp01(rrfScore + boost);
  }
}

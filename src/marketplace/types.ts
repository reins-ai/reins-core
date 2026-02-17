import type { Result } from "../result";

/**
 * Marketplace trust levels used to communicate source confidence to users.
 */
export type MarketplaceTrustLevel = "verified" | "trusted" | "community" | "untrusted";

/**
 * Marketplace browse sort modes.
 */
export type MarketplaceSortMode = "trending" | "popular" | "recent";

/**
 * Skill summary contract for marketplace list and search views.
 */
export interface MarketplaceSkill {
  slug: string;
  name: string;
  author: string;
  description: string;
  installCount: number;
  trustLevel: MarketplaceTrustLevel;
  categories: string[];
  version: string;
  updatedAt: string;
}

/**
 * Full skill metadata contract for marketplace detail views.
 */
export interface MarketplaceSkillDetail extends MarketplaceSkill {
  fullDescription: string;
  requiredTools: string[];
  homepage?: string;
  license?: string;
  versions: string[];
  readme?: string;
}

/**
 * Paginated skill result contract used by browse and search methods.
 */
export interface MarketplaceSearchResult {
  skills: MarketplaceSkill[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * Browse options for marketplace listing endpoints.
 */
export interface BrowseOptions {
  sort?: MarketplaceSortMode;
  page?: number;
  pageSize?: number;
  category?: string;
}

/**
 * Search options for marketplace query endpoints.
 */
export interface SearchOptions {
  page?: number;
  pageSize?: number;
}

/**
 * Category metadata used to power filtering and category listings.
 */
export interface MarketplaceCategory {
  id: string;
  name: string;
  slug: string;
  count: number;
}

/**
 * Download payload metadata for skill package retrieval.
 */
export interface DownloadResult {
  buffer: Uint8Array | ArrayBuffer;
  filename: string;
  size: number;
  contentType: string;
}

/**
 * Source contract implemented by each marketplace backend.
 */
export interface MarketplaceSource {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  browse(options?: BrowseOptions): Promise<Result<MarketplaceSearchResult>>;
  search(query: string, options?: SearchOptions): Promise<Result<MarketplaceSearchResult>>;
  getDetail(slug: string): Promise<Result<MarketplaceSkillDetail>>;
  download(slug: string, version: string): Promise<Result<DownloadResult>>;
  getCategories(): Promise<Result<MarketplaceCategory[]>>;
}

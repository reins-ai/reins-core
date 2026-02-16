import { err, ok } from "../../result";
import type { Result } from "../../result";
import { TtlCache } from "../cache";
import { MARKETPLACE_ERROR_CODES, MarketplaceError } from "../errors";
import type {
  BrowseOptions,
  DownloadResult,
  MarketplaceCategory,
  MarketplaceSearchResult,
  MarketplaceSkill,
  MarketplaceSkillDetail,
  MarketplaceSortMode,
  MarketplaceSource,
  MarketplaceTrustLevel,
  SearchOptions,
} from "../types";
import type {
  ClawHubCategoriesResponse,
  ClawHubDownloadResponse,
  ClawHubSkill,
  ClawHubSkillDetailResponse,
  ClawHubSkillsResponse,
} from "./api-types";
import { ClawHubClient } from "./client";

export interface ClawHubSourceOptions {
  client?: ClawHubClient;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

const BROWSE_TTL_MS = 300_000;
const SEARCH_TTL_MS = 120_000;
const DETAIL_TTL_MS = 900_000;
const CATEGORIES_TTL_MS = 3_600_000;

const SORT_MODE_MAP: Record<MarketplaceSortMode, "trending" | "popular" | "recent"> = {
  trending: "trending",
  popular: "popular",
  recent: "recent",
};

const TRUST_LEVELS: MarketplaceTrustLevel[] = ["verified", "trusted", "community", "untrusted"];

export class ClawHubSource implements MarketplaceSource {
  readonly id = "clawhub";
  readonly name = "ClawHub";
  readonly description = "OpenClaw community skill marketplace";

  private readonly client: ClawHubClient;
  private readonly browseCache = new TtlCache<MarketplaceSearchResult>();
  private readonly searchCache = new TtlCache<MarketplaceSearchResult>();
  private readonly detailCache = new TtlCache<MarketplaceSkillDetail>();
  private readonly categoriesCache = new TtlCache<MarketplaceCategory[]>();
  private readonly staleBrowseCache = new Map<string, MarketplaceSearchResult>();
  private readonly staleSearchCache = new Map<string, MarketplaceSearchResult>();
  private readonly staleDetailCache = new Map<string, MarketplaceSkillDetail>();
  private readonly staleCategoriesCache = new Map<string, MarketplaceCategory[]>();

  constructor(options: ClawHubSourceOptions = {}) {
    this.client = options.client
      ?? new ClawHubClient({
        baseUrl: options.baseUrl,
        fetchFn: options.fetchFn,
      });
  }

  async browse(options: BrowseOptions = {}): Promise<Result<MarketplaceSearchResult>> {
    const sort = options.sort ?? "trending";
    const page = options.page ?? DEFAULT_PAGE;
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    const category = options.category ?? "";

    const cacheKey = this.createBrowseCacheKey(sort, page, pageSize, category);
    const cached = this.browseCache.get(cacheKey);
    if (cached) {
      return ok(cached);
    }

    const result = await this.client.fetchSkills({
      sort: SORT_MODE_MAP[sort],
      page,
      limit: pageSize,
      category: options.category,
    });

    if (!result.ok) {
      const fallback = this.staleBrowseCache.get(cacheKey);
      if (this.isRateLimitedError(result.error) && fallback) {
        return ok(fallback);
      }
      return err(result.error);
    }

    const normalized = this.normalizeSearchResult(result.value);
    this.browseCache.set(cacheKey, normalized, BROWSE_TTL_MS);
    this.staleBrowseCache.set(cacheKey, normalized);

    return ok(normalized);
  }

  async search(query: string, options: SearchOptions = {}): Promise<Result<MarketplaceSearchResult>> {
    const page = options.page ?? DEFAULT_PAGE;
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

    const cacheKey = this.createSearchCacheKey(query, page, pageSize);
    const cached = this.searchCache.get(cacheKey);
    if (cached) {
      return ok(cached);
    }

    const result = await this.client.searchSkills(query, {
      page,
      limit: pageSize,
    });

    if (!result.ok) {
      const fallback = this.staleSearchCache.get(cacheKey);
      if (this.isRateLimitedError(result.error) && fallback) {
        return ok(fallback);
      }
      return err(result.error);
    }

    const normalized = this.normalizeSearchResult(result.value);
    this.searchCache.set(cacheKey, normalized, SEARCH_TTL_MS);
    this.staleSearchCache.set(cacheKey, normalized);

    return ok(normalized);
  }

  async getDetail(slug: string): Promise<Result<MarketplaceSkillDetail>> {
    const cacheKey = this.createDetailCacheKey(slug);
    const cached = this.detailCache.get(cacheKey);
    if (cached) {
      return ok(cached);
    }

    const result = await this.client.fetchSkillDetail(slug);
    if (!result.ok) {
      const fallback = this.staleDetailCache.get(cacheKey);
      if (this.isRateLimitedError(result.error) && fallback) {
        return ok(fallback);
      }
      return err(result.error);
    }

    const normalized = this.normalizeSkillDetail(result.value);
    this.detailCache.set(cacheKey, normalized, DETAIL_TTL_MS);
    this.staleDetailCache.set(cacheKey, normalized);

    return ok(normalized);
  }

  async download(slug: string, version: string): Promise<Result<DownloadResult>> {
    const result = await this.client.downloadSkill(slug, version);
    if (!result.ok) {
      return err(result.error);
    }

    return ok(this.normalizeDownload(result.value));
  }

  async getCategories(): Promise<Result<MarketplaceCategory[]>> {
    const cacheKey = this.createCategoriesCacheKey();
    const cached = this.categoriesCache.get(cacheKey);
    if (cached) {
      return ok(cached);
    }

    const result = await this.client.fetchCategories();
    if (!result.ok) {
      const fallback = this.staleCategoriesCache.get(cacheKey);
      if (this.isRateLimitedError(result.error) && fallback) {
        return ok(fallback);
      }
      return err(result.error);
    }

    const normalized = this.normalizeCategories(result.value);
    this.categoriesCache.set(cacheKey, normalized, CATEGORIES_TTL_MS);
    this.staleCategoriesCache.set(cacheKey, normalized);

    return ok(normalized);
  }

  private createBrowseCacheKey(sort: MarketplaceSortMode, page: number, pageSize: number, category: string): string {
    return `browse:${sort}:${page}:${pageSize}:${category}`;
  }

  private createSearchCacheKey(query: string, page: number, pageSize: number): string {
    return `search:${query}:${page}:${pageSize}`;
  }

  private createDetailCacheKey(slug: string): string {
    return `detail:${slug}`;
  }

  private createCategoriesCacheKey(): string {
    return "categories";
  }

  private normalizeSearchResult(response: ClawHubSkillsResponse): MarketplaceSearchResult {
    const skills = response.skills.map((skill) => this.normalizeSkill(skill));
    return {
      skills,
      total: response.total,
      page: response.page,
      pageSize: response.pageSize,
      hasMore: response.page * response.pageSize < response.total,
    };
  }

  private normalizeSkill(skill: ClawHubSkill): MarketplaceSkill {
    return {
      slug: skill.slug,
      name: skill.name,
      author: this.normalizeAuthor(skill.author as unknown),
      description: skill.description,
      installCount: skill.installCount,
      trustLevel: this.normalizeTrustLevel(skill.trustLevel),
      categories: skill.categories,
      version: skill.latestVersion,
      updatedAt: skill.updatedAt,
    };
  }

  private normalizeSkillDetail(response: ClawHubSkillDetailResponse): MarketplaceSkillDetail {
    const summary = this.normalizeSkill(response);
    const fullDescription = response.fullDescription ?? response.readme ?? response.description;

    return {
      ...summary,
      fullDescription,
      requiredTools: response.requiredTools,
      homepage: response.homepage,
      license: response.license,
      versions: response.versions.map((version) => version.version),
      readme: response.readme,
    };
  }

  private normalizeCategories(response: ClawHubCategoriesResponse): MarketplaceCategory[] {
    return response.categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      count: category.count,
    }));
  }

  private normalizeDownload(response: ClawHubDownloadResponse): DownloadResult {
    return {
      buffer: response.data,
      filename: response.filename,
      size: response.size,
      contentType: response.contentType,
    };
  }

  private normalizeTrustLevel(value: string): MarketplaceTrustLevel {
    return TRUST_LEVELS.includes(value as MarketplaceTrustLevel)
      ? (value as MarketplaceTrustLevel)
      : "untrusted";
  }

  private normalizeAuthor(author: unknown): string {
    if (typeof author === "string") {
      return author;
    }

    if (typeof author === "object" && author !== null && "name" in author) {
      const named = (author as { name?: unknown }).name;
      if (typeof named === "string") {
        return named;
      }
    }

    return "unknown";
  }

  private isRateLimitedError(error: MarketplaceError): boolean {
    return error.code === MARKETPLACE_ERROR_CODES.RATE_LIMITED;
  }
}

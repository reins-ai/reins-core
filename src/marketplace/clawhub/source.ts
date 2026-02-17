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
  SearchOptions,
} from "../types";
import type {
  ClawHubBrowseItem,
  ClawHubBrowseResponse,
  ClawHubDetailResponse,
  ClawHubDownloadResponse,
  ClawHubSearchResponse,
  ClawHubSearchResult,
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

const SORT_MODE_MAP: Record<MarketplaceSortMode, "trending" | "popular" | "recent"> = {
  trending: "trending",
  popular: "popular",
  recent: "recent",
};

export class ClawHubSource implements MarketplaceSource {
  readonly id = "clawhub";
  readonly name = "ClawHub";
  readonly description = "OpenClaw community skill marketplace";

  private readonly client: ClawHubClient;
  private readonly browseCache = new TtlCache<MarketplaceSearchResult>();
  private readonly searchCache = new TtlCache<MarketplaceSearchResult>();
  private readonly detailCache = new TtlCache<MarketplaceSkillDetail>();
  private readonly staleBrowseCache = new Map<string, MarketplaceSearchResult>();
  private readonly staleSearchCache = new Map<string, MarketplaceSearchResult>();
  private readonly staleDetailCache = new Map<string, MarketplaceSkillDetail>();

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

    const normalized = this.normalizeSearchResult(result.value, page, pageSize);
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

    const normalized = this.normalizeFromSearch(result.value, page, pageSize);
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
    return ok([]);
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

  private normalizeSearchResult(response: ClawHubBrowseResponse, page: number, pageSize: number): MarketplaceSearchResult {
    const rawSkills = Array.isArray(response.items) ? response.items : [];
    const skills = rawSkills.map((skill) => this.normalizeSkill(skill));
    return {
      skills,
      total: skills.length,
      page,
      pageSize,
      hasMore: response.nextCursor !== null && response.nextCursor !== undefined,
    };
  }

  private normalizeFromSearch(response: ClawHubSearchResponse, page: number, pageSize: number): MarketplaceSearchResult {
    const rawSkills = Array.isArray(response.results) ? response.results : [];
    const skills = rawSkills.map((skill) => this.normalizeSearchSkill(skill));

    return {
      skills,
      total: skills.length,
      page,
      pageSize,
      hasMore: false,
    };
  }

  private normalizeSkill(skill: ClawHubBrowseItem): MarketplaceSkill {
    const version = this.pickVersion(skill.latestVersion?.version, skill.tags?.latest);

    return {
      slug: skill.slug,
      name: this.normalizeName(skill.displayName, skill.slug),
      author: "unknown",
      description: this.normalizeText(skill.summary),
      installCount: this.normalizeNumber(skill.stats?.installsAllTime),
      trustLevel: "community",
      categories: [],
      version,
      updatedAt: this.normalizeTimestamp(skill.updatedAt),
    };
  }

  private normalizeSearchSkill(skill: ClawHubSearchResult): MarketplaceSkill {
    return {
      slug: skill.slug,
      name: this.normalizeName(skill.displayName, skill.slug),
      author: "unknown",
      description: this.normalizeText(skill.summary),
      installCount: 0,
      trustLevel: "community",
      categories: [],
      version: this.pickVersion(skill.version),
      updatedAt: this.normalizeTimestamp(skill.updatedAt),
    };
  }

  private normalizeSkillDetail(response: ClawHubDetailResponse): MarketplaceSkillDetail {
    const skill = response.skill;
    const summary = this.normalizeSkill({
      slug: skill?.slug ?? "",
      displayName: skill?.displayName,
      summary: skill?.summary,
      stats: skill?.stats,
      updatedAt: skill?.updatedAt,
      tags: skill?.tags,
      latestVersion: response.latestVersion,
    });

    const version = this.pickVersion(response.latestVersion?.version, skill?.tags?.latest);

    return {
      ...summary,
      author: this.normalizeDetailAuthor(response),
      version,
      fullDescription: this.normalizeText(skill?.summary),
      requiredTools: [],
      homepage: undefined,
      license: undefined,
      versions: version.length > 0 ? [version] : [],
      readme: undefined,
    };
  }

  private normalizeDownload(response: ClawHubDownloadResponse): DownloadResult {
    return {
      buffer: response.data,
      filename: response.filename,
      size: response.size,
      contentType: response.contentType,
    };
  }

  private normalizeDetailAuthor(response: ClawHubDetailResponse): string {
    if (typeof response.owner?.displayName === "string" && response.owner.displayName.length > 0) {
      return response.owner.displayName;
    }

    if (typeof response.owner?.handle === "string" && response.owner.handle.length > 0) {
      return response.owner.handle;
    }

    return "unknown";
  }

  private normalizeName(displayName: unknown, fallback: string): string {
    if (typeof displayName === "string" && displayName.length > 0) {
      return displayName;
    }

    return fallback;
  }

  private normalizeText(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  private normalizeNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  private normalizeTimestamp(value: unknown): string {
    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value).toISOString();
    }

    return new Date(0).toISOString();
  }

  private pickVersion(...candidates: Array<string | undefined>): string {
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }

    return "unknown";
  }

  private isRateLimitedError(error: MarketplaceError): boolean {
    return error.code === MARKETPLACE_ERROR_CODES.RATE_LIMITED;
  }
}

import { err, ok } from "../result";
import type { Result } from "../result";
import { MarketplaceError } from "./errors";
import type {
  BrowseOptions,
  DownloadResult,
  MarketplaceCategory,
  MarketplaceSearchResult,
  MarketplaceSkillDetail,
  MarketplaceSource,
  SearchOptions,
} from "./types";

/**
 * Placeholder source for the official Reins skill marketplace.
 * Returns empty results for browse/search/categories and errors for
 * detail/download until the marketplace backend is available.
 */
export class ReinsMarketplaceSource implements MarketplaceSource {
  readonly id = "reins";
  readonly name = "Reins Marketplace";
  readonly description = "Official Reins skill marketplace (Coming Soon)";

  async browse(_options?: BrowseOptions): Promise<Result<MarketplaceSearchResult>> {
    return ok({
      skills: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
  }

  async search(_query: string, _options?: SearchOptions): Promise<Result<MarketplaceSearchResult>> {
    return ok({
      skills: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
  }

  async getDetail(_slug: string): Promise<Result<MarketplaceSkillDetail>> {
    return err(new MarketplaceError("Skill not found", "MARKETPLACE_NOT_FOUND"));
  }

  async download(_slug: string, _version: string): Promise<Result<DownloadResult>> {
    return err(new MarketplaceError("Downloads not available", "MARKETPLACE_SOURCE_ERROR"));
  }

  async getCategories(): Promise<Result<MarketplaceCategory[]>> {
    return ok([]);
  }
}

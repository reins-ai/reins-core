import { err, ok } from "../../result";
import type { Result } from "../../result";
import { MARKETPLACE_ERROR_CODES, MarketplaceError } from "../errors";
import type {
  ClawHubBrowseResponse,
  ClawHubDetailResponse,
  ClawHubDownloadResponse,
  ClawHubSearchResponse,
} from "./api-types";

export interface ClawHubClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface FetchSkillsOptions {
  sort?: "trending" | "popular" | "recent";
  page?: number;
  limit?: number;
  category?: string;
}

export interface SearchSkillsOptions {
  page?: number;
  limit?: number;
}

interface RateLimitInfo {
  remaining: number | null;
  resetAt: Date | null;
}

const DEFAULT_BASE_URL = "https://clawhub.ai";
const DEFAULT_HEADERS = {
  "User-Agent": "reins/1.0",
} as const;

const SORT_MODE_MAP = {
  trending: "trending",
  popular: "installsAllTime",
  recent: "updated",
} as const;

export class ClawHubClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private rateLimitInfo: RateLimitInfo = { remaining: null, resetAt: null };

  constructor(options: ClawHubClientOptions = {}) {
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async fetchSkills(options: FetchSkillsOptions = {}): Promise<Result<ClawHubBrowseResponse, MarketplaceError>> {
    const params = new URLSearchParams();

    if (options.sort) {
      params.set("sort", SORT_MODE_MAP[options.sort]);
    }
    if (options.page !== undefined) {
      params.set("page", String(options.page));
    }
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options.category) {
      params.set("category", options.category);
    }

    return this.request<ClawHubBrowseResponse>("/api/v1/skills", params);
  }

  async searchSkills(query: string, options: SearchSkillsOptions = {}): Promise<Result<ClawHubSearchResponse, MarketplaceError>> {
    const params = new URLSearchParams();
    params.set("q", query);

    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }

    return this.request<ClawHubSearchResponse>("/api/v1/search", params);
  }

  async fetchSkillDetail(slug: string): Promise<Result<ClawHubDetailResponse, MarketplaceError>> {
    return this.request<ClawHubDetailResponse>(`/api/v1/skills/${encodeURIComponent(slug)}`);
  }

  async downloadSkill(slug: string, version: string): Promise<Result<ClawHubDownloadResponse, MarketplaceError>> {
    const params = new URLSearchParams();
    params.set("slug", slug);
    params.set("version", version);

    const binaryResult = await this.requestBinary("/api/v1/download", params);
    if (!binaryResult.ok) {
      return binaryResult;
    }

    const contentType = binaryResult.value.headers.get("content-type") ?? "application/zip";
    const filename = this.parseFilename(binaryResult.value.headers) ?? `${slug}-${version}.zip`;

    return ok({
      data: binaryResult.value.data,
      filename,
      size: binaryResult.value.data.byteLength,
      contentType,
    });
  }

  getRateLimitInfo(): { remaining: number | null; resetAt: Date | null } {
    return {
      remaining: this.rateLimitInfo.remaining,
      resetAt: this.rateLimitInfo.resetAt,
    };
  }

  private async request<T>(path: string, params?: URLSearchParams): Promise<Result<T, MarketplaceError>> {
    const responseResult = await this.fetchResponse(path, params);
    if (!responseResult.ok) {
      return responseResult;
    }

    const response = responseResult.value;

    if (!response.ok) {
      return err(this.mapHttpError(response));
    }

    try {
      const payload = await response.json() as T;
      return ok(payload);
    } catch (cause) {
      return err(new MarketplaceError(
        "Marketplace returned invalid JSON response",
        MARKETPLACE_ERROR_CODES.INVALID_RESPONSE,
        cause instanceof Error ? cause : undefined,
      ));
    }
  }

  private async requestBinary(
    path: string,
    params?: URLSearchParams,
  ): Promise<Result<{ data: ArrayBuffer; headers: Headers }, MarketplaceError>> {
    const responseResult = await this.fetchResponse(path, params);
    if (!responseResult.ok) {
      return responseResult;
    }

    const response = responseResult.value;
    if (!response.ok) {
      return err(this.mapHttpError(response));
    }

    try {
      const data = await response.arrayBuffer();
      return ok({ data, headers: response.headers });
    } catch (cause) {
      return err(new MarketplaceError(
        "Marketplace returned invalid binary response",
        MARKETPLACE_ERROR_CODES.INVALID_RESPONSE,
        cause instanceof Error ? cause : undefined,
      ));
    }
  }

  private async fetchResponse(path: string, params?: URLSearchParams): Promise<Result<Response, MarketplaceError>> {
    const url = new URL(path, this.baseUrl);
    if (params && params.size > 0) {
      url.search = params.toString();
    }

    try {
      const response = await this.fetchFn(url.toString(), {
        method: "GET",
        headers: DEFAULT_HEADERS,
      });

      this.captureRateLimitInfo(response.headers);

      return ok(response);
    } catch (cause) {
      return err(new MarketplaceError(
        "Failed to connect to marketplace source",
        MARKETPLACE_ERROR_CODES.NETWORK_ERROR,
        cause instanceof Error ? cause : undefined,
      ));
    }
  }

  private mapHttpError(response: Response): MarketplaceError {
    if (response.status === 404) {
      return new MarketplaceError("Marketplace resource not found", MARKETPLACE_ERROR_CODES.NOT_FOUND);
    }

    if (response.status === 429) {
      const retryAfter = this.parseRetryAfter(response.headers.get("retry-after"));
      if (retryAfter !== null) {
        return new MarketplaceError(
          `Marketplace rate limit exceeded. Retry after ${retryAfter} seconds`,
          MARKETPLACE_ERROR_CODES.RATE_LIMITED,
        );
      }

      return new MarketplaceError(
        "Marketplace rate limit exceeded",
        MARKETPLACE_ERROR_CODES.RATE_LIMITED,
      );
    }

    if (response.status >= 500) {
      return new MarketplaceError(
        `Marketplace source error (${response.status})`,
        MARKETPLACE_ERROR_CODES.SOURCE_ERROR,
      );
    }

    return new MarketplaceError(
      `Marketplace request failed with status ${response.status}`,
      MARKETPLACE_ERROR_CODES.SOURCE_ERROR,
    );
  }

  private captureRateLimitInfo(headers: Headers): void {
    const remaining = this.parseNumberHeader(headers.get("x-ratelimit-remaining"));
    const resetAt = this.parseResetHeader(headers.get("x-ratelimit-reset"));

    this.rateLimitInfo = {
      remaining,
      resetAt,
    };
  }

  private parseRetryAfter(value: string | null): number | null {
    if (!value) {
      return null;
    }

    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric >= 0) {
      const nowMs = Date.now();

      // Some sources return absolute epoch timestamps in Retry-After instead
      // of relative seconds. Handle both seconds and milliseconds epochs.
      if (numeric >= 1_000_000_000_000) {
        const deltaSeconds = Math.ceil((numeric - nowMs) / 1000);
        return deltaSeconds > 0 ? deltaSeconds : 0;
      }

      if (numeric >= 1_000_000_000) {
        const nowSeconds = Math.floor(nowMs / 1000);
        const deltaSeconds = Math.ceil(numeric - nowSeconds);
        return deltaSeconds > 0 ? deltaSeconds : 0;
      }

      return Math.ceil(numeric);
    }

    const dateMs = Date.parse(trimmed);
    if (Number.isNaN(dateMs)) {
      return null;
    }

    const deltaSeconds = Math.ceil((dateMs - Date.now()) / 1000);
    return deltaSeconds > 0 ? deltaSeconds : 0;
  }

  private parseNumberHeader(value: string | null): number | null {
    if (!value) {
      return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private parseResetHeader(value: string | null): Date | null {
    if (!value) {
      return null;
    }

    const asNumber = Number.parseInt(value, 10);
    if (!Number.isNaN(asNumber)) {
      const asSeconds = asNumber > 9_999_999_999 ? Math.floor(asNumber / 1000) : asNumber;
      return new Date(asSeconds * 1000);
    }

    const asDateMs = Date.parse(value);
    if (Number.isNaN(asDateMs)) {
      return null;
    }

    return new Date(asDateMs);
  }

  private parseFilename(headers: Headers): string | null {
    const contentDisposition = headers.get("content-disposition");
    if (!contentDisposition) {
      return null;
    }

    const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(contentDisposition);
    const rawFilename = match?.[1] ?? match?.[2];
    if (!rawFilename) {
      return null;
    }

    try {
      return decodeURIComponent(rawFilename);
    } catch {
      return rawFilename;
    }
  }
}

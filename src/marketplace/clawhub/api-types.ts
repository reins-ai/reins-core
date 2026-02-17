export interface ClawHubSkillVersion {
  version: string;
  createdAt?: number;
  changelog?: string;
}

export interface ClawHubSkillStats {
  comments?: number;
  downloads?: number;
  installsAllTime?: number;
  installsCurrent?: number;
  stars?: number;
  versions?: number;
}

export interface ClawHubBrowseItem {
  slug: string;
  displayName?: string;
  summary?: string;
  tags?: {
    latest?: string;
  };
  stats?: ClawHubSkillStats;
  createdAt?: number;
  updatedAt?: number;
  latestVersion?: ClawHubSkillVersion;
}

export interface ClawHubBrowseResponse {
  items?: ClawHubBrowseItem[];
  nextCursor?: string | null;
}

export interface ClawHubSearchResult {
  score?: number;
  slug: string;
  displayName?: string;
  summary?: string;
  version?: string;
  updatedAt?: number;
}

export interface ClawHubSearchResponse {
  results?: ClawHubSearchResult[];
}

export interface ClawHubDetailOwner {
  handle?: string;
  userId?: string;
  displayName?: string;
  image?: string;
}

export interface ClawHubDetailResponse {
  skill?: ClawHubBrowseItem;
  latestVersion?: ClawHubSkillVersion;
  owner?: ClawHubDetailOwner;
  moderation?: unknown;
}

export interface ClawHubDownloadResponse {
  data: ArrayBuffer;
  filename: string;
  size: number;
  contentType: string;
}

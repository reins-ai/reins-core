export interface ClawHubSkill {
  slug: string;
  name: string;
  author: string;
  description: string;
  installCount: number;
  trustLevel: string;
  categories: string[];
  latestVersion: string;
  updatedAt: string;
  homepage?: string;
  license?: string;
  requiredTools?: string[];
}

export interface ClawHubSkillsResponse {
  skills: ClawHubSkill[];
  total: number;
  page: number;
  pageSize: number;
}

export type ClawHubSearchResponse = ClawHubSkillsResponse;

export interface ClawHubSkillVersion {
  version: string;
  publishedAt?: string;
  changelog?: string;
}

export interface ClawHubSkillDetailResponse extends ClawHubSkill {
  readme?: string;
  fullDescription?: string;
  versions: ClawHubSkillVersion[];
  requiredTools: string[];
  homepage?: string;
  license?: string;
}

export interface ClawHubCategory {
  id: string;
  name: string;
  slug: string;
  count: number;
}

export interface ClawHubCategoriesResponse {
  categories: ClawHubCategory[];
}

export interface ClawHubDownloadResponse {
  data: ArrayBuffer;
  filename: string;
  size: number;
  contentType: string;
}

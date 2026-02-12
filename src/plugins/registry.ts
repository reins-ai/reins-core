import type { PluginPermission } from "../types";
import { PLUGIN_PERMISSION_VALUES } from "./manifest";

const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";
const DEFAULT_SEARCH_LIMIT = 20;
const PERMISSION_SET = new Set<PluginPermission>(PLUGIN_PERMISSION_VALUES);

export interface PluginRegistryEntry {
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: PluginPermission[];
  homepage?: string;
  downloads?: number;
  publishedAt?: string;
}

export interface PluginRegistry {
  search(query: string, options?: { limit?: number }): Promise<PluginRegistryEntry[]>;
  getDetails(pluginName: string): Promise<PluginRegistryEntry | null>;
  getVersions(pluginName: string): Promise<string[]>;
  checkUpdate(
    pluginName: string,
    currentVersion: string,
  ): Promise<{ hasUpdate: boolean; latestVersion?: string }>;
}

interface NpmPackageSearchResponse {
  objects?: Array<{
    package?: {
      name?: string;
      version?: string;
      description?: string;
      date?: string;
      links?: {
        homepage?: string;
      };
      author?: {
        name?: string;
      };
    };
  }>;
}

interface NpmPackageMetadata {
  name?: string;
  "dist-tags"?: {
    latest?: string;
  };
  versions?: Record<string, Record<string, unknown>>;
}

export class NpmPluginRegistry implements PluginRegistry {
  constructor(private readonly scope = "@reins-plugin") {}

  async search(query: string, options?: { limit?: number }): Promise<PluginRegistryEntry[]> {
    const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
    const searchQuery = `${this.scope} ${query}`.trim();
    const url = `${NPM_REGISTRY_BASE_URL}/-/v1/search?text=${encodeURIComponent(searchQuery)}&size=${limit}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to search npm registry: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as NpmPackageSearchResponse;
    const objects = data.objects ?? [];
    const entries: PluginRegistryEntry[] = [];

    for (const object of objects) {
      const pkg = object.package;
      if (!pkg?.name || !pkg.version) {
        continue;
      }

      if (!this.isInScope(pkg.name)) {
        continue;
      }

      entries.push({
        name: this.toPluginName(pkg.name),
        version: pkg.version,
        description: pkg.description ?? "",
        author: pkg.author?.name ?? "Unknown",
        permissions: [],
        homepage: pkg.links?.homepage,
        publishedAt: pkg.date,
      });
    }

    return entries;
  }

  async getDetails(pluginName: string): Promise<PluginRegistryEntry | null> {
    const metadata = await this.fetchMetadata(pluginName);
    if (!metadata) {
      return null;
    }

    const latestVersion = metadata["dist-tags"]?.latest;
    if (!latestVersion) {
      return null;
    }

    const versionMetadata = metadata.versions?.[latestVersion] ?? {};

    return {
      name: this.toPluginName(metadata.name ?? pluginName),
      version: latestVersion,
      description: readString(versionMetadata, "description") ?? "",
      author: this.readAuthor(versionMetadata),
      permissions: this.readPermissions(versionMetadata),
      homepage: readString(versionMetadata, "homepage"),
      publishedAt: readString(versionMetadata, "date"),
    };
  }

  async getVersions(pluginName: string): Promise<string[]> {
    const metadata = await this.fetchMetadata(pluginName);
    if (!metadata?.versions) {
      return [];
    }

    return Object.keys(metadata.versions).sort(compareVersions);
  }

  async checkUpdate(
    pluginName: string,
    currentVersion: string,
  ): Promise<{ hasUpdate: boolean; latestVersion?: string }> {
    const details = await this.getDetails(pluginName);
    if (!details) {
      return { hasUpdate: false };
    }

    if (compareVersions(details.version, currentVersion) > 0) {
      return { hasUpdate: true, latestVersion: details.version };
    }

    return { hasUpdate: false };
  }

  private async fetchMetadata(pluginName: string): Promise<NpmPackageMetadata | null> {
    const packageName = this.normalizePackageName(pluginName);
    const url = `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(packageName)}`;
    const response = await fetch(url);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch npm package metadata: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as NpmPackageMetadata;
  }

  private normalizePackageName(pluginName: string): string {
    if (pluginName.startsWith("@")) {
      return pluginName;
    }

    return `${this.scope}/${pluginName}`;
  }

  private isInScope(packageName: string): boolean {
    return packageName.startsWith(`${this.scope}/`);
  }

  private toPluginName(packageName: string): string {
    if (!this.isInScope(packageName)) {
      return packageName;
    }

    return packageName.slice(this.scope.length + 1);
  }

  private readAuthor(versionMetadata: Record<string, unknown>): string {
    const author = versionMetadata.author;

    if (typeof author === "string" && author.trim().length > 0) {
      return author;
    }

    if (isRecord(author)) {
      const authorName = readString(author, "name");
      if (authorName) {
        return authorName;
      }
    }

    return "Unknown";
  }

  private readPermissions(versionMetadata: Record<string, unknown>): PluginPermission[] {
    const possibleBlocks = [
      versionMetadata.reinsPlugin,
      versionMetadata["reins-plugin"],
      versionMetadata,
    ];

    for (const block of possibleBlocks) {
      if (!isRecord(block)) {
        continue;
      }

      const permissions = block.permissions;
      if (!Array.isArray(permissions)) {
        continue;
      }

      const parsed: PluginPermission[] = [];
      for (const permission of permissions) {
        if (typeof permission !== "string") {
          continue;
        }

        if (PERMISSION_SET.has(permission as PluginPermission)) {
          parsed.push(permission as PluginPermission);
        }
      }

      return parsed;
    }

    return [];
  }
}

export class InMemoryPluginRegistry implements PluginRegistry {
  private readonly entries = new Map<string, Map<string, PluginRegistryEntry>>();

  addEntry(entry: PluginRegistryEntry): void {
    const versions = this.entries.get(entry.name) ?? new Map<string, PluginRegistryEntry>();
    versions.set(entry.version, cloneEntry(entry));
    this.entries.set(entry.name, versions);
  }

  async search(query: string, options?: { limit?: number }): Promise<PluginRegistryEntry[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
    const matches: PluginRegistryEntry[] = [];

    for (const [pluginName, versions] of this.entries.entries()) {
      const latest = getLatestVersionEntry(versions);
      if (!latest) {
        continue;
      }

      if (normalizedQuery.length > 0) {
        const searchable = `${pluginName} ${latest.description} ${latest.author}`.toLowerCase();
        if (!searchable.includes(normalizedQuery)) {
          continue;
        }
      }

      matches.push(cloneEntry(latest));
    }

    matches.sort((left, right) => left.name.localeCompare(right.name));
    return matches.slice(0, Math.max(limit, 0));
  }

  async getDetails(pluginName: string): Promise<PluginRegistryEntry | null> {
    const versions = this.entries.get(pluginName);
    if (!versions) {
      return null;
    }

    const latest = getLatestVersionEntry(versions);
    return latest ? cloneEntry(latest) : null;
  }

  async getVersions(pluginName: string): Promise<string[]> {
    const versions = this.entries.get(pluginName);
    if (!versions) {
      return [];
    }

    return Array.from(versions.keys()).sort(compareVersions);
  }

  async checkUpdate(
    pluginName: string,
    currentVersion: string,
  ): Promise<{ hasUpdate: boolean; latestVersion?: string }> {
    const details = await this.getDetails(pluginName);
    if (!details) {
      return { hasUpdate: false };
    }

    if (compareVersions(details.version, currentVersion) > 0) {
      return { hasUpdate: true, latestVersion: details.version };
    }

    return { hasUpdate: false };
  }
}

function getLatestVersionEntry(
  versions: Map<string, PluginRegistryEntry>,
): PluginRegistryEntry | undefined {
  const sortedVersions = Array.from(versions.keys()).sort(compareVersions);
  const latestVersion = sortedVersions.at(-1);

  if (!latestVersion) {
    return undefined;
  }

  return versions.get(latestVersion);
}

function cloneEntry(entry: PluginRegistryEntry): PluginRegistryEntry {
  return {
    ...entry,
    permissions: [...entry.permissions],
  };
}

function compareVersions(left: string, right: string): number {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);

  if (!leftParsed || !rightParsed) {
    return left.localeCompare(right);
  }

  if (leftParsed.major !== rightParsed.major) {
    return leftParsed.major - rightParsed.major;
  }

  if (leftParsed.minor !== rightParsed.minor) {
    return leftParsed.minor - rightParsed.minor;
  }

  if (leftParsed.patch !== rightParsed.patch) {
    return leftParsed.patch - rightParsed.patch;
  }

  if (!leftParsed.prerelease && !rightParsed.prerelease) {
    return 0;
  }

  if (!leftParsed.prerelease) {
    return 1;
  }

  if (!rightParsed.prerelease) {
    return -1;
  }

  return comparePrerelease(leftParsed.prerelease, rightParsed.prerelease);
}

function parseSemver(
  value: string,
): { major: number; minor: number; patch: number; prerelease?: string } | null {
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/.exec(
      value,
    );

  if (!match) {
    return null;
  }

  return {
    major: Number.parseInt(match[1] ?? "0", 10),
    minor: Number.parseInt(match[2] ?? "0", 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
    prerelease: match[4],
  };
}

function comparePrerelease(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const maxParts = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxParts; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];

    if (leftPart === undefined) {
      return -1;
    }

    if (rightPart === undefined) {
      return 1;
    }

    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    const leftIsNumber = Number.isInteger(leftNumber) && String(leftNumber) === leftPart;
    const rightIsNumber = Number.isInteger(rightNumber) && String(rightNumber) === rightPart;

    if (leftIsNumber && rightIsNumber) {
      if (leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }

      continue;
    }

    if (leftIsNumber) {
      return -1;
    }

    if (rightIsNumber) {
      return 1;
    }

    const comparison = leftPart.localeCompare(rightPart);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

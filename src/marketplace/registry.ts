import { MarketplaceError } from "./errors";
import type { MarketplaceSource } from "./types";

function normalizeSourceId(sourceId: string): string {
  return sourceId.trim().toLowerCase();
}

/**
 * Registry for managing multiple marketplace sources.
 * Mirrors the ProviderRegistry/IntegrationRegistry pattern.
 */
export class MarketplaceRegistry {
  private readonly sources = new Map<string, MarketplaceSource>();

  register(source: MarketplaceSource): void {
    const sourceId = normalizeSourceId(source.id);

    if (this.sources.has(sourceId)) {
      throw new MarketplaceError(
        `Marketplace source already registered: ${sourceId}`,
        "MARKETPLACE_SOURCE_ERROR",
      );
    }

    this.sources.set(sourceId, source);
  }

  get(id: string): MarketplaceSource | undefined {
    return this.sources.get(normalizeSourceId(id));
  }

  list(): MarketplaceSource[] {
    return Array.from(this.sources.values());
  }

  has(id: string): boolean {
    return this.sources.has(normalizeSourceId(id));
  }

  remove(id: string): boolean {
    return this.sources.delete(normalizeSourceId(id));
  }

  clear(): void {
    this.sources.clear();
  }
}

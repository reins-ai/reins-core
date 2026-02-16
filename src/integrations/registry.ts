import { IntegrationError } from "./errors";
import type { Integration, IntegrationCategory } from "./types";

function normalizeIntegrationId(integrationId: string): string {
  return integrationId.trim().toLowerCase();
}

export class IntegrationRegistry {
  private readonly integrations = new Map<string, Integration>();

  register(integration: Integration): void {
    const integrationId = normalizeIntegrationId(integration.config.id);

    if (this.integrations.has(integrationId)) {
      throw new IntegrationError(`Integration already registered: ${integrationId}`);
    }

    this.integrations.set(integrationId, integration);
  }

  get(id: string): Integration | undefined {
    return this.integrations.get(normalizeIntegrationId(id));
  }

  getOrThrow(id: string): Integration {
    const integration = this.get(id);

    if (!integration) {
      throw new IntegrationError(`Integration not found: ${id}`);
    }

    return integration;
  }

  list(): Integration[] {
    return Array.from(this.integrations.values());
  }

  remove(id: string): boolean {
    return this.integrations.delete(normalizeIntegrationId(id));
  }

  has(id: string): boolean {
    return this.integrations.has(normalizeIntegrationId(id));
  }

  clear(): void {
    this.integrations.clear();
  }

  enable(id: string): boolean {
    const integration = this.get(id);
    if (!integration) {
      return false;
    }

    integration.config.enabled = true;
    return true;
  }

  disable(id: string): boolean {
    const integration = this.get(id);
    if (!integration) {
      return false;
    }

    integration.config.enabled = false;
    return true;
  }

  listActive(): Integration[] {
    return this.list().filter((integration) => integration.config.enabled);
  }

  listByCategory(category: IntegrationCategory): Integration[] {
    return this.list().filter((integration) => integration.manifest.category === category);
  }
}

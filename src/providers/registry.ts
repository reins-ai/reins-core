import { ProviderError } from "../errors";
import type { Provider, ProviderAuthMode, ProviderCapabilities } from "../types";

function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

function normalizeAuthModes(authModes: ProviderAuthMode[]): ProviderAuthMode[] {
  return Array.from(new Set(authModes));
}

function cloneCapabilities(capabilities: ProviderCapabilities): ProviderCapabilities {
  return {
    authModes: [...capabilities.authModes],
    requiresAuth: capabilities.requiresAuth,
    envVars: capabilities.envVars ? [...capabilities.envVars] : undefined,
    baseUrl: capabilities.baseUrl,
  };
}

function inferCapabilities(provider: Provider): ProviderCapabilities {
  switch (provider.config.type) {
    case "local":
      return {
        authModes: [],
        requiresAuth: false,
        baseUrl: provider.config.baseUrl,
      };
    case "oauth":
      return {
        authModes: ["oauth"],
        requiresAuth: true,
        baseUrl: provider.config.baseUrl,
      };
    case "gateway":
    case "byok":
      return {
        authModes: ["api_key"],
        requiresAuth: true,
        baseUrl: provider.config.baseUrl,
      };
    default:
      return {
        authModes: ["api_key"],
        requiresAuth: true,
        baseUrl: provider.config.baseUrl,
      };
  }
}

const DEFAULT_PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  anthropic: {
    authModes: ["api_key", "oauth"],
    requiresAuth: true,
    envVars: ["ANTHROPIC_API_KEY"],
    baseUrl: "https://api.anthropic.com",
  },
  openai: {
    authModes: ["api_key", "oauth"],
    requiresAuth: true,
    envVars: ["OPENAI_API_KEY"],
    baseUrl: "https://api.openai.com",
  },
  google: {
    authModes: ["api_key", "oauth"],
    requiresAuth: true,
    envVars: ["GOOGLE_API_KEY"],
    baseUrl: "https://generativelanguage.googleapis.com",
  },
  glm: {
    authModes: ["api_key", "oauth"],
    requiresAuth: true,
  },
  kimi: {
    authModes: ["api_key", "oauth"],
    requiresAuth: true,
  },
  minimax: {
    authModes: ["api_key", "oauth"],
    requiresAuth: true,
  },
  "reins-gateway": {
    authModes: ["api_key"],
    requiresAuth: true,
    envVars: ["REINS_GATEWAY_API_KEY"],
  },
  ollama: {
    authModes: [],
    requiresAuth: false,
    baseUrl: "http://localhost:11434",
  },
  vllm: {
    authModes: [],
    requiresAuth: false,
    baseUrl: "http://localhost:8000",
  },
  lmstudio: {
    authModes: [],
    requiresAuth: false,
    baseUrl: "http://localhost:1234",
  },
};

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();
  private readonly capabilities = new Map<string, ProviderCapabilities>();

  constructor() {
    for (const [providerId, capabilities] of Object.entries(DEFAULT_PROVIDER_CAPABILITIES)) {
      this.capabilities.set(providerId, cloneCapabilities(capabilities));
    }
  }

  register(provider: Provider): void {
    const providerId = normalizeProviderId(provider.config.id);

    if (this.providers.has(providerId)) {
      throw new ProviderError(`Provider already registered: ${providerId}`);
    }

    this.providers.set(providerId, provider);

    if (provider.config.capabilities) {
      this.registerCapabilities(providerId, provider.config.capabilities);
      return;
    }

    if (!this.capabilities.has(providerId)) {
      this.registerCapabilities(providerId, inferCapabilities(provider));
    }
  }

  get(id: string): Provider | undefined {
    return this.providers.get(normalizeProviderId(id));
  }

  getOrThrow(id: string): Provider {
    const provider = this.get(id);

    if (!provider) {
      throw new ProviderError(`Provider not found: ${id}`);
    }

    return provider;
  }

  list(): Provider[] {
    return Array.from(this.providers.values());
  }

  remove(id: string): boolean {
    return this.providers.delete(normalizeProviderId(id));
  }

  has(id: string): boolean {
    return this.providers.has(normalizeProviderId(id));
  }

  clear(): void {
    this.providers.clear();
    this.capabilities.clear();
    for (const [providerId, capabilities] of Object.entries(DEFAULT_PROVIDER_CAPABILITIES)) {
      this.capabilities.set(providerId, cloneCapabilities(capabilities));
    }
  }

  registerCapabilities(providerId: string, capabilities: ProviderCapabilities): void {
    const normalizedProviderId = normalizeProviderId(providerId);
    this.capabilities.set(normalizedProviderId, {
      authModes: normalizeAuthModes(capabilities.authModes),
      requiresAuth: capabilities.requiresAuth,
      envVars: capabilities.envVars ? [...capabilities.envVars] : undefined,
      baseUrl: capabilities.baseUrl,
    });
  }

  getCapabilities(providerId: string): ProviderCapabilities | undefined {
    const capabilities = this.capabilities.get(normalizeProviderId(providerId));
    if (!capabilities) {
      return undefined;
    }

    return cloneCapabilities(capabilities);
  }

  listCapabilities(): Array<{ providerId: string; capabilities: ProviderCapabilities }> {
    return Array.from(this.capabilities.entries()).map(([providerId, capabilities]) => ({
      providerId,
      capabilities: cloneCapabilities(capabilities),
    }));
  }
}

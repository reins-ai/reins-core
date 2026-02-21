import type { ProviderHealth } from "./types";

type HealthCallback = (health: ProviderHealth) => void;

/** Default timeout (ms) for each health-check probe request. */
const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function createUnavailableHealth(error: string): ProviderHealth {
  return {
    status: "unavailable",
    lastChecked: new Date(),
    error,
  };
}

export class HealthChecker {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly callbacks: HealthCallback[] = [];

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastStatus: ProviderHealth = {
    status: "unknown",
    lastChecked: new Date(),
  };

  constructor(baseUrl: string, timeout: number = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeoutMs = timeout;
  }

  async check(): Promise<ProviderHealth> {
    const probePaths = this.getProbePaths();
    let lastUnavailable: ProviderHealth | undefined;

    for (const path of probePaths) {
      const result = await this.probe(path);
      if (result.status === "available") {
        return this.updateStatus(result);
      }
      lastUnavailable = result;
    }

    return this.updateStatus(lastUnavailable ?? createUnavailableHealth("No health probe paths configured"));
  }

  startPolling(intervalMs: number): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.check();
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  getStatus(): ProviderHealth {
    return {
      ...this.lastStatus,
      lastChecked: new Date(this.lastStatus.lastChecked),
    };
  }

  onStatusChange(callback: (health: ProviderHealth) => void): void {
    this.callbacks.push(callback);
  }

  private getProbePaths(): string[] {
    const normalized = this.baseUrl.toLowerCase();

    if (normalized.includes("11434") || normalized.includes("ollama")) {
      return ["api/tags"];
    }

    if (normalized.includes("8000") || normalized.includes("vllm")) {
      return ["v1/models"];
    }

    return ["api/tags", "v1/models"];
  }

  private async probe(path: string): Promise<ProviderHealth> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const start = performance.now();

    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method: "GET",
        signal: controller.signal,
      });
      const latencyMs = performance.now() - start;

      if (!response.ok) {
        return {
          status: "unavailable",
          lastChecked: new Date(),
          latencyMs,
          error: `Health check failed with status ${response.status}`,
        };
      }

      return {
        status: "available",
        lastChecked: new Date(),
        latencyMs,
      };
    } catch (error) {
      return {
        status: "unavailable",
        lastChecked: new Date(),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private updateStatus(health: ProviderHealth): ProviderHealth {
    const didStatusChange =
      this.lastStatus.status !== health.status ||
      this.lastStatus.error !== health.error;

    this.lastStatus = health;

    if (didStatusChange) {
      for (const callback of this.callbacks) {
        callback(this.getStatus());
      }
    }

    return this.getStatus();
  }
}

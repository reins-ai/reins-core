import { ok, type Result } from "../result";
import type { TransportType } from "./profile-types";
import type { DaemonError } from "./types";

const DEFAULT_TIMEOUT_MS = 5000;
const UNENCRYPTED_WARNING =
  "Connection is unencrypted. Consider using Tailscale or Cloudflare Tunnel for secure remote access.";

const LOCALHOST_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);

export interface TransportDetectionResult {
  /** Detected transport type */
  type: TransportType;
  /** Whether the connection is encrypted */
  encrypted: boolean;
  /** Security warning message (for direct/unencrypted connections) */
  warning?: string;
}

export interface TransportProbeOptions {
  /** Custom fetch for testing (default: global fetch) */
  fetchFn?: typeof fetch;
  /** Probe timeout in ms (default: 5000) */
  timeout?: number;
}

export class TransportProbe {
  private readonly fetchFn: typeof fetch;
  private readonly timeout: number;

  constructor(options?: TransportProbeOptions) {
    this.fetchFn = options?.fetchFn ?? fetch;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  /** Detect transport type for a given URL */
  async detect(url: string): Promise<Result<TransportDetectionResult, DaemonError>> {
    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch {
      return ok({
        type: "direct",
        encrypted: false,
        warning: UNENCRYPTED_WARNING,
      });
    }

    const hostname = normalizeHostname(parsed.hostname);

    if (this.isLocalhost(hostname)) {
      return ok({ type: "localhost", encrypted: false });
    }

    if (this.isTailscale(hostname)) {
      return ok({ type: "tailscale", encrypted: true });
    }

    if (this.looksLikeCloudflareTunnel(hostname)) {
      await this.probeCloudflareHeaders(url);
      return ok({ type: "cloudflare", encrypted: true });
    }

    if (parsed.protocol === "https:") {
      return ok({ type: "direct", encrypted: true });
    }

    return ok({
      type: "direct",
      encrypted: false,
      warning: UNENCRYPTED_WARNING,
    });
  }

  private isLocalhost(hostname: string): boolean {
    if (LOCALHOST_HOSTS.has(hostname)) {
      return true;
    }

    return hostname === "::ffff:127.0.0.1";
  }

  private isTailscale(hostname: string): boolean {
    if (isInTailscaleCGNAT(hostname)) {
      return true;
    }

    return /.+\.ts\.net$/i.test(hostname);
  }

  private looksLikeCloudflareTunnel(hostname: string): boolean {
    return /.+\.trycloudflare\.com$/i.test(hostname);
  }

  private async probeCloudflareHeaders(url: string): Promise<boolean> {
    try {
      const response = await this.fetchFn(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(this.timeout),
      });

      return response.headers.has("cf-ray");
    } catch {
      return false;
    }
  }
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function isInTailscaleCGNAT(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;

  const first = Number.parseInt(parts[0], 10);
  const second = Number.parseInt(parts[1], 10);
  const third = Number.parseInt(parts[2], 10);
  const fourth = Number.parseInt(parts[3], 10);

  if (
    Number.isNaN(first) ||
    Number.isNaN(second) ||
    Number.isNaN(third) ||
    Number.isNaN(fourth)
  ) {
    return false;
  }

  if (first !== 100) return false;
  if (third < 0 || third > 255 || fourth < 0 || fourth > 255) return false;

  // 100.64.0.0/10 means second octet: 64-127
  return second >= 64 && second <= 127;
}

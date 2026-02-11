import { err, ok, type Result } from "../result";
import type { CredentialRecord } from "../providers/credentials";
import type { BillingSyncPayload } from "./types";
import { SyncError } from "./types";

export interface SyncConfig {
  backendUrl: string;
  authToken: string;
  deviceId: string;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: string[];
}

interface ConvexEnvelope<T> {
  status?: string;
  value?: T;
  errorMessage?: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${"=".repeat(padding)}`, "base64").toString("utf8");
}

function resolveClerkId(authToken: string): string | null {
  const compact = authToken.trim();
  if (compact.length === 0) {
    return null;
  }

  const token = compact.startsWith("Bearer ") ? compact.slice(7).trim() : compact;
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(parts[1])) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

function buildCredentialArgs(config: SyncConfig, record: CredentialRecord) {
  return {
    userId: "self",
    credentialId: record.id,
    provider: record.provider,
    type: record.type,
    encryptedPayload: record.encryptedPayload,
    metadata: record.metadata,
    version: record.sync.version,
    checksum: record.sync.checksum,
    deviceId: config.deviceId,
    accountId: record.accountId,
    revokedAt: record.revokedAt,
    updatedAt: record.updatedAt,
  };
}

export class AccountSyncClient {
  private readonly backendUrl: string;

  constructor(private readonly config: SyncConfig) {
    this.backendUrl = normalizeBaseUrl(config.backendUrl);
  }

  public async pushCredentials(records: CredentialRecord[]): Promise<Result<SyncResult, SyncError>> {
    let pushed = 0;
    const conflicts: string[] = [];

    for (const record of records) {
      const response = await this.executeMutation<{ applied: boolean; reason?: string }>(
        "credential-sync:upsertCredential",
        buildCredentialArgs(this.config, record),
      );
      if (!response.ok) {
        return err(response.error);
      }

      if (response.value.applied) {
        pushed += 1;
      } else if (response.value.reason === "stale_or_duplicate") {
        conflicts.push(record.id);
      }
    }

    return ok({
      pushed,
      pulled: 0,
      conflicts,
    });
  }

  public async pullCredentials(): Promise<Result<CredentialRecord[], SyncError>> {
    const clerkId = resolveClerkId(this.config.authToken);
    if (!clerkId) {
      return err(new SyncError("Unable to determine clerk id from auth token"));
    }

    const response = await this.executeQuery<CredentialRecord[]>("credential-sync:getCredentials", {
      clerkId,
    });
    if (!response.ok) {
      return err(response.error);
    }

    return ok(response.value);
  }

  public async pushBillingSnapshot(snapshot: BillingSyncPayload): Promise<Result<void, SyncError>> {
    const now = Date.now();
    const response = await this.executeMutation("billing-sync:upsertBillingSnapshot", {
      userId: "self",
      gatewayKeyPrefix: snapshot.gatewayKeyPrefix,
      balanceCents: snapshot.balanceCents,
      autoReloadEnabled: snapshot.autoReloadEnabled,
      autoReloadThresholdCents: snapshot.autoReloadThresholdCents,
      autoReloadAmountCents: snapshot.autoReloadAmountCents,
      recentTransactionCount: snapshot.recentTransactionCount,
      deviceId: this.config.deviceId,
      checksum: snapshot.checksum,
      createdAt: now,
      updatedAt: now,
    });

    if (!response.ok) {
      return err(response.error);
    }

    return ok(undefined);
  }

  public async pullBillingSnapshot(): Promise<Result<BillingSyncPayload | null, SyncError>> {
    const response = await this.executeQuery<BillingSyncPayload | null>("billing-sync:getBillingSnapshot", {});
    if (!response.ok) {
      return err(response.error);
    }

    return ok(response.value);
  }

  private async executeQuery<T>(path: string, args: Record<string, unknown>): Promise<Result<T, SyncError>> {
    return this.executeWithRetry<T>("query", path, args);
  }

  private async executeMutation<T = unknown>(path: string, args: Record<string, unknown>): Promise<Result<T, SyncError>> {
    return this.executeWithRetry<T>("mutation", path, args);
  }

  private async executeWithRetry<T>(
    kind: "query" | "mutation",
    path: string,
    args: Record<string, unknown>,
  ): Promise<Result<T, SyncError>> {
    const maxAttempts = 3;
    let lastError: SyncError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await this.execute<T>(kind, path, args);
      if (response.ok) {
        return response;
      }

      lastError = response.error;
      const retryable =
        response.error.message.includes("Network") ||
        response.error.message.includes("timed out") ||
        response.error.message.includes("HTTP 429") ||
        response.error.message.includes("HTTP 5");

      if (!retryable || attempt === maxAttempts) {
        return response;
      }

      await Bun.sleep(attempt * 150);
    }

    return err(lastError ?? new SyncError("Sync request failed"));
  }

  private async execute<T>(
    kind: "query" | "mutation",
    path: string,
    args: Record<string, unknown>,
  ): Promise<Result<T, SyncError>> {
    let response: Response;

    try {
      response = await fetch(`${this.backendUrl}/api/${kind}`, {
        method: "POST",
        headers: {
          Authorization: this.config.authToken.startsWith("Bearer ")
            ? this.config.authToken
            : `Bearer ${this.config.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path, args }),
      });
    } catch (error) {
      return err(new SyncError("Network error while syncing", error instanceof Error ? error : undefined));
    }

    let payload: ConvexEnvelope<T> | null = null;
    try {
      payload = (await response.json()) as ConvexEnvelope<T>;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail = payload?.errorMessage ?? "Request failed";
      const message = `${detail} (HTTP ${response.status} during ${kind} ${path})`;
      return err(new SyncError(message));
    }

    if (payload?.status === "error") {
      return err(new SyncError(payload.errorMessage ?? `Convex ${kind} failed for ${path}`));
    }

    if (payload && "value" in payload) {
      return ok(payload.value as T);
    }

    return err(new SyncError(`Malformed ${kind} response for ${path}`));
  }
}

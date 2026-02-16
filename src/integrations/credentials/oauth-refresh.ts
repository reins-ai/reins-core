import { err, ok, type Result } from "../../result";
import { IntegrationError } from "../errors";
import type { IntegrationStatusIndicator } from "../types";
import type { CredentialVault, OAuthCredential } from "./types";

type TimeoutHandle = ReturnType<typeof setTimeout>;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const AUTH_EXPIRED_INDICATOR: IntegrationStatusIndicator = "auth_expired";

export interface OAuthRefreshPayload {
  access_token: string;
  expires_at: string;
  refresh_token?: string;
  scopes?: string[];
  token_type?: string;
}

export interface RefreshCallbackContext {
  integrationId: string;
  credential: OAuthCredential;
  refreshToken: string;
  attempt: number;
  maxAttempts: number;
}

export type RefreshCallback = (
  context: RefreshCallbackContext,
) => Promise<Result<OAuthRefreshPayload, IntegrationError>>;

export interface IntegrationStatusUpdater {
  updateStatus(
    integrationId: string,
    indicator: IntegrationStatusIndicator,
    reason?: string,
  ): Promise<Result<void, IntegrationError>>;
}

export interface OAuthRefreshManagerOptions {
  credentialVault: CredentialVault;
  statusUpdater: IntegrationStatusUpdater;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  isTransientError?: (error: IntegrationError) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  scheduleTimer?: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearTimer?: (timer: TimeoutHandle) => void;
}

interface ScheduledRefresh {
  callback: RefreshCallback;
  timer: TimeoutHandle;
}

function normalizeIntegrationId(integrationId: string): Result<string, IntegrationError> {
  const normalized = integrationId.trim().toLowerCase();
  if (normalized.length === 0) {
    return err(new IntegrationError("Integration id is required for OAuth refresh operations"));
  }

  return ok(normalized);
}

function parseExpiresAt(value: string): Result<number, IntegrationError> {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return err(new IntegrationError("OAuth credential expiry timestamp is invalid"));
  }

  return ok(parsed);
}

function hasTransientSignal(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("network") ||
    normalized.includes("temporar") ||
    normalized.includes("rate limit") ||
    normalized.includes("429") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("econnreset") ||
    normalized.includes("enotfound") ||
    normalized.includes("eai_again") ||
    normalized.includes("fetch failed")
  );
}

function defaultIsTransientError(error: IntegrationError): boolean {
  if (hasTransientSignal(error.message)) {
    return true;
  }

  if (error.cause && hasTransientSignal(error.cause.message)) {
    return true;
  }

  return false;
}

function toBackoffDelayMs(attempt: number, initialBackoffMs: number, maxBackoffMs: number): number {
  return Math.min(initialBackoffMs * Math.pow(2, attempt), maxBackoffMs);
}

function toRefreshDelayMs(nowMs: number, expiresAtMs: number): number {
  const ttlMs = Math.max(0, expiresAtMs - nowMs);
  const proactiveDelayMs = Math.floor(ttlMs * 0.8);
  return Math.min(Math.max(0, proactiveDelayMs), MAX_TIMEOUT_MS);
}

function asOAuthCredential(
  credential: OAuthCredential | null,
  integrationId: string,
): Result<OAuthCredential, IntegrationError> {
  if (!credential) {
    return err(new IntegrationError(`No OAuth credential found for integration ${integrationId}`));
  }

  if (credential.type !== "oauth") {
    return err(new IntegrationError(`Integration ${integrationId} does not use OAuth credentials`));
  }

  if (credential.refresh_token.trim().length === 0) {
    return err(new IntegrationError(`OAuth refresh token is missing for integration ${integrationId}`));
  }

  return ok(credential);
}

export class OAuthRefreshManager {
  private readonly credentialVault: CredentialVault;
  private readonly statusUpdater: IntegrationStatusUpdater;
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly isTransientError: (error: IntegrationError) => boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => TimeoutHandle;
  private readonly clearTimer: (timer: TimeoutHandle) => void;

  private readonly scheduledRefreshes = new Map<string, ScheduledRefresh>();
  private readonly inFlightRefreshes = new Map<string, Promise<Result<OAuthCredential, IntegrationError>>>();

  constructor(options: OAuthRefreshManagerOptions) {
    this.credentialVault = options.credentialVault;
    this.statusUpdater = options.statusUpdater;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.initialBackoffMs = Math.max(1, Math.floor(options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS));
    this.maxBackoffMs = Math.max(this.initialBackoffMs, Math.floor(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS));
    this.isTransientError = options.isTransientError ?? defaultIsTransientError;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.scheduleTimer = options.scheduleTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  public async scheduleRefresh(
    integrationId: string,
    callback: RefreshCallback,
  ): Promise<Result<number, IntegrationError>> {
    const normalizedIdResult = normalizeIntegrationId(integrationId);
    if (!normalizedIdResult.ok) {
      return normalizedIdResult;
    }

    const normalizedId = normalizedIdResult.value;
    const credentialResult = await this.loadOAuthCredential(normalizedId);
    if (!credentialResult.ok) {
      return credentialResult;
    }

    const expiresAtResult = parseExpiresAt(credentialResult.value.expires_at);
    if (!expiresAtResult.ok) {
      return expiresAtResult;
    }

    this.clearScheduledRefresh(normalizedId);

    const delayMs = toRefreshDelayMs(this.now(), expiresAtResult.value);
    const timer = this.scheduleTimer(() => {
      void this.handleScheduledRefresh(normalizedId);
    }, delayMs);

    this.scheduledRefreshes.set(normalizedId, { callback, timer });
    return ok(delayMs);
  }

  public async refreshNow(
    integrationId: string,
    callback?: RefreshCallback,
  ): Promise<Result<OAuthCredential, IntegrationError>> {
    const normalizedIdResult = normalizeIntegrationId(integrationId);
    if (!normalizedIdResult.ok) {
      return normalizedIdResult;
    }

    const normalizedId = normalizedIdResult.value;

    const inFlight = this.inFlightRefreshes.get(normalizedId);
    if (inFlight) {
      return inFlight;
    }

    const activeCallback = callback ?? this.scheduledRefreshes.get(normalizedId)?.callback;
    if (!activeCallback) {
      return err(new IntegrationError(`No OAuth refresh callback registered for integration ${normalizedId}`));
    }

    const refreshPromise = this.executeRefresh(normalizedId, activeCallback);
    this.inFlightRefreshes.set(normalizedId, refreshPromise);

    try {
      return await refreshPromise;
    } finally {
      this.inFlightRefreshes.delete(normalizedId);
    }
  }

  public cancelAll(): Result<void, IntegrationError> {
    for (const scheduled of this.scheduledRefreshes.values()) {
      this.clearTimer(scheduled.timer);
    }

    this.scheduledRefreshes.clear();
    this.inFlightRefreshes.clear();
    return ok(undefined);
  }

  public cancel(integrationId: string): Result<void, IntegrationError> {
    const normalizedIdResult = normalizeIntegrationId(integrationId);
    if (!normalizedIdResult.ok) {
      return normalizedIdResult;
    }

    const normalizedId = normalizedIdResult.value;
    this.clearScheduledRefresh(normalizedId);
    this.inFlightRefreshes.delete(normalizedId);
    return ok(undefined);
  }

  private async handleScheduledRefresh(integrationId: string): Promise<void> {
    const scheduled = this.scheduledRefreshes.get(integrationId);
    if (!scheduled) {
      return;
    }

    const result = await this.refreshNow(integrationId, scheduled.callback);
    if (!result.ok) {
      this.clearScheduledRefresh(integrationId);
    }
  }

  private async executeRefresh(
    integrationId: string,
    callback: RefreshCallback,
  ): Promise<Result<OAuthCredential, IntegrationError>> {
    const credentialResult = await this.loadOAuthCredential(integrationId);
    if (!credentialResult.ok) {
      return credentialResult;
    }

    let credential = credentialResult.value;
    let lastError: IntegrationError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const refreshResult = await callback({
        integrationId,
        credential,
        refreshToken: credential.refresh_token,
        attempt,
        maxAttempts: this.maxAttempts,
      });

      if (refreshResult.ok) {
        const mergedCredential: OAuthCredential = {
          type: "oauth",
          access_token: refreshResult.value.access_token,
          refresh_token: refreshResult.value.refresh_token ?? credential.refresh_token,
          expires_at: refreshResult.value.expires_at,
          scopes: refreshResult.value.scopes ?? credential.scopes,
          token_type: refreshResult.value.token_type ?? credential.token_type,
        };

        const storeResult = await this.credentialVault.store(integrationId, mergedCredential);
        if (!storeResult.ok) {
          return storeResult;
        }

        const scheduleResult = await this.scheduleRefresh(integrationId, callback);
        if (!scheduleResult.ok) {
          return scheduleResult;
        }

        return ok(mergedCredential);
      }

      lastError = refreshResult.error;
      const canRetry = attempt < this.maxAttempts && this.isTransientError(refreshResult.error);
      if (!canRetry) {
        break;
      }

      const delayMs = toBackoffDelayMs(attempt - 1, this.initialBackoffMs, this.maxBackoffMs);
      await this.sleep(delayMs);
      credential = await this.reloadCredential(integrationId, credential);
    }

    const permanentError =
      lastError ?? new IntegrationError(`OAuth token refresh failed for integration ${integrationId}`);
    const statusResult = await this.statusUpdater.updateStatus(
      integrationId,
      AUTH_EXPIRED_INDICATOR,
      permanentError.message,
    );
    if (!statusResult.ok) {
      return statusResult;
    }

    this.clearScheduledRefresh(integrationId);
    return err(permanentError);
  }

  private async loadOAuthCredential(integrationId: string): Promise<Result<OAuthCredential, IntegrationError>> {
    const credentialResult = await this.credentialVault.retrieve<OAuthCredential>(integrationId);
    if (!credentialResult.ok) {
      return credentialResult;
    }

    return asOAuthCredential(credentialResult.value, integrationId);
  }

  private async reloadCredential(
    integrationId: string,
    fallbackCredential: OAuthCredential,
  ): Promise<OAuthCredential> {
    const latestCredentialResult = await this.loadOAuthCredential(integrationId);
    if (!latestCredentialResult.ok) {
      return fallbackCredential;
    }

    return latestCredentialResult.value;
  }

  private clearScheduledRefresh(integrationId: string): void {
    const scheduled = this.scheduledRefreshes.get(integrationId);
    if (!scheduled) {
      return;
    }

    this.clearTimer(scheduled.timer);
    this.scheduledRefreshes.delete(integrationId);
  }
}

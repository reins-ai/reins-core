import { createLogger } from "../../logger";
import type { AuthError } from "../../errors";
import type { Result } from "../../result";
import type { OAuthProviderType, OAuthTokens } from "./types";

const log = createLogger("providers:oauth:keepalive");

// Retry delays after refresh failure (exponential backoff, capped at 30 minutes)
const RETRY_DELAYS_MS = [
  60_000,        // 1 minute
  2 * 60_000,    // 2 minutes
  5 * 60_000,    // 5 minutes
  10 * 60_000,   // 10 minutes
  30 * 60_000,   // 30 minutes (cap)
] as const;

export interface OAuthKeepaliveOptions {
  /** Provider identifier for logging. */
  provider: OAuthProviderType;
  /**
   * Called to get/refresh the access token. Must update all underlying storage
   * (both oauth_<provider> and auth_<provider>_oauth keys).
   * The keepalive fires this at the moment the token is considered expired by the
   * 5-minute buffer check, so the implementation should perform a real refresh.
   */
  getOrRefreshToken: () => Promise<Result<string, AuthError>>;
  /**
   * Called to load current tokens to compute the next refresh schedule.
   * Does NOT trigger a refresh — purely reads current state.
   */
  loadCurrentTokens: () => Promise<OAuthTokens | null>;
  /**
   * How early before token expiry to trigger the proactive refresh.
   * Must match the buffer used by isOAuthTokenExpired() so the timer fires
   * exactly when getOrRefreshToken() will perform a refresh.
   * Default: 5 minutes (matching EXPIRY_BUFFER_MS in auth-service.ts and flow.ts).
   */
  refreshBufferMs?: number;
  /** Override for testing. Default: Date.now */
  now?: () => number;
  /** Override for testing. Default: setTimeout */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

/**
 * Proactively refreshes an OAuth access token before it expires.
 *
 * Schedule: fires at (expiresAt − refreshBufferMs), which is exactly the moment
 * the 5-minute buffer check considers the token expired. This ensures the token
 * refresh call will actually perform a refresh (not return the cached token).
 *
 * On failure: retries with exponential backoff (1m → 2m → 5m → 10m → 30m).
 * On success: reads the new expiresAt and schedules the next cycle.
 *
 * Concurrent refresh guard: if a refresh is already in progress (e.g. triggered
 * by a simultaneous API call), the keepalive skips its attempt and reschedules
 * for the next cycle.
 */
export class OAuthTokenKeepaliveService {
  private readonly provider: OAuthProviderType;
  private readonly getOrRefreshToken: () => Promise<Result<string, AuthError>>;
  private readonly loadCurrentTokens: () => Promise<OAuthTokens | null>;
  private readonly refreshBufferMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private isRefreshing = false;
  private running = false;

  constructor(options: OAuthKeepaliveOptions) {
    this.provider = options.provider;
    this.getOrRefreshToken = options.getOrRefreshToken;
    this.loadCurrentTokens = options.loadCurrentTokens;
    this.refreshBufferMs = options.refreshBufferMs ?? 5 * 60_000;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.retryCount = 0;
    log.info("OAuth keepalive started", { provider: this.provider });
    await this.scheduleNextRefresh();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info("OAuth keepalive stopped", { provider: this.provider });
  }

  private async scheduleNextRefresh(): Promise<void> {
    if (!this.running) {
      return;
    }

    let tokens: OAuthTokens | null = null;
    try {
      tokens = await this.loadCurrentTokens();
    } catch (error) {
      log.warn("Keepalive: failed to load tokens for scheduling", {
        provider: this.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!tokens) {
      log.debug("Keepalive: no tokens found, will not schedule", { provider: this.provider });
      return;
    }

    if (!tokens.refreshToken) {
      log.debug("Keepalive: no refresh token available, will not schedule", { provider: this.provider });
      return;
    }

    // Fire at the exact moment isOAuthTokenExpired() would return true:
    // delay = max(0, expiresAt - now - refreshBufferMs)
    const msUntilRefresh = tokens.expiresAt.getTime() - this.now() - this.refreshBufferMs;
    const delay = Math.max(0, msUntilRefresh);

    log.debug("Keepalive: scheduling next refresh", {
      provider: this.provider,
      expiresAt: tokens.expiresAt.toISOString(),
      delayMs: delay,
    });

    this.timer = this.schedule(() => {
      void this.doRefresh();
    }, delay);
  }

  private async doRefresh(): Promise<void> {
    if (!this.running) {
      return;
    }

    if (this.isRefreshing) {
      // Another refresh is already in flight (e.g. triggered by a simultaneous API call).
      // Wait and reschedule rather than racing to refresh with the same refresh token.
      log.debug("Keepalive: refresh already in progress, will reschedule", { provider: this.provider });
      // Retry after a short delay to check if the concurrent refresh completed
      const delay = 30_000; // 30 seconds
      this.timer = this.schedule(() => {
        void this.scheduleNextRefresh();
      }, delay);
      return;
    }

    this.isRefreshing = true;
    log.info("Keepalive: proactively refreshing token", { provider: this.provider });

    try {
      const result = await this.getOrRefreshToken();
      this.isRefreshing = false;

      if (!result.ok) {
        log.warn("Keepalive: token refresh failed", {
          provider: this.provider,
          retryCount: this.retryCount,
          error: result.error.message,
        });
        await this.scheduleRetry();
        return;
      }

      this.retryCount = 0;
      log.info("Keepalive: token refreshed successfully", { provider: this.provider });
      await this.scheduleNextRefresh();
    } catch (error) {
      this.isRefreshing = false;
      log.warn("Keepalive: unexpected error during token refresh", {
        provider: this.provider,
        retryCount: this.retryCount,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.scheduleRetry();
    }
  }

  private async scheduleRetry(): Promise<void> {
    if (!this.running) {
      return;
    }

    const delayIndex = Math.min(this.retryCount, RETRY_DELAYS_MS.length - 1);
    const retryDelay = RETRY_DELAYS_MS[delayIndex]!;
    this.retryCount++;

    log.info("Keepalive: scheduling retry", {
      provider: this.provider,
      retryCount: this.retryCount,
      retryDelayMs: retryDelay,
    });

    this.timer = this.schedule(() => {
      void this.doRefresh();
    }, retryDelay);
  }
}

import { describe, expect, it } from "bun:test";

import { IntegrationError } from "../../src/integrations/errors";
import {
  InMemoryCredentialVault,
} from "../../src/integrations/credentials/vault";
import {
  OAuthRefreshManager,
  type IntegrationStatusUpdater,
  type OAuthRefreshManagerOptions,
  type OAuthRefreshPayload,
  type RefreshCallback,
  type RefreshCallbackContext,
} from "../../src/integrations/credentials/oauth-refresh";
import type {
  OAuthCredential,
} from "../../src/integrations/credentials/types";
import type { IntegrationStatusIndicator } from "../../src/integrations/types";
import { ok, err, type Result } from "../../src/result";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function oauthCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access_token: "access-abc-123",
    refresh_token: "refresh-xyz-789",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: ["read", "write"],
    token_type: "Bearer",
    ...overrides,
  };
}

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// ---------------------------------------------------------------------------
// Mock status updater
// ---------------------------------------------------------------------------

interface StatusUpdate {
  integrationId: string;
  indicator: IntegrationStatusIndicator;
  reason?: string;
}

function createMockStatusUpdater() {
  const updates: StatusUpdate[] = [];

  const updater: IntegrationStatusUpdater = {
    async updateStatus(integrationId, indicator, reason) {
      updates.push({ integrationId, indicator, reason });
      return ok(undefined);
    },
  };

  return { updater, updates };
}

function createFailingStatusUpdater(): IntegrationStatusUpdater {
  return {
    async updateStatus(_integrationId, _indicator, _reason) {
      return err(new IntegrationError("Status update service unavailable"));
    },
  };
}

// ---------------------------------------------------------------------------
// Mock timer infrastructure
// ---------------------------------------------------------------------------

interface MockTimers {
  scheduledCallbacks: Map<number, { callback: () => void; delayMs: number }>;
  nextId: number;
  scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  fireTimer: (id: number) => void;
  fireAll: () => void;
  getScheduledDelays: () => number[];
}

function createMockTimers(): MockTimers {
  const scheduledCallbacks = new Map<number, { callback: () => void; delayMs: number }>();
  let nextId = 1;

  return {
    scheduledCallbacks,
    get nextId() { return nextId; },
    set nextId(v) { nextId = v; },

    scheduleTimer(callback: () => void, delayMs: number) {
      const id = nextId++;
      scheduledCallbacks.set(id, { callback, delayMs });
      return id as unknown as ReturnType<typeof setTimeout>;
    },

    clearTimer(timer: ReturnType<typeof setTimeout>) {
      scheduledCallbacks.delete(timer as unknown as number);
    },

    fireTimer(id: number) {
      const entry = scheduledCallbacks.get(id);
      if (entry) {
        scheduledCallbacks.delete(id);
        entry.callback();
      }
    },

    fireAll() {
      const entries = Array.from(scheduledCallbacks.entries());
      for (const [id, entry] of entries) {
        scheduledCallbacks.delete(id);
        entry.callback();
      }
    },

    getScheduledDelays() {
      return Array.from(scheduledCallbacks.values()).map((e) => e.delayMs);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock sleep
// ---------------------------------------------------------------------------

function createMockSleep() {
  const sleepCalls: number[] = [];

  async function sleep(ms: number): Promise<void> {
    sleepCalls.push(ms);
  }

  return { sleep, sleepCalls };
}

// ---------------------------------------------------------------------------
// Refresh callback helpers
// ---------------------------------------------------------------------------

function successfulRefreshCallback(
  overrides: Partial<OAuthRefreshPayload> = {},
): RefreshCallback {
  return async (_context: RefreshCallbackContext) => {
    return ok({
      access_token: overrides.access_token ?? "new-access-token",
      expires_at: overrides.expires_at ?? futureIso(3_600_000),
      refresh_token: overrides.refresh_token,
      scopes: overrides.scopes,
      token_type: overrides.token_type,
    });
  };
}

function failingRefreshCallback(message: string, transient = false): RefreshCallback {
  return async (_context: RefreshCallbackContext) => {
    const errorMessage = transient ? `Network timeout: ${message}` : message;
    return err(new IntegrationError(errorMessage));
  };
}

function countingRefreshCallback(options: {
  failUntilAttempt?: number;
  transientMessage?: string;
  successPayload?: Partial<OAuthRefreshPayload>;
} = {}): { callback: RefreshCallback; attempts: RefreshCallbackContext[] } {
  const attempts: RefreshCallbackContext[] = [];
  const failUntil = options.failUntilAttempt ?? 0;

  const callback: RefreshCallback = async (context) => {
    attempts.push({ ...context });

    if (context.attempt <= failUntil) {
      const msg = options.transientMessage ?? "Network timeout during refresh";
      return err(new IntegrationError(msg));
    }

    return ok({
      access_token: options.successPayload?.access_token ?? "refreshed-token",
      expires_at: options.successPayload?.expires_at ?? futureIso(3_600_000),
      refresh_token: options.successPayload?.refresh_token,
    });
  };

  return { callback, attempts };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createManager(overrides: Partial<OAuthRefreshManagerOptions> = {}) {
  const vault = new InMemoryCredentialVault();
  const { updater, updates } = createMockStatusUpdater();
  const timers = createMockTimers();
  const { sleep, sleepCalls } = createMockSleep();

  const manager = new OAuthRefreshManager({
    credentialVault: overrides.credentialVault ?? vault,
    statusUpdater: overrides.statusUpdater ?? updater,
    maxAttempts: overrides.maxAttempts ?? 3,
    initialBackoffMs: overrides.initialBackoffMs ?? 100,
    maxBackoffMs: overrides.maxBackoffMs ?? 1_000,
    now: overrides.now ?? (() => Date.now()),
    sleep: overrides.sleep ?? sleep,
    scheduleTimer: overrides.scheduleTimer ?? timers.scheduleTimer,
    clearTimer: overrides.clearTimer ?? timers.clearTimer,
    isTransientError: overrides.isTransientError,
  });

  return { manager, vault, updater, updates, timers, sleep, sleepCalls };
}

// ===========================================================================
// scheduleRefresh
// ===========================================================================

describe("OAuthRefreshManager scheduleRefresh", () => {
  it("schedules a refresh and returns the delay in milliseconds", async () => {
    const { manager, vault, timers } = createManager();
    const cred = oauthCredential({ expires_at: futureIso(10_000) });
    await vault.store("adapter-alpha", cred);

    const result = await manager.scheduleRefresh("adapter-alpha", successfulRefreshCallback());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Delay should be approximately 80% of TTL
    expect(result.value).toBeGreaterThan(0);
    expect(result.value).toBeLessThanOrEqual(10_000);

    // A timer should have been scheduled
    expect(timers.scheduledCallbacks.size).toBe(1);
  });

  it("schedules refresh at 80% of TTL, not 100%", async () => {
    const fixedNow = Date.now();
    const ttlMs = 100_000; // 100 seconds
    const expiresAt = new Date(fixedNow + ttlMs).toISOString();

    const { manager, vault, timers } = createManager({
      now: () => fixedNow,
    });
    const cred = oauthCredential({ expires_at: expiresAt });
    await vault.store("adapter-alpha", cred);

    const result = await manager.scheduleRefresh("adapter-alpha", successfulRefreshCallback());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 80% of 100_000 = 80_000
    const expectedDelay = Math.floor(ttlMs * 0.8);
    expect(result.value).toBe(expectedDelay);

    const delays = timers.getScheduledDelays();
    expect(delays.length).toBe(1);
    expect(delays[0]).toBe(expectedDelay);
  });

  it("returns error when no OAuth credential exists", async () => {
    const { manager } = createManager();

    const result = await manager.scheduleRefresh("nonexistent", successfulRefreshCallback());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
  });

  it("returns error for empty integration id", async () => {
    const { manager } = createManager();

    const result = await manager.scheduleRefresh("  ", successfulRefreshCallback());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
  });

  it("returns error when credential has invalid expiry timestamp", async () => {
    const { manager, vault } = createManager();
    await vault.store("adapter-alpha", oauthCredential({ expires_at: "not-a-date" }));

    const result = await manager.scheduleRefresh("adapter-alpha", successfulRefreshCallback());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("invalid");
  });

  it("replaces a previously scheduled refresh for the same integration", async () => {
    const { manager, vault, timers } = createManager();
    await vault.store("adapter-alpha", oauthCredential());

    await manager.scheduleRefresh("adapter-alpha", successfulRefreshCallback());
    expect(timers.scheduledCallbacks.size).toBe(1);

    await manager.scheduleRefresh("adapter-alpha", successfulRefreshCallback());
    // Old timer should be cleared, new one scheduled
    expect(timers.scheduledCallbacks.size).toBe(1);
  });

  it("handles already-expired tokens with zero delay", async () => {
    const fixedNow = Date.now();
    const { manager, vault, timers } = createManager({
      now: () => fixedNow,
    });
    const expired = oauthCredential({
      expires_at: new Date(fixedNow - 1_000).toISOString(),
    });
    await vault.store("adapter-alpha", expired);

    const result = await manager.scheduleRefresh("adapter-alpha", successfulRefreshCallback());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(0);

    const delays = timers.getScheduledDelays();
    expect(delays[0]).toBe(0);
  });

  it("normalizes integration id (case-insensitive, trimmed)", async () => {
    const { manager, vault } = createManager();
    await vault.store("adapter-alpha", oauthCredential());

    const result = await manager.scheduleRefresh("  ADAPTER-ALPHA  ", successfulRefreshCallback());
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// refreshNow
// ===========================================================================

describe("OAuthRefreshManager refreshNow", () => {
  it("refreshes immediately and updates the vault with new tokens", async () => {
    const { manager, vault } = createManager();
    const originalCred = oauthCredential();
    await vault.store("adapter-alpha", originalCred);

    const newPayload: Partial<OAuthRefreshPayload> = {
      access_token: "brand-new-access-token",
      expires_at: futureIso(7_200_000),
    };

    const result = await manager.refreshNow("adapter-alpha", successfulRefreshCallback(newPayload));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.access_token).toBe("brand-new-access-token");
    // Original refresh token should be preserved when not provided in payload
    expect(result.value.refresh_token).toBe(originalCred.refresh_token);

    // Verify vault was updated
    const storedResult = await vault.retrieve<OAuthCredential>("adapter-alpha");
    expect(storedResult.ok).toBe(true);
    if (!storedResult.ok) return;
    expect(storedResult.value!.access_token).toBe("brand-new-access-token");
  });

  it("preserves original scopes and token_type when not provided in refresh payload", async () => {
    const { manager, vault } = createManager();
    const originalCred = oauthCredential({
      scopes: ["email", "profile"],
      token_type: "Bearer",
    });
    await vault.store("adapter-alpha", originalCred);

    const result = await manager.refreshNow("adapter-alpha", successfulRefreshCallback());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.scopes).toEqual(["email", "profile"]);
    expect(result.value.token_type).toBe("Bearer");
  });

  it("updates refresh token when provided in refresh payload", async () => {
    const { manager, vault } = createManager();
    await vault.store("adapter-alpha", oauthCredential());

    const result = await manager.refreshNow("adapter-alpha", successfulRefreshCallback({
      refresh_token: "rotated-refresh-token",
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.refresh_token).toBe("rotated-refresh-token");

    const storedResult = await vault.retrieve<OAuthCredential>("adapter-alpha");
    expect(storedResult.ok).toBe(true);
    if (!storedResult.ok) return;
    expect(storedResult.value!.refresh_token).toBe("rotated-refresh-token");
  });

  it("returns error when no OAuth credential exists", async () => {
    const { manager } = createManager();

    const result = await manager.refreshNow("nonexistent", successfulRefreshCallback());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
  });

  it("returns error for empty integration id", async () => {
    const { manager } = createManager();

    const result = await manager.refreshNow("", successfulRefreshCallback());
    expect(result.ok).toBe(false);
  });

  it("uses registered callback when no explicit callback provided", async () => {
    const { manager, vault } = createManager();
    await vault.store("adapter-alpha", oauthCredential());

    // Register via scheduleRefresh
    await manager.scheduleRefresh("adapter-alpha", successfulRefreshCallback({
      access_token: "from-registered-callback",
    }));

    const result = await manager.refreshNow("adapter-alpha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.access_token).toBe("from-registered-callback");
  });

  it("returns error when no callback is registered or provided", async () => {
    const { manager, vault } = createManager();
    await vault.store("adapter-alpha", oauthCredential());

    const result = await manager.refreshNow("adapter-alpha");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("callback");
  });

  it("schedules next refresh after successful refresh", async () => {
    const { manager, vault, timers } = createManager();
    await vault.store("adapter-alpha", oauthCredential());

    // Register callback first
    await manager.scheduleRefresh("adapter-alpha", successfulRefreshCallback());
    const initialTimerCount = timers.scheduledCallbacks.size;

    const result = await manager.refreshNow("adapter-alpha");
    expect(result.ok).toBe(true);

    // A new timer should be scheduled for the next refresh
    expect(timers.scheduledCallbacks.size).toBeGreaterThanOrEqual(initialTimerCount);
  });
});

// ===========================================================================
// Retry with backoff
// ===========================================================================

describe("OAuthRefreshManager retry with backoff", () => {
  it("retries on transient errors with exponential backoff", async () => {
    const { manager, vault, sleepCalls } = createManager({
      maxAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
    });
    await vault.store("adapter-alpha", oauthCredential());

    // Fail first 2 attempts with transient error, succeed on 3rd
    const { callback, attempts } = countingRefreshCallback({
      failUntilAttempt: 2,
      transientMessage: "Network timeout during refresh",
    });

    const result = await manager.refreshNow("adapter-alpha", callback);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(attempts.length).toBe(3);
    expect(result.value.access_token).toBe("refreshed-token");

    // Should have slept twice (after attempt 1 and 2)
    expect(sleepCalls.length).toBe(2);
    // First backoff: 100 * 2^0 = 100
    expect(sleepCalls[0]).toBe(100);
    // Second backoff: 100 * 2^1 = 200
    expect(sleepCalls[1]).toBe(200);
  });

  it("does not retry on non-transient errors", async () => {
    const { manager, vault, updates } = createManager({ maxAttempts: 3 });
    await vault.store("adapter-alpha", oauthCredential());

    const { callback, attempts } = countingRefreshCallback({
      failUntilAttempt: 999, // Always fail
      transientMessage: "Invalid grant: token revoked", // Not transient
    });

    const result = await manager.refreshNow("adapter-alpha", callback);
    expect(result.ok).toBe(false);

    // Should only attempt once since the error is not transient
    expect(attempts.length).toBe(1);

    // Status should be updated to auth_expired
    expect(updates.length).toBe(1);
    expect(updates[0]!.indicator).toBe("auth_expired");
  });

  it("respects maxBackoffMs cap", async () => {
    const { manager, vault, sleepCalls } = createManager({
      maxAttempts: 4,
      initialBackoffMs: 500,
      maxBackoffMs: 1_000,
    });
    await vault.store("adapter-alpha", oauthCredential());

    const { callback } = countingRefreshCallback({
      failUntilAttempt: 3,
      transientMessage: "Network timeout",
    });

    await manager.refreshNow("adapter-alpha", callback);

    // Backoff: 500*2^0=500, 500*2^1=1000, 500*2^2=2000 → capped at 1000
    expect(sleepCalls[0]).toBe(500);
    expect(sleepCalls[1]).toBe(1_000);
    expect(sleepCalls[2]).toBe(1_000); // Capped
  });

  it("passes correct attempt and maxAttempts to callback context", async () => {
    const { manager, vault } = createManager({ maxAttempts: 3 });
    await vault.store("adapter-alpha", oauthCredential());

    const { callback, attempts } = countingRefreshCallback({
      failUntilAttempt: 2,
      transientMessage: "Network timeout",
    });

    await manager.refreshNow("adapter-alpha", callback);

    expect(attempts[0]!.attempt).toBe(1);
    expect(attempts[0]!.maxAttempts).toBe(3);
    expect(attempts[1]!.attempt).toBe(2);
    expect(attempts[2]!.attempt).toBe(3);
  });

  it("provides integration id and credential in callback context", async () => {
    const { manager, vault } = createManager();
    const cred = oauthCredential({ refresh_token: "my-refresh-token" });
    await vault.store("adapter-alpha", cred);

    const { callback, attempts } = countingRefreshCallback();

    await manager.refreshNow("adapter-alpha", callback);

    expect(attempts.length).toBe(1);
    expect(attempts[0]!.integrationId).toBe("adapter-alpha");
    expect(attempts[0]!.refreshToken).toBe("my-refresh-token");
    expect(attempts[0]!.credential.type).toBe("oauth");
  });
});

// ===========================================================================
// Permanent failure → auth_expired
// ===========================================================================

describe("OAuthRefreshManager permanent failure", () => {
  it("updates status to auth_expired after all retries exhausted", async () => {
    const { manager, vault, updates } = createManager({ maxAttempts: 3 });
    await vault.store("adapter-alpha", oauthCredential());

    const { callback, attempts } = countingRefreshCallback({
      failUntilAttempt: 999,
      transientMessage: "Network timeout",
    });

    const result = await manager.refreshNow("adapter-alpha", callback);
    expect(result.ok).toBe(false);

    // All 3 attempts should have been made
    expect(attempts.length).toBe(3);

    // Status should be updated to auth_expired
    expect(updates.length).toBe(1);
    expect(updates[0]!.integrationId).toBe("adapter-alpha");
    expect(updates[0]!.indicator).toBe("auth_expired");
    expect(updates[0]!.reason).toContain("timeout");
  });

  it("updates status to auth_expired on first non-transient failure", async () => {
    const { manager, vault, updates } = createManager({ maxAttempts: 3 });
    await vault.store("adapter-alpha", oauthCredential());

    const result = await manager.refreshNow(
      "adapter-alpha",
      failingRefreshCallback("Invalid grant: token permanently revoked"),
    );
    expect(result.ok).toBe(false);

    expect(updates.length).toBe(1);
    expect(updates[0]!.indicator).toBe("auth_expired");
    expect(updates[0]!.reason).toContain("permanently revoked");
  });

  it("returns status updater error when status update fails", async () => {
    const { manager, vault } = createManager({
      statusUpdater: createFailingStatusUpdater(),
      maxAttempts: 1,
    });
    await vault.store("adapter-alpha", oauthCredential());

    const result = await manager.refreshNow(
      "adapter-alpha",
      failingRefreshCallback("Token expired"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Status update service unavailable");
  });

  it("clears scheduled refresh after permanent failure", async () => {
    const { manager, vault, timers } = createManager({ maxAttempts: 1 });
    await vault.store("adapter-alpha", oauthCredential());

    // Schedule first
    await manager.scheduleRefresh("adapter-alpha", failingRefreshCallback("Token expired"));
    expect(timers.scheduledCallbacks.size).toBe(1);

    // Trigger the scheduled refresh by calling refreshNow
    await manager.refreshNow("adapter-alpha", failingRefreshCallback("Token expired"));

    // Scheduled refresh should be cleared after permanent failure
    // (the timer was already consumed, and no new one should be scheduled)
    expect(timers.scheduledCallbacks.size).toBe(0);
  });
});

// ===========================================================================
// cancelAll
// ===========================================================================

describe("OAuthRefreshManager cancelAll", () => {
  it("clears all scheduled refreshes", async () => {
    const { manager, vault, timers } = createManager();
    await vault.store("adapter-alpha", oauthCredential());
    await vault.store("adapter-beta", oauthCredential());

    await manager.scheduleRefresh("adapter-alpha", successfulRefreshCallback());
    await manager.scheduleRefresh("adapter-beta", successfulRefreshCallback());
    expect(timers.scheduledCallbacks.size).toBe(2);

    const result = manager.cancelAll();
    expect(result.ok).toBe(true);
    expect(timers.scheduledCallbacks.size).toBe(0);
  });

  it("is safe to call when no refreshes are scheduled", () => {
    const { manager } = createManager();

    const result = manager.cancelAll();
    expect(result.ok).toBe(true);
  });

  it("prevents previously scheduled callbacks from firing", async () => {
    const { manager, vault, timers } = createManager();
    await vault.store("adapter-alpha", oauthCredential());

    const { callback, attempts } = countingRefreshCallback();
    await manager.scheduleRefresh("adapter-alpha", callback);

    manager.cancelAll();

    // Fire all remaining timers (should be none)
    timers.fireAll();

    // No refresh should have been attempted
    expect(attempts.length).toBe(0);
  });
});

// ===========================================================================
// Transient error detection
// ===========================================================================

describe("OAuthRefreshManager transient error detection", () => {
  const transientMessages = [
    "Network timeout during token exchange",
    "Connection timed out",
    "Temporary server error",
    "Rate limit exceeded (429)",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "ECONNRESET during fetch",
    "ENOTFOUND: DNS resolution failed",
    "EAI_AGAIN: DNS lookup failed",
    "fetch failed: network error",
  ];

  for (const message of transientMessages) {
    it(`retries on transient error: "${message}"`, async () => {
      const { manager, vault } = createManager({ maxAttempts: 2 });
      await vault.store("adapter-alpha", oauthCredential());

      const { callback, attempts } = countingRefreshCallback({
        failUntilAttempt: 1,
        transientMessage: message,
      });

      const result = await manager.refreshNow("adapter-alpha", callback);
      expect(result.ok).toBe(true);
      expect(attempts.length).toBe(2);
    });
  }

  const permanentMessages = [
    "Invalid grant: token revoked",
    "Unauthorized: bad credentials",
    "Permission denied",
    "Account suspended",
  ];

  for (const message of permanentMessages) {
    it(`does not retry on permanent error: "${message}"`, async () => {
      const { manager, vault } = createManager({ maxAttempts: 3 });
      await vault.store("adapter-alpha", oauthCredential());

      const { callback, attempts } = countingRefreshCallback({
        failUntilAttempt: 999,
        transientMessage: message,
      });

      const result = await manager.refreshNow("adapter-alpha", callback);
      expect(result.ok).toBe(false);
      expect(attempts.length).toBe(1);
    });
  }

  it("supports custom isTransientError function", async () => {
    const { manager, vault } = createManager({
      maxAttempts: 2,
      isTransientError: (error) => error.message.includes("CUSTOM_RETRY"),
    });
    await vault.store("adapter-alpha", oauthCredential());

    const { callback, attempts } = countingRefreshCallback({
      failUntilAttempt: 1,
      transientMessage: "CUSTOM_RETRY: please try again",
    });

    const result = await manager.refreshNow("adapter-alpha", callback);
    expect(result.ok).toBe(true);
    expect(attempts.length).toBe(2);
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe("OAuthRefreshManager edge cases", () => {
  it("returns error when credential has empty refresh token", async () => {
    const { manager, vault } = createManager();
    await vault.store("adapter-alpha", oauthCredential({ refresh_token: "   " }));

    const result = await manager.refreshNow("adapter-alpha", successfulRefreshCallback());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("refresh token");
  });

  it("returns error when credential is not OAuth type", async () => {
    const vault = new InMemoryCredentialVault();
    // Store an API key credential, then try to refresh
    await vault.store("openai", {
      type: "api_key",
      key: "sk-test",
      label: "Test",
    });

    const { updater } = createMockStatusUpdater();
    const manager = new OAuthRefreshManager({
      credentialVault: vault,
      statusUpdater: updater,
    });

    const result = await manager.scheduleRefresh("openai", successfulRefreshCallback());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
  });

  it("deduplicates concurrent refreshNow calls for the same integration", async () => {
    const { manager, vault } = createManager();
    await vault.store("adapter-alpha", oauthCredential());

    let callCount = 0;
    const slowCallback: RefreshCallback = async () => {
      callCount++;
      // Simulate slow network
      await new Promise((resolve) => setTimeout(resolve, 10));
      return ok({
        access_token: "refreshed",
        expires_at: futureIso(3_600_000),
      });
    };

    // Fire two concurrent refreshes
    const [result1, result2] = await Promise.all([
      manager.refreshNow("adapter-alpha", slowCallback),
      manager.refreshNow("adapter-alpha", slowCallback),
    ]);

    // Both should succeed
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    // But the callback should only have been called once (deduplication)
    expect(callCount).toBe(1);
  });

  it("handles maxAttempts of 1 (no retries)", async () => {
    const { manager, vault, updates } = createManager({ maxAttempts: 1 });
    await vault.store("adapter-alpha", oauthCredential());

    const { callback, attempts } = countingRefreshCallback({
      failUntilAttempt: 999,
      transientMessage: "Network timeout",
    });

    const result = await manager.refreshNow("adapter-alpha", callback);
    expect(result.ok).toBe(false);
    expect(attempts.length).toBe(1);
    expect(updates.length).toBe(1);
    expect(updates[0]!.indicator).toBe("auth_expired");
  });

  it("multiple integrations can have independent refresh schedules", async () => {
    const { manager, vault, timers } = createManager();
    await vault.store("adapter-alpha", oauthCredential());
    await vault.store("adapter-beta", oauthCredential());

    await manager.scheduleRefresh("adapter-alpha", successfulRefreshCallback());
    await manager.scheduleRefresh("adapter-beta", successfulRefreshCallback());

    expect(timers.scheduledCallbacks.size).toBe(2);

    // Cancel only adapter-alpha by scheduling a new one (which clears the old)
    // and then cancel all
    manager.cancelAll();
    expect(timers.scheduledCallbacks.size).toBe(0);
  });
});

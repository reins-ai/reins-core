import { describe, expect, it } from "bun:test";

import type { ConvexDaemonClient } from "../../src/convex";
import { generateDeviceCode, pollDeviceCode } from "../../src/daemon/device-code-auth";

interface FakeConvexApiClient {
  mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
  query(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
}

function createConvexDaemonClient(client: FakeConvexApiClient): ConvexDaemonClient {
  return {
    getClient(): FakeConvexApiClient {
      return client;
    },
  } as unknown as ConvexDaemonClient;
}

describe("device-code-auth", () => {
  it("generates a six-digit device code and writes it to Convex", async () => {
    let mutationArgs: Record<string, unknown> | null = null;
    const convexClient = createConvexDaemonClient({
      async mutation(_reference, args) {
        mutationArgs = args;
        return "device-code-id";
      },
      async query() {
        return null;
      },
    });

    const result = await generateDeviceCode({
      convexClient,
      now: () => 1_700_000_000_000,
      ttlMs: 60_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.code).toMatch(/^\d{6}$/);
    expect(result.value.expiresAt).toBe(1_700_000_060_000);
    expect(mutationArgs).toEqual({
      code: result.value.code,
      expiresAt: 1_700_000_060_000,
    });
  });

  it("returns pending status while a code is unverified and unexpired", async () => {
    const convexClient = createConvexDaemonClient({
      async mutation() {
        return null;
      },
      async query(_reference, args) {
        return {
          code: args.code,
          expiresAt: 1_700_000_120_000,
          verified: false,
        };
      },
    });

    const result = await pollDeviceCode({
      convexClient,
      code: "123456",
      now: () => 1_700_000_000_000,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        status: "pending",
        expiresAt: 1_700_000_120_000,
      },
    });
  });

  it("returns verified status with user and session token when present", async () => {
    const convexClient = createConvexDaemonClient({
      async mutation() {
        return null;
      },
      async query() {
        return {
          code: "123456",
          expiresAt: 1_700_000_120_000,
          verified: true,
          userId: "user_123",
          sessionToken: "session_abc",
        };
      },
    });

    const result = await pollDeviceCode({
      convexClient,
      code: "123456",
      now: () => 1_700_000_000_000,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        status: "verified",
        userId: "user_123",
        sessionToken: "session_abc",
        expiresAt: 1_700_000_120_000,
      },
    });
  });

  it("returns expired status when the code has passed expiration", async () => {
    const convexClient = createConvexDaemonClient({
      async mutation() {
        return null;
      },
      async query() {
        return {
          code: "123456",
          expiresAt: 1_700_000_000_000,
          verified: false,
        };
      },
    });

    const result = await pollDeviceCode({
      convexClient,
      code: "123456",
      now: () => 1_700_000_000_001,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        status: "expired",
        expiresAt: 1_700_000_000_000,
      },
    });
  });
});

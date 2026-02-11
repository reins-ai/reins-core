import { afterEach, describe, expect, test } from "bun:test";

import { AccountSyncClient } from "../../src/sync/account-sync";
import { type CredentialRecord } from "../../src/providers/credentials";

const originalFetch = globalThis.fetch;

function createJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.`;
}

function createCredential(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  const base: CredentialRecord = {
    id: "cred_openai_default",
    provider: "openai",
    type: "api_key",
    accountId: "default",
    metadata: {
      label: "Main key",
    },
    encryptedPayload: {
      v: 1,
      salt: "salt",
      iv: "iv",
      ciphertext: "ciphertext",
    },
    createdAt: 10,
    updatedAt: 20,
    sync: {
      version: 1,
      checksum: "checksum-1",
      updatedAt: 20,
    },
  };

  return {
    ...base,
    ...overrides,
    encryptedPayload: overrides.encryptedPayload ?? base.encryptedPayload,
    sync: overrides.sync ?? base.sync,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AccountSyncClient", () => {
  test("pushes credentials and tracks conflicts", async () => {
    const calls: Array<{ url: string; body: string | null }> = [];

    globalThis.fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : null,
      });

      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        args?: { credentialId?: string };
      };
      if (parsed.args?.credentialId === "cred_conflict") {
        return new Response(
          JSON.stringify({
            status: "success",
            value: {
              applied: false,
              reason: "stale_or_duplicate",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          status: "success",
          value: {
            applied: true,
            reason: "updated",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new AccountSyncClient({
      backendUrl: "https://convex.reins.ai/",
      authToken: createJwt("clerk_sync_user"),
      deviceId: "device-a",
    });

    const result = await client.pushCredentials([
      createCredential(),
      createCredential({ id: "cred_conflict", sync: { version: 2, checksum: "checksum-2", updatedAt: 40 } }),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.pushed).toBe(1);
    expect(result.value.conflicts).toEqual(["cred_conflict"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://convex.reins.ai/api/mutation");
  });

  test("pulls credentials using clerk id from auth token", async () => {
    let capturedBody = "";

    globalThis.fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          status: "success",
          value: [createCredential()],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new AccountSyncClient({
      backendUrl: "https://convex.reins.ai",
      authToken: createJwt("clerk_sync_user"),
      deviceId: "device-a",
    });

    const pulled = await client.pullCredentials();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) {
      return;
    }

    expect(pulled.value).toHaveLength(1);
    expect(JSON.parse(capturedBody)).toEqual({
      path: "credential-sync:getCredentials",
      args: {
        clerkId: "clerk_sync_user",
      },
    });
  });

  test("retries transient failures before succeeding", async () => {
    let attempts = 0;

    globalThis.fetch = async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response(JSON.stringify({ errorMessage: "temporary" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ status: "success", value: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new AccountSyncClient({
      backendUrl: "https://convex.reins.ai",
      authToken: createJwt("clerk_sync_user"),
      deviceId: "device-a",
    });

    const pushed = await client.pushBillingSnapshot({
      gatewayKeyPrefix: "rk_live_",
      balanceCents: 1200,
      autoReloadEnabled: true,
      autoReloadThresholdCents: 300,
      autoReloadAmountCents: 1500,
      recentTransactionCount: 2,
      checksum: "billing-1",
    });

    expect(pushed.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  test("returns sync error on network failures", async () => {
    globalThis.fetch = async () => {
      throw new Error("offline");
    };

    const client = new AccountSyncClient({
      backendUrl: "https://convex.reins.ai",
      authToken: createJwt("clerk_sync_user"),
      deviceId: "device-a",
    });

    const result = await client.pullBillingSnapshot();
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.name).toBe("SyncError");
    expect(result.error.message).toContain("Network");
  });
});

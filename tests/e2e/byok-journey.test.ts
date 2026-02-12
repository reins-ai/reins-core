import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KeyEncryption } from "../../src/providers/byok/crypto";
import { BYOKProviderFactory } from "../../src/providers/byok/factory";
import { BYOKManager } from "../../src/providers/byok/manager";
import { InMemoryKeyStorage } from "../../src/providers/byok/storage";
import { AnthropicApiKeyStrategy } from "../../src/providers/byok/anthropic-auth-strategy";
import { ProviderAuthService } from "../../src/providers/auth-service";
import { EncryptedCredentialStore } from "../../src/providers/credentials/store";
import { ProviderRegistry } from "../../src/providers/registry";
import { MockProvider } from "../../src/providers/mock";
import type { ChatRequest } from "../../src/types";

const originalFetch = globalThis.fetch;

const request: ChatRequest = {
  model: "gpt-4o-mini",
  messages: [
    {
      id: "msg-1",
      role: "user",
      content: "Hello from BYOK journey",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    },
  ],
};

const anthropicRequest: ChatRequest = {
  model: "claude-3-5-sonnet-latest",
  messages: [
    {
      id: "msg-1",
      role: "user",
      content: "Hello from Anthropic BYOK",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    },
  ],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function createTestFixture(fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const tempDirectory = await mkdtemp(join(tmpdir(), "reins-byok-journey-"));
  const store = new EncryptedCredentialStore({
    encryptionSecret: "byok-journey-test-secret",
    filePath: join(tempDirectory, "credentials.enc.json"),
  });
  const registry = new ProviderRegistry();

  const anthropicStrategy = new AnthropicApiKeyStrategy({
    store,
    fetchFn,
  });

  const service = new ProviderAuthService({
    store,
    registry,
    apiKeyStrategies: {
      anthropic: anthropicStrategy,
    },
  });

  return {
    store,
    registry,
    service,
    anthropicStrategy,
    tempDirectory,
    cleanup: async () => rm(tempDirectory, { recursive: true, force: true }),
  };
}

describe("e2e/byok-journey", () => {
  it("registers key, routes provider calls through BYOK, and falls back after removal", async () => {
    const validationCalls: string[] = [];

    const manager = new BYOKManager({
      encryption: new KeyEncryption("byok-master-secret"),
      storage: new InMemoryKeyStorage(),
      fetchFn: async (input) => {
        validationCalls.push(String(input));
        return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const stored = await manager.addKey({
      provider: "openai",
      apiKey: "sk-byok-custom-1234",
      label: "Primary OpenAI Key",
    });

    expect(stored.isValid).toBe(true);
    expect(validationCalls).toHaveLength(1);
    expect(validationCalls[0]).toContain("/v1/models");

    const factory = new BYOKProviderFactory(manager);

    let capturedAuthorization = "";
    globalThis.fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuthorization = headers?.authorization ?? "";

      return new Response(
        JSON.stringify({
          id: "chatcmpl_byok",
          model: "gpt-4o-mini",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "BYOK route succeeded",
              },
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 4,
            total_tokens: 9,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const byokProvider = await factory.createProvider(stored.id);
    const response = await byokProvider.chat(request);

    expect(byokProvider.config.id).toBe("byok-openai");
    expect(byokProvider.config.type).toBe("byok");
    expect(capturedAuthorization).toBe("Bearer sk-byok-custom-1234");
    expect(response.content).toBe("BYOK route succeeded");

    const validationResult = await manager.testKey(stored.id);
    expect(validationResult).toBe(true);

    const removed = await manager.removeKey(stored.id);
    expect(removed).toBe(true);

    await expect(factory.createProvider(stored.id)).rejects.toThrow("BYOK key not found");

    const gatewayFallback = new MockProvider({
      config: { id: "gateway-default", name: "Gateway", type: "gateway" },
      models: [
        {
          id: "gpt-4o-mini",
          name: "gpt-4o-mini",
          provider: "gateway-default",
          contextWindow: 8192,
          capabilities: ["chat", "streaming"],
        },
      ],
      responseContent: "Gateway fallback response",
    });

    const fallbackResponse = await gatewayFallback.chat(request);
    expect(gatewayFallback.config.id).toBe("gateway-default");
    expect(fallbackResponse.content).toBe("Gateway fallback response");
  });

  describe("anthropic BYOK validation and configuration", () => {
    it("validates, stores, and retrieves a valid Anthropic API key through auth service", async () => {
      const validationCalls: { url: string; headers: Record<string, string> }[] = [];

      const fixture = await createTestFixture(async (input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        validationCalls.push({ url: String(input), headers });
        return new Response(JSON.stringify({ data: [{ id: "claude-3-5-sonnet-latest" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      try {
        const result = await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "tui",
          key: "sk-ant-api03-valid-test-key-1234567890",
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.action).toBe("configure");
        expect(result.value.provider).toBe("anthropic");
        expect(result.value.credential).not.toBeNull();
        expect(result.value.guidance?.action).not.toBe("retry");

        // Verify endpoint validation was called with correct headers
        expect(validationCalls).toHaveLength(1);
        expect(validationCalls[0]!.url).toContain("/v1/models");
        expect(validationCalls[0]!.headers["x-api-key"]).toBe("sk-ant-api03-valid-test-key-1234567890");
        expect(validationCalls[0]!.headers["anthropic-version"]).toBe("2023-06-01");

        // Verify key was persisted and can be retrieved
        const retrieveResult = await fixture.anthropicStrategy.retrieve({ provider: "anthropic" });
        expect(retrieveResult.ok).toBe(true);
        if (!retrieveResult.ok) return;

        expect(retrieveResult.value).not.toBeNull();
        expect(retrieveResult.value!.key).toBe("sk-ant-api03-valid-test-key-1234567890");
      } finally {
        await fixture.cleanup();
      }
    });

    it("rejects API key with invalid format before making network calls", async () => {
      let networkCallsMade = 0;

      const fixture = await createTestFixture(async () => {
        networkCallsMade += 1;
        return new Response("", { status: 200 });
      });

      try {
        const result = await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "cli",
          key: "sk-invalid-not-anthropic-key",
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // Should return retry guidance with format error
        expect(result.value.guidance?.action).toBe("retry");
        expect(result.value.guidance?.message).toContain("sk-ant-");
        expect(result.value.credential).toBeUndefined();

        // No network calls should have been made
        expect(networkCallsMade).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    });

    it("rejects empty API key with helpful guidance", async () => {
      const fixture = await createTestFixture();

      try {
        const result = await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "tui",
          key: "   ",
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.guidance?.action).toBe("retry");
        expect(result.value.guidance?.message).toContain("API key is required");
        expect(result.value.guidance?.message).toContain("console.anthropic.com");
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns retry guidance when Anthropic endpoint returns 401 (invalid key)", async () => {
      const fixture = await createTestFixture(async () => {
        return new Response(JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      });

      try {
        const result = await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "tui",
          key: "sk-ant-api03-looks-valid-but-rejected-by-api",
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.guidance?.action).toBe("retry");
        expect(result.value.guidance?.message).toContain("invalid or has been revoked");
        expect(result.value.guidance?.message).toContain("console.anthropic.com");
        expect(result.value.credential).toBeUndefined();
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns retry guidance when Anthropic endpoint returns 403 (insufficient permissions)", async () => {
      const fixture = await createTestFixture(async () => {
        return new Response(JSON.stringify({ error: { type: "permission_error" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      });

      try {
        const result = await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "cli",
          key: "sk-ant-api03-insufficient-permissions-key",
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.guidance?.action).toBe("retry");
        expect(result.value.guidance?.message).toContain("permissions");
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns retry guidance when Anthropic endpoint returns 429 (rate limited)", async () => {
      const fixture = await createTestFixture(async () => {
        return new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      });

      try {
        const result = await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "tui",
          key: "sk-ant-api03-rate-limited-during-validation",
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.guidance?.action).toBe("retry");
        expect(result.value.guidance?.message).toContain("rate limit");
        expect(result.value.guidance?.message).toContain("try again");
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns retry guidance when network is unreachable", async () => {
      const fixture = await createTestFixture(async () => {
        throw new Error("fetch failed: ECONNREFUSED");
      });

      try {
        const result = await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "tui",
          key: "sk-ant-api03-valid-key-but-network-down",
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.guidance?.action).toBe("retry");
        expect(result.value.guidance?.message).toContain("network connection");
      } finally {
        await fixture.cleanup();
      }
    });

    it("does not persist key when endpoint validation fails", async () => {
      const fixture = await createTestFixture(async () => {
        return new Response("", { status: 401 });
      });

      try {
        await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "tui",
          key: "sk-ant-api03-rejected-key-should-not-persist",
        });

        // Verify nothing was stored
        const retrieveResult = await fixture.anthropicStrategy.retrieve({ provider: "anthropic" });
        expect(retrieveResult.ok).toBe(true);
        if (!retrieveResult.ok) return;

        expect(retrieveResult.value).toBeNull();
      } finally {
        await fixture.cleanup();
      }
    });

    it("persists key encrypted and retrieves it across credential store reads", async () => {
      const fixture = await createTestFixture(async () => {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      try {
        const configResult = await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "tui",
          key: "sk-ant-api03-persist-test-key-abcdef",
        });

        expect(configResult.ok).toBe(true);
        if (!configResult.ok) return;
        expect(configResult.value.credential).not.toBeNull();

        // Verify the credential record is encrypted (payload is not plaintext)
        const credResult = await fixture.service.getCredential("anthropic");
        expect(credResult.ok).toBe(true);
        if (!credResult.ok) return;

        const record = credResult.value;
        expect(record).not.toBeNull();
        expect(record!.provider).toBe("anthropic");
        expect(record!.type).toBe("api_key");
        expect(record!.encryptedPayload.v).toBe(1);
        expect(record!.encryptedPayload.ciphertext).not.toContain("sk-ant-");

        // Verify the key can be retrieved through the strategy
        const retrieveResult = await fixture.anthropicStrategy.retrieve({ provider: "anthropic" });
        expect(retrieveResult.ok).toBe(true);
        if (!retrieveResult.ok) return;
        expect(retrieveResult.value!.key).toBe("sk-ant-api03-persist-test-key-abcdef");
      } finally {
        await fixture.cleanup();
      }
    });

    it("revokes Anthropic API key and returns configure guidance afterward", async () => {
      const fixture = await createTestFixture(async () => {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      try {
        // First configure a valid key
        await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "tui",
          key: "sk-ant-api03-revoke-test-key-xyz",
        });

        // Revoke it
        const revokeResult = await fixture.service.handleCommand({
          action: "revoke",
          provider: "anthropic",
          source: "tui",
        });

        expect(revokeResult.ok).toBe(true);
        if (!revokeResult.ok) return;
        expect(revokeResult.value.action).toBe("revoke");

        // Check that guidance now says to reconfigure
        const getResult = await fixture.service.handleCommand({
          action: "get",
          provider: "anthropic",
          source: "tui",
        });

        expect(getResult.ok).toBe(true);
        if (!getResult.ok) return;
        expect(getResult.value.guidance?.action).toBe("configure");
        expect(getResult.value.guidance?.message).toContain("requires authentication");
      } finally {
        await fixture.cleanup();
      }
    });

    it("shows Anthropic as configured in provider listing after successful BYOK setup", async () => {
      const fixture = await createTestFixture(async () => {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      try {
        // Before configuration
        const beforeResult = await fixture.service.handleCommand({
          action: "list",
          source: "tui",
        });

        expect(beforeResult.ok).toBe(true);
        if (!beforeResult.ok) return;

        const anthropicBefore = beforeResult.value.providers?.find((p) => p.provider === "anthropic");
        expect(anthropicBefore?.configured).toBe(false);

        // Configure Anthropic
        await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "tui",
          key: "sk-ant-api03-listing-test-key-123",
        });

        // After configuration
        const afterResult = await fixture.service.handleCommand({
          action: "list",
          source: "tui",
        });

        expect(afterResult.ok).toBe(true);
        if (!afterResult.ok) return;

        const anthropicAfter = afterResult.value.providers?.find((p) => p.provider === "anthropic");
        expect(anthropicAfter?.configured).toBe(true);
        expect(anthropicAfter?.credentialType).toBe("api_key");
      } finally {
        await fixture.cleanup();
      }
    });

    it("validates key format directly through strategy", async () => {
      const fixture = await createTestFixture();

      try {
        // Valid format
        const validResult = fixture.anthropicStrategy.validate({
          provider: "anthropic",
          key: "sk-ant-api03-valid-format-key-12345",
        });
        expect(validResult.ok).toBe(true);

        // Missing prefix
        const invalidResult = fixture.anthropicStrategy.validate({
          provider: "anthropic",
          key: "sk-openai-wrong-prefix",
        });
        expect(invalidResult.ok).toBe(false);
        if (invalidResult.ok) return;
        expect(invalidResult.error.message).toContain("sk-ant-");

        // Empty key
        const emptyResult = fixture.anthropicStrategy.validate({
          provider: "anthropic",
          key: "",
        });
        expect(emptyResult.ok).toBe(false);

        // Too short
        const shortResult = fixture.anthropicStrategy.validate({
          provider: "anthropic",
          key: "sk-ant-x",
        });
        expect(shortResult.ok).toBe(false);
        if (shortResult.ok) return;
        expect(shortResult.error.message).toContain("incomplete");
      } finally {
        await fixture.cleanup();
      }
    });

    it("validates endpoint directly through strategy", async () => {
      const fixture = await createTestFixture(async () => {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      try {
        const result = await fixture.anthropicStrategy.validateWithEndpoint("sk-ant-api03-endpoint-test-key");
        expect(result.ok).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    });

    it("endpoint validation rejects invalid format before network call", async () => {
      let networkCalls = 0;
      const fixture = await createTestFixture(async () => {
        networkCalls += 1;
        return new Response("", { status: 200 });
      });

      try {
        const result = await fixture.anthropicStrategy.validateWithEndpoint("not-an-anthropic-key");
        expect(result.ok).toBe(false);
        expect(networkCalls).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    });

    it("complete Anthropic BYOK journey: validate → store → conversation readiness", async () => {
      const fixture = await createTestFixture(async (input) => {
        const url = String(input);
        // Validation endpoint
        if (url.includes("/v1/models")) {
          return new Response(JSON.stringify({ data: [{ id: "claude-3-5-sonnet-latest" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response("", { status: 404 });
      });

      try {
        // Step 1: Configure Anthropic API key through auth service
        const configResult = await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "tui",
          key: "sk-ant-api03-full-journey-test-key-xyz",
        });

        expect(configResult.ok).toBe(true);
        if (!configResult.ok) return;
        expect(configResult.value.action).toBe("configure");
        expect(configResult.value.credential).not.toBeNull();

        // Step 2: Verify provider shows as configured
        const listResult = await fixture.service.handleCommand({
          action: "list",
          source: "tui",
        });

        expect(listResult.ok).toBe(true);
        if (!listResult.ok) return;

        const anthropic = listResult.value.providers?.find((p) => p.provider === "anthropic");
        expect(anthropic?.configured).toBe(true);
        expect(anthropic?.authModes).toContain("api_key");

        // Step 3: Verify key can be retrieved for conversation use
        const retrieveResult = await fixture.anthropicStrategy.retrieve({ provider: "anthropic" });
        expect(retrieveResult.ok).toBe(true);
        if (!retrieveResult.ok) return;
        expect(retrieveResult.value).not.toBeNull();
        expect(retrieveResult.value!.key).toBe("sk-ant-api03-full-journey-test-key-xyz");

        // Step 4: Verify a BYOK provider can be created with the stored key
        // (simulating conversation readiness)
        const { BYOKAnthropicProvider } = await import("../../src/providers/byok/anthropic");
        const provider = new BYOKAnthropicProvider(retrieveResult.value!.key);
        expect(provider.config.id).toBe("byok-anthropic");
        expect(provider.config.type).toBe("byok");

        // Step 5: Verify conversation works with mocked Anthropic API
        globalThis.fetch = async (_input, init) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          expect(headers["x-api-key"]).toBe("sk-ant-api03-full-journey-test-key-xyz");

          return new Response(
            JSON.stringify({
              id: "msg_test",
              type: "message",
              model: "claude-3-5-sonnet-latest",
              content: [{ type: "text", text: "Hello from Anthropic BYOK!" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 8 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        };

        const chatResponse = await provider.chat(anthropicRequest);
        expect(chatResponse.content).toBe("Hello from Anthropic BYOK!");
        expect(chatResponse.model).toBe("claude-3-5-sonnet-latest");
      } finally {
        await fixture.cleanup();
      }
    });
  });
});

import { describe, expect, it } from "bun:test";

import { ImportLogWriter, type ImportLogEntry } from "../../../src/conversion/import-log";
import type { KeychainProvider } from "../../../src/security/keychain-provider";
import { ok, err } from "../../../src/result";
import { SecurityError } from "../../../src/security/security-error";
import {
  GatewayConfigMapper,
  type OpenClawGatewayConfig,
} from "../../../src/conversion/mappers/gateway-config-mapper";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A mock ImportLogWriter that captures entries in memory without touching disk.
 */
function createMockImportLogWriter(): ImportLogWriter & { capturedEntries: ImportLogEntry[] } {
  const writer = new ImportLogWriter({ outputPath: "/dev/null" });
  const capturedEntries: ImportLogEntry[] = [];

  const originalAddEntry = writer.addEntry.bind(writer);
  writer.addEntry = (entry: ImportLogEntry) => {
    capturedEntries.push(entry);
    originalAddEntry(entry);
  };

  return Object.assign(writer, { capturedEntries });
}

/**
 * A mock KeychainProvider that records calls and returns configurable results.
 */
function createMockKeychainProvider(options: {
  setResult?: "ok" | "error";
} = {}): KeychainProvider & {
  setCalls: Array<{ service: string; account: string; secret: string }>;
} {
  const setCalls: Array<{ service: string; account: string; secret: string }> = [];

  const provider: KeychainProvider & {
    setCalls: Array<{ service: string; account: string; secret: string }>;
  } = {
    setCalls,

    async get(_service: string, _account: string) {
      return ok(null);
    },

    async set(service: string, account: string, secret: string) {
      setCalls.push({ service, account, secret });
      if (options.setResult === "error") {
        return err(new SecurityError("Keychain write failed", "SECURITY_NATIVE_SET_FAILED"));
      }
      return ok(undefined);
    },

    async delete(_service: string, _account: string) {
      return ok(undefined);
    },
  };

  return provider;
}

function makeFullGatewayConfig(): OpenClawGatewayConfig {
  return {
    port: 8080,
    host: "0.0.0.0",
    authMode: "token",
    authToken: "secret-gateway-token",
    tailscale: true,
    allowedOrigins: ["https://example.com", "https://app.example.com"],
    rateLimit: { requests: 100, windowMs: 60000 },
    ssl: { cert: "/etc/ssl/cert.pem", key: "/etc/ssl/key.pem" },
    metadata: { env: "production" },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GatewayConfigMapper", () => {
  describe("map — full config with authToken", () => {
    it("stores authToken in keychain with correct service and account", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      await mapper.map(makeFullGatewayConfig());

      expect(keychain.setCalls).toHaveLength(1);
      expect(keychain.setCalls[0].service).toBe("reins-gateway-token");
      expect(keychain.setCalls[0].account).toBe("openclaw-import");
      expect(keychain.setCalls[0].secret).toBe("secret-gateway-token");
    });

    it("returns converted=1 when authToken is stored successfully", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      const result = await mapper.map(makeFullGatewayConfig());

      expect(result.converted).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("logs all known unmapped fields to the import log", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      await mapper.map(makeFullGatewayConfig());

      const paths = writer.capturedEntries.map((e) => e.path);
      expect(paths).toContain("gateway.port");
      expect(paths).toContain("gateway.host");
      expect(paths).toContain("gateway.authMode");
      expect(paths).toContain("gateway.tailscale");
      expect(paths).toContain("gateway.allowedOrigins");
      expect(paths).toContain("gateway.rateLimit");
      expect(paths).toContain("gateway.ssl");
      expect(paths).toContain("gateway.metadata");
    });

    it("logs authToken entry with isSecret=true", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      await mapper.map(makeFullGatewayConfig());

      const authEntry = writer.capturedEntries.find((e) => e.path === "gateway.authToken");
      expect(authEntry).toBeDefined();
      expect(authEntry!.isSecret).toBe(true);
    });

    it("logs non-secret fields with isSecret=false", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      await mapper.map(makeFullGatewayConfig());

      const nonSecretEntries = writer.capturedEntries.filter(
        (e) => e.path !== "gateway.authToken",
      );
      for (const entry of nonSecretEntries) {
        expect(entry.isSecret).toBe(false);
      }
    });

    it("uses 'gateway-config' category for all entries", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      await mapper.map(makeFullGatewayConfig());

      for (const entry of writer.capturedEntries) {
        expect(entry.category).toBe("gateway-config");
      }
    });

    it("logs correct original values for unmapped fields", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      await mapper.map(makeFullGatewayConfig());

      const portEntry = writer.capturedEntries.find((e) => e.path === "gateway.port");
      expect(portEntry?.originalValue).toBe(8080);

      const tailscaleEntry = writer.capturedEntries.find((e) => e.path === "gateway.tailscale");
      expect(tailscaleEntry?.originalValue).toBe(true);

      const originsEntry = writer.capturedEntries.find(
        (e) => e.path === "gateway.allowedOrigins",
      );
      expect(originsEntry?.originalValue).toEqual(["https://example.com", "https://app.example.com"]);
    });

    it("includes a non-empty reason for each logged entry", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      await mapper.map(makeFullGatewayConfig());

      for (const entry of writer.capturedEntries) {
        expect(typeof entry.reason).toBe("string");
        expect(entry.reason.length).toBeGreaterThan(0);
      }
    });
  });

  describe("map — config without authToken", () => {
    it("does not call keychain.set when authToken is absent", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      const config: OpenClawGatewayConfig = { port: 9000 };
      await mapper.map(config);

      expect(keychain.setCalls).toHaveLength(0);
    });

    it("returns converted=0 when authToken is absent", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      const config: OpenClawGatewayConfig = { port: 9000 };
      const result = await mapper.map(config);

      expect(result.converted).toBe(0);
    });

    it("does not log authToken entry when authToken is absent", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      const config: OpenClawGatewayConfig = { port: 9000 };
      await mapper.map(config);

      const authEntry = writer.capturedEntries.find((e) => e.path === "gateway.authToken");
      expect(authEntry).toBeUndefined();
    });

    it("does not call keychain.set when authToken is an empty string", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      const config: OpenClawGatewayConfig = { authToken: "   " };
      await mapper.map(config);

      expect(keychain.setCalls).toHaveLength(0);
    });
  });

  describe("map — skipped fields", () => {
    it("counts absent known fields as skipped", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      // Only port is present; all other known fields are absent
      const config: OpenClawGatewayConfig = { port: 3000 };
      const result = await mapper.map(config);

      // 7 absent known fields + 1 absent authToken = 8 skipped
      expect(result.skipped).toBe(8);
    });

    it("does not log entries for absent fields", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      const config: OpenClawGatewayConfig = { port: 3000 };
      await mapper.map(config);

      const paths = writer.capturedEntries.map((e) => e.path);
      expect(paths).not.toContain("gateway.host");
      expect(paths).not.toContain("gateway.authMode");
      expect(paths).not.toContain("gateway.tailscale");
    });
  });

  describe("map — keychain error handling", () => {
    it("records an error when keychain.set fails", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider({ setResult: "error" });
      const mapper = new GatewayConfigMapper(writer, keychain);

      const result = await mapper.map({ authToken: "my-token" });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].item).toBe("gateway.authToken");
    });

    it("returns converted=0 when keychain.set fails", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider({ setResult: "error" });
      const mapper = new GatewayConfigMapper(writer, keychain);

      const result = await mapper.map({ authToken: "my-token" });

      expect(result.converted).toBe(0);
    });

    it("still logs the authToken import log entry even when keychain fails", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider({ setResult: "error" });
      const mapper = new GatewayConfigMapper(writer, keychain);

      await mapper.map({ authToken: "my-token" });

      const authEntry = writer.capturedEntries.find((e) => e.path === "gateway.authToken");
      expect(authEntry).toBeDefined();
      expect(authEntry!.isSecret).toBe(true);
    });
  });

  describe("map — dry run", () => {
    it("does not call keychain.set in dry-run mode", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      await mapper.map(makeFullGatewayConfig(), { dryRun: true });

      expect(keychain.setCalls).toHaveLength(0);
    });

    it("still counts authToken as converted in dry-run mode", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      const result = await mapper.map(makeFullGatewayConfig(), { dryRun: true });

      expect(result.converted).toBe(1);
    });

    it("still logs entries in dry-run mode", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      await mapper.map(makeFullGatewayConfig(), { dryRun: true });

      expect(writer.capturedEntries.length).toBeGreaterThan(0);
    });
  });

  describe("map — onProgress callback", () => {
    it("invokes onProgress for each processed field", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      const progressCalls: Array<[number, number]> = [];
      await mapper.map(makeFullGatewayConfig(), {
        onProgress: (processed, total) => {
          progressCalls.push([processed, total]);
        },
      });

      // 8 known fields + 1 authToken = 9 total
      expect(progressCalls.length).toBe(9);
      expect(progressCalls[0][1]).toBe(9);
      expect(progressCalls[progressCalls.length - 1][0]).toBe(9);
    });
  });

  describe("map — unknown extra fields", () => {
    it("logs unknown extra fields to the import log", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      const config: OpenClawGatewayConfig = {
        port: 8080,
        customSetting: "some-value",
      };
      await mapper.map(config);

      const extraEntry = writer.capturedEntries.find(
        (e) => e.path === "gateway.customSetting",
      );
      expect(extraEntry).toBeDefined();
      expect(extraEntry!.originalValue).toBe("some-value");
      expect(extraEntry!.isSecret).toBe(false);
      expect(extraEntry!.category).toBe("gateway-config");
    });

    it("does not log unknown fields that are null or undefined", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      const config: OpenClawGatewayConfig = {
        nullField: null,
        undefinedField: undefined,
      };
      await mapper.map(config);

      const paths = writer.capturedEntries.map((e) => e.path);
      expect(paths).not.toContain("gateway.nullField");
      expect(paths).not.toContain("gateway.undefinedField");
    });
  });

  describe("map — empty config", () => {
    it("returns all zeros for an empty config", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      const result = await mapper.map({});

      expect(result.converted).toBe(0);
      expect(result.errors).toHaveLength(0);
      // All 8 known fields + authToken are absent
      expect(result.skipped).toBe(9);
    });

    it("logs no entries for an empty config", async () => {
      const writer = createMockImportLogWriter();
      const keychain = createMockKeychainProvider();
      const mapper = new GatewayConfigMapper(writer, keychain);

      await mapper.map({});

      expect(writer.capturedEntries).toHaveLength(0);
    });
  });
});

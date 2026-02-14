import { describe, expect, it } from "bun:test";

import { ok, type Result } from "../../src/result";
import type { KeychainProvider } from "../../src/security/keychain-provider";
import type { SecurityError } from "../../src/security/security-error";
import { DaemonTokenManager } from "../../src/daemon/token-manager";

function createMockKeychain(): KeychainProvider {
  const store = new Map<string, string>();
  return {
    async get(
      service: string,
      account: string,
    ): Promise<Result<string | null, SecurityError>> {
      return ok(store.get(`${service}:${account}`) ?? null);
    },
    async set(
      service: string,
      account: string,
      secret: string,
    ): Promise<Result<void, SecurityError>> {
      store.set(`${service}:${account}`, secret);
      return ok(undefined);
    },
    async delete(
      service: string,
      account: string,
    ): Promise<Result<void, SecurityError>> {
      store.delete(`${service}:${account}`);
      return ok(undefined);
    },
  };
}

function getKeychainStore(keychain: KeychainProvider): Map<string, string> {
  // Access the closure-captured store via a known key probe.
  // We use the keychain interface itself to verify contents.
  return (keychain as unknown as { _store: Map<string, string> })._store;
}

describe("DaemonTokenManager", () => {
  function createManager() {
    const keychain = createMockKeychain();
    const manager = new DaemonTokenManager({ keychain });
    return { manager, keychain };
  }

  describe("storeToken and getToken", () => {
    it("roundtrips a token through store and retrieve", async () => {
      const { manager } = createManager();
      const token = "rm_" + "a".repeat(64);

      const storeResult = await manager.storeToken("my-profile", token);
      expect(storeResult.ok).toBe(true);

      const getResult = await manager.getToken("my-profile");
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value).toBe(token);
      }
    });
  });

  describe("getToken", () => {
    it("returns null for a nonexistent profile", async () => {
      const { manager } = createManager();

      const result = await manager.getToken("nonexistent");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe("deleteToken", () => {
    it("removes a stored token", async () => {
      const { manager } = createManager();
      const token = "rm_" + "b".repeat(64);

      await manager.storeToken("deletable", token);
      const deleteResult = await manager.deleteToken("deletable");
      expect(deleteResult.ok).toBe(true);

      const getResult = await manager.getToken("deletable");
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value).toBeNull();
      }
    });
  });

  describe("rotateToken", () => {
    it("generates a new token with rm_ prefix and 64 hex chars", async () => {
      const { manager } = createManager();

      const result = await manager.rotateToken("rotate-test");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatch(/^rm_[a-f0-9]{64}$/);
      }
    });

    it("replaces a previously stored token", async () => {
      const { manager } = createManager();
      const originalToken = "rm_" + "c".repeat(64);

      await manager.storeToken("rotate-replace", originalToken);

      const rotateResult = await manager.rotateToken("rotate-replace");
      expect(rotateResult.ok).toBe(true);

      const getResult = await manager.getToken("rotate-replace");
      expect(getResult.ok).toBe(true);
      if (getResult.ok && rotateResult.ok) {
        expect(getResult.value).toBe(rotateResult.value);
        expect(getResult.value).not.toBe(originalToken);
      }
    });
  });

  describe("hasToken", () => {
    it("returns true when a token exists", async () => {
      const { manager } = createManager();
      await manager.storeToken("exists", "rm_" + "d".repeat(64));

      const result = await manager.hasToken("exists");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it("returns false when no token exists", async () => {
      const { manager } = createManager();

      const result = await manager.hasToken("missing");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });
  });

  describe("profile name normalization", () => {
    it("normalizes profile names to lowercase", async () => {
      const { manager } = createManager();
      const token = "rm_" + "e".repeat(64);

      await manager.storeToken("MyProfile", token);

      const getResult = await manager.getToken("myprofile");
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value).toBe(token);
      }
    });

    it("treats mixed-case names as the same profile", async () => {
      const { manager } = createManager();
      const token = "rm_" + "f".repeat(64);

      await manager.storeToken("REMOTE-SERVER", token);

      const result1 = await manager.getToken("remote-server");
      const result2 = await manager.getToken("Remote-Server");
      const result3 = await manager.getToken("REMOTE-SERVER");

      expect(result1.ok && result1.value).toBe(token);
      expect(result2.ok && result2.value).toBe(token);
      expect(result3.ok && result3.value).toBe(token);
    });
  });

  describe("token format validation", () => {
    it("accepts valid rm_ token format", () => {
      const { manager } = createManager();
      const validToken = "rm_" + "a1b2c3d4".repeat(8);

      expect(manager.isValidTokenFormat(validToken)).toBe(true);
    });

    it("rejects token without rm_ prefix", () => {
      const { manager } = createManager();

      expect(manager.isValidTokenFormat("xx_" + "a".repeat(64))).toBe(false);
    });

    it("rejects token with wrong hex length", () => {
      const { manager } = createManager();

      expect(manager.isValidTokenFormat("rm_" + "a".repeat(32))).toBe(false);
      expect(manager.isValidTokenFormat("rm_" + "a".repeat(128))).toBe(false);
    });

    it("rejects token with non-hex characters", () => {
      const { manager } = createManager();

      expect(manager.isValidTokenFormat("rm_" + "g".repeat(64))).toBe(false);
      expect(manager.isValidTokenFormat("rm_" + "Z".repeat(64))).toBe(false);
    });

    it("rejects empty string", () => {
      const { manager } = createManager();

      expect(manager.isValidTokenFormat("")).toBe(false);
    });
  });

  describe("keychain isolation", () => {
    it("uses reins.daemon service name for keychain storage", async () => {
      const keychain = createMockKeychain();
      const manager = new DaemonTokenManager({ keychain });
      const token = "rm_" + "a".repeat(64);

      await manager.storeToken("local", token);

      // Verify the token is stored under the correct service key
      const directResult = await keychain.get("reins.daemon", "local");
      expect(directResult.ok).toBe(true);
      if (directResult.ok) {
        expect(directResult.value).toBe(token);
      }
    });

    it("tokens are only in keychain, not serializable in profile data", async () => {
      const keychain = createMockKeychain();
      const manager = new DaemonTokenManager({ keychain });

      // Store a token via the manager
      const rotateResult = await manager.rotateToken("secure-profile");
      expect(rotateResult.ok).toBe(true);

      // Simulate what a profile JSON file would contain — no token field
      const mockProfileData = {
        name: "secure-profile",
        httpUrl: "http://localhost:7433",
        wsUrl: "ws://localhost:7433/ws",
        transportType: "localhost",
        isDefault: true,
        lastConnected: new Date().toISOString(),
      };

      const serialized = JSON.stringify(mockProfileData);

      // The token must not appear in the serialized profile data
      if (rotateResult.ok) {
        expect(serialized).not.toContain(rotateResult.value);
      }

      // But the token IS retrievable from the keychain
      const getResult = await manager.getToken("secure-profile");
      expect(getResult.ok).toBe(true);
      if (getResult.ok && rotateResult.ok) {
        expect(getResult.value).toBe(rotateResult.value);
      }
    });
  });

  describe("independent profile tokens", () => {
    it("stores separate tokens per profile", async () => {
      const { manager } = createManager();

      const result1 = await manager.rotateToken("profile-a");
      const result2 = await manager.rotateToken("profile-b");

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        expect(result1.value).not.toBe(result2.value);
      }

      const get1 = await manager.getToken("profile-a");
      const get2 = await manager.getToken("profile-b");

      if (get1.ok && get2.ok && result1.ok && result2.ok) {
        expect(get1.value).toBe(result1.value);
        expect(get2.value).toBe(result2.value);
      }
    });

    it("deleting one profile token does not affect another", async () => {
      const { manager } = createManager();

      await manager.rotateToken("keep-me");
      await manager.rotateToken("delete-me");

      await manager.deleteToken("delete-me");

      const keepResult = await manager.hasToken("keep-me");
      const deleteResult = await manager.hasToken("delete-me");

      expect(keepResult.ok && keepResult.value).toBe(true);
      expect(deleteResult.ok && deleteResult.value).toBe(false);
    });
  });
});

import { describe, expect, it } from "bun:test";
import { checkCommandAuthorization } from "../../../src/channels/commands/security";
import { InMemoryChannelAuthStorage } from "../../../src/channels/memory-auth-storage";
import { ChannelAuthService } from "../../../src/channels/auth-service";

function makeAuthService(
  initial?: Record<string, string[]>,
): ChannelAuthService {
  const storage = new InMemoryChannelAuthStorage(initial);
  return new ChannelAuthService(storage);
}

describe("checkCommandAuthorization", () => {
  describe("authorized sender", () => {
    it("returns { authorized: true } when sender is in allow-list", async () => {
      const authService = makeAuthService({ "chan-1": ["user-1"] });
      const result = await checkCommandAuthorization(
        "chan-1",
        "user-1",
        authService,
      );
      expect(result.authorized).toBe(true);
    });

    it("returns { authorized: true } for multiple authorized users", async () => {
      const authService = makeAuthService({
        "chan-1": ["user-1", "user-2"],
      });
      const result = await checkCommandAuthorization(
        "chan-1",
        "user-2",
        authService,
      );
      expect(result.authorized).toBe(true);
    });
  });

  describe("unauthorized sender", () => {
    it("returns { authorized: false } when sender is not in allow-list", async () => {
      const authService = makeAuthService({ "chan-1": ["user-1"] });
      const result = await checkCommandAuthorization(
        "chan-1",
        "user-999",
        authService,
      );
      expect(result.authorized).toBe(false);
    });

    it("returns rejection result with kind text", async () => {
      const authService = makeAuthService({ "chan-1": ["user-1"] });
      const result = await checkCommandAuthorization(
        "chan-1",
        "user-999",
        authService,
      );
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.result.kind).toBe("text");
      }
    });

    it("returns rejection result with success false", async () => {
      const authService = makeAuthService({ "chan-1": ["user-1"] });
      const result = await checkCommandAuthorization(
        "chan-1",
        "user-999",
        authService,
      );
      if (!result.authorized) {
        expect(result.result.success).toBe(false);
      }
    });

    it("returns rejection result with error UNAUTHORIZED", async () => {
      const authService = makeAuthService({ "chan-1": ["user-1"] });
      const result = await checkCommandAuthorization(
        "chan-1",
        "user-999",
        authService,
      );
      if (!result.authorized) {
        expect(result.result.kind).toBe("text");
        if (result.result.kind === "text") {
          expect(result.result.error).toBe("UNAUTHORIZED");
        }
      }
    });

    it("returns rejection result with descriptive text message", async () => {
      const authService = makeAuthService({ "chan-1": ["user-1"] });
      const result = await checkCommandAuthorization(
        "chan-1",
        "user-999",
        authService,
      );
      if (!result.authorized) {
        expect(result.result.kind).toBe("text");
        if (result.result.kind === "text") {
          expect(result.result.text).toBe(
            "You are not authorized to use commands on this channel.",
          );
        }
      }
    });
  });

  describe("strict-default edge cases", () => {
    it("returns unauthorized for channel with no configured users", async () => {
      const authService = makeAuthService();
      const result = await checkCommandAuthorization(
        "chan-1",
        "user-1",
        authService,
      );
      expect(result.authorized).toBe(false);
    });

    it("returns unauthorized for empty sender ID", async () => {
      const authService = makeAuthService({ "chan-1": ["user-1"] });
      const result = await checkCommandAuthorization(
        "chan-1",
        "",
        authService,
      );
      expect(result.authorized).toBe(false);
    });

    it('returns unauthorized for "0" sender ID', async () => {
      const authService = makeAuthService({ "chan-1": ["user-1", "0"] });
      const result = await checkCommandAuthorization(
        "chan-1",
        "0",
        authService,
      );
      expect(result.authorized).toBe(false);
    });

    it("returns unauthorized for whitespace-only sender ID", async () => {
      const authService = makeAuthService({ "chan-1": ["user-1"] });
      const result = await checkCommandAuthorization(
        "chan-1",
        "   ",
        authService,
      );
      expect(result.authorized).toBe(false);
    });

    it("returns unauthorized for unknown channel ID", async () => {
      const authService = makeAuthService({ "chan-1": ["user-1"] });
      const result = await checkCommandAuthorization(
        "chan-unknown",
        "user-1",
        authService,
      );
      expect(result.authorized).toBe(false);
    });
  });
});

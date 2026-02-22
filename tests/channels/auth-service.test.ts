import { describe, expect, it } from "bun:test";
import { InMemoryChannelAuthStorage } from "../../src/channels/memory-auth-storage";
import { ChannelAuthService } from "../../src/channels/auth-service";

describe("ChannelAuthService", () => {
  function makeService(initial?: Record<string, string[]>): ChannelAuthService {
    const storage = new InMemoryChannelAuthStorage(initial);
    return new ChannelAuthService(storage);
  }

  describe("isAuthorized — strict default", () => {
    it("returns false for channel with no users", async () => {
      const service = makeService();
      expect(await service.isAuthorized("telegram", "user1")).toBe(false);
    });

    it("returns true for explicitly added user", async () => {
      const service = makeService({ telegram: ["user1"] });
      expect(await service.isAuthorized("telegram", "user1")).toBe(true);
    });

    it("returns false for user not in allow-list", async () => {
      const service = makeService({ telegram: ["user1"] });
      expect(await service.isAuthorized("telegram", "user2")).toBe(false);
    });
  });

  describe("isAuthorized — sender ID validation", () => {
    it("returns false for empty string senderId", async () => {
      const service = makeService({ telegram: [""] });
      expect(await service.isAuthorized("telegram", "")).toBe(false);
    });

    it("returns false for whitespace-only senderId", async () => {
      const service = makeService({ telegram: ["   "] });
      expect(await service.isAuthorized("telegram", "   ")).toBe(false);
    });

    it('returns false for "0" senderId', async () => {
      const service = makeService({ telegram: ["0"] });
      expect(await service.isAuthorized("telegram", "0")).toBe(false);
    });

    it("returns true for valid non-zero senderId in list", async () => {
      const service = makeService({ telegram: ["123456789"] });
      expect(await service.isAuthorized("telegram", "123456789")).toBe(true);
    });
  });

  describe("addUser / removeUser", () => {
    it("addUser adds user to allow-list", async () => {
      const service = makeService();
      await service.addUser("telegram", "user1");
      expect(await service.isAuthorized("telegram", "user1")).toBe(true);
    });

    it("addUser is idempotent for duplicate user", async () => {
      const service = makeService({ telegram: ["user1"] });
      await service.addUser("telegram", "user1");
      const users = await service.listUsers("telegram");
      expect(users).toEqual(["user1"]);
    });

    it("removeUser returns true when user existed", async () => {
      const service = makeService({ telegram: ["user1"] });
      expect(await service.removeUser("telegram", "user1")).toBe(true);
      expect(await service.isAuthorized("telegram", "user1")).toBe(false);
    });

    it("removeUser returns false when user did not exist", async () => {
      const service = makeService();
      expect(await service.removeUser("telegram", "ghost")).toBe(false);
    });
  });

  describe("listUsers / getAllChannelsData", () => {
    it("listUsers returns all users for channel", async () => {
      const service = makeService({ telegram: ["user1", "user2"] });
      expect(await service.listUsers("telegram")).toEqual(["user1", "user2"]);
    });

    it("listUsers returns empty array for unknown channel", async () => {
      const service = makeService();
      expect(await service.listUsers("unknown")).toEqual([]);
    });

    it("getAllChannelsData returns all channels", async () => {
      const service = makeService({ telegram: ["user1"], discord: ["user2"] });
      const data = await service.getAllChannelsData();
      expect(data["telegram"]).toEqual(["user1"]);
      expect(data["discord"]).toEqual(["user2"]);
    });

    it("getAllChannelsData returns empty object when no channels configured", async () => {
      const service = makeService();
      const data = await service.getAllChannelsData();
      expect(data).toEqual({});
    });
  });

  describe("platform agnosticism", () => {
    it("works with any string channelId", async () => {
      const service = makeService({ slack: ["user1"], "custom-bot": ["user2"] });
      expect(await service.isAuthorized("slack", "user1")).toBe(true);
      expect(await service.isAuthorized("custom-bot", "user2")).toBe(true);
    });

    it("isolates users across channels", async () => {
      const service = makeService({ telegram: ["user1"], discord: ["user2"] });
      expect(await service.isAuthorized("telegram", "user2")).toBe(false);
      expect(await service.isAuthorized("discord", "user1")).toBe(false);
    });
  });
});

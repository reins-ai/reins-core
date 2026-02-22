import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileChannelAuthStorage } from "../../src/channels/file-auth-storage";
import { InMemoryChannelAuthStorage } from "../../src/channels/memory-auth-storage";

// ---------------------------------------------------------------------------
// InMemoryChannelAuthStorage
// ---------------------------------------------------------------------------
describe("InMemoryChannelAuthStorage", () => {
  it("returns empty array for unknown channel", async () => {
    const storage = new InMemoryChannelAuthStorage();
    expect(await storage.getAuthorizedUsers("telegram")).toEqual([]);
  });

  it("adds a user and returns true for new user", async () => {
    const storage = new InMemoryChannelAuthStorage();
    const result = await storage.addUser("telegram", "user1");
    expect(result).toBe(true);
    expect(await storage.getAuthorizedUsers("telegram")).toEqual(["user1"]);
  });

  it("returns false when adding duplicate user", async () => {
    const storage = new InMemoryChannelAuthStorage();
    await storage.addUser("telegram", "user1");
    const result = await storage.addUser("telegram", "user1");
    expect(result).toBe(false);
    expect(await storage.getAuthorizedUsers("telegram")).toEqual([
      "user1",
    ]);
  });

  it("removes a user and returns true", async () => {
    const storage = new InMemoryChannelAuthStorage();
    await storage.addUser("telegram", "user1");
    const result = await storage.removeUser("telegram", "user1");
    expect(result).toBe(true);
    expect(await storage.getAuthorizedUsers("telegram")).toEqual([]);
  });

  it("returns false when removing non-existent user", async () => {
    const storage = new InMemoryChannelAuthStorage();
    const result = await storage.removeUser("telegram", "nonexistent");
    expect(result).toBe(false);
  });

  it("listUsers returns same result as getAuthorizedUsers", async () => {
    const storage = new InMemoryChannelAuthStorage();
    await storage.addUser("telegram", "user1");
    await storage.addUser("telegram", "user2");
    const listed = await storage.listUsers("telegram");
    const authorized = await storage.getAuthorizedUsers("telegram");
    expect(listed).toEqual(authorized);
  });

  it("isolates users per channel", async () => {
    const storage = new InMemoryChannelAuthStorage();
    await storage.addUser("telegram", "user1");
    await storage.addUser("discord", "user2");
    expect(await storage.getAuthorizedUsers("telegram")).toEqual(["user1"]);
    expect(await storage.getAuthorizedUsers("discord")).toEqual(["user2"]);
  });

  it("accepts optional initial data", async () => {
    const storage = new InMemoryChannelAuthStorage({
      telegram: ["user1", "user2"],
    });
    expect(await storage.getAuthorizedUsers("telegram")).toEqual([
      "user1",
      "user2",
    ]);
  });

  it("getAllData returns all channels", async () => {
    const storage = new InMemoryChannelAuthStorage();
    await storage.addUser("telegram", "user1");
    await storage.addUser("discord", "user2");
    const data = await storage.getAllData();
    expect(data["telegram"]).toEqual(["user1"]);
    expect(data["discord"]).toEqual(["user2"]);
  });

  it("uses plain string channelId — no platform enum dependency", async () => {
    const storage = new InMemoryChannelAuthStorage();
    await storage.addUser("slack", "user1");
    expect(await storage.getAuthorizedUsers("slack")).toEqual(["user1"]);
  });
});

// ---------------------------------------------------------------------------
// FileChannelAuthStorage
// ---------------------------------------------------------------------------
describe("FileChannelAuthStorage", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function createTempStorage(): Promise<{
    storage: FileChannelAuthStorage;
    filePath: string;
  }> {
    tempDir = await mkdtemp(join(tmpdir(), "reins-auth-test-"));
    const filePath = join(tempDir, "channel-users.json");
    const storage = new FileChannelAuthStorage(filePath);
    return { storage, filePath };
  }

  it("returns empty array for unknown channel (missing file)", async () => {
    const { storage } = await createTempStorage();
    expect(await storage.getAuthorizedUsers("telegram")).toEqual([]);
  });

  it("creates file on first addUser call", async () => {
    const { storage, filePath } = await createTempStorage();

    const existsBefore = await readFile(filePath, "utf8")
      .then(() => true)
      .catch(() => false);
    expect(existsBefore).toBe(false);

    await storage.addUser("telegram", "user1");

    const existsAfter = await readFile(filePath, "utf8")
      .then(() => true)
      .catch(() => false);
    expect(existsAfter).toBe(true);
  });

  it("data survives re-instantiation (persists across instances)", async () => {
    const { filePath } = await createTempStorage();

    const storage1 = new FileChannelAuthStorage(filePath);
    await storage1.addUser("telegram", "user1");

    const storage2 = new FileChannelAuthStorage(filePath);
    expect(await storage2.getAuthorizedUsers("telegram")).toEqual([
      "user1",
    ]);
  });

  it("returns true for newly added user, false for duplicate", async () => {
    const { storage } = await createTempStorage();
    expect(await storage.addUser("telegram", "user1")).toBe(true);
    expect(await storage.addUser("telegram", "user1")).toBe(false);
  });

  it("removes user correctly", async () => {
    const { storage } = await createTempStorage();
    await storage.addUser("telegram", "user1");
    expect(await storage.removeUser("telegram", "user1")).toBe(true);
    expect(await storage.getAuthorizedUsers("telegram")).toEqual([]);
  });

  it("returns false when removing non-existent user", async () => {
    const { storage } = await createTempStorage();
    expect(await storage.removeUser("telegram", "ghost")).toBe(false);
  });

  it("handles corrupt JSON gracefully (returns empty, no throw)", async () => {
    const { storage, filePath } = await createTempStorage();

    await writeFile(filePath, "{ this is not valid json", "utf8");

    const users = await storage.getAuthorizedUsers("telegram");
    expect(users).toEqual([]);
  });

  it("getAllData returns all channels from file", async () => {
    const { storage } = await createTempStorage();
    await storage.addUser("telegram", "user1");
    await storage.addUser("discord", "user2");
    const data = await storage.getAllData();
    expect(data["telegram"]).toEqual(["user1"]);
    expect(data["discord"]).toEqual(["user2"]);
  });

  it("uses plain string channelId — no platform enum required", async () => {
    const { storage } = await createTempStorage();
    await storage.addUser("slack", "user1");
    expect(await storage.getAuthorizedUsers("slack")).toEqual(["user1"]);
  });

  it("listUsers and getAuthorizedUsers return same result", async () => {
    const { storage } = await createTempStorage();
    await storage.addUser("telegram", "user1");
    const listed = await storage.listUsers("telegram");
    const authorized = await storage.getAuthorizedUsers("telegram");
    expect(listed).toEqual(authorized);
  });
});

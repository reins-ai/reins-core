import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DaemonProfileStore } from "../../src/daemon/profile-store";
import type { DaemonProfile } from "../../src/daemon/profile-types";

let tempDir: string;
let store: DaemonProfileStore;

function makeProfile(overrides: Partial<Omit<DaemonProfile, "createdAt" | "lastConnected">> = {}) {
  return {
    name: overrides.name ?? "local",
    httpUrl: overrides.httpUrl ?? "http://localhost:7433",
    wsUrl: overrides.wsUrl ?? "ws://localhost:7433",
    transportType: overrides.transportType ?? ("localhost" as const),
    isDefault: overrides.isDefault ?? false,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "reins-profile-store-"));
  store = new DaemonProfileStore({ dataRoot: tempDir });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("DaemonProfileStore", () => {
  describe("add", () => {
    it("adds a profile and retrieves it", async () => {
      const result = await store.add(makeProfile({ name: "local" }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.name).toBe("local");
      expect(result.value.httpUrl).toBe("http://localhost:7433");
      expect(result.value.wsUrl).toBe("ws://localhost:7433");
      expect(result.value.transportType).toBe("localhost");
      expect(result.value.lastConnected).toBeNull();
      expect(result.value.createdAt).toBeTruthy();

      const getResult = await store.get("local");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value?.name).toBe("local");
    });

    it("normalizes profile name to lowercase", async () => {
      const result = await store.add(makeProfile({ name: "My-Server" }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("my-server");

      const getResult = await store.get("MY-SERVER");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value?.name).toBe("my-server");
    });

    it("returns error for duplicate name", async () => {
      await store.add(makeProfile({ name: "local" }));
      const result = await store.add(makeProfile({ name: "local" }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("DAEMON_PROFILE_DUPLICATE");
    });

    it("returns error for duplicate name with different casing", async () => {
      await store.add(makeProfile({ name: "local" }));
      const result = await store.add(makeProfile({ name: "LOCAL" }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("DAEMON_PROFILE_DUPLICATE");
    });

    it("returns error for invalid profile name", async () => {
      const result = await store.add(makeProfile({ name: "my server!" }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("DAEMON_PROFILE_INVALID_NAME");
    });

    it("returns error for empty profile name", async () => {
      const result = await store.add(makeProfile({ name: "" }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("DAEMON_PROFILE_INVALID_NAME");
    });

    it("returns error for name starting with hyphen", async () => {
      const result = await store.add(makeProfile({ name: "-bad" }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("DAEMON_PROFILE_INVALID_NAME");
    });

    it("sets first profile as default automatically", async () => {
      const result = await store.add(makeProfile({ name: "first", isDefault: false }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.isDefault).toBe(true);
    });

    it("does not auto-default subsequent profiles", async () => {
      await store.add(makeProfile({ name: "first" }));
      const result = await store.add(makeProfile({ name: "second", isDefault: false }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.isDefault).toBe(false);
    });

    it("unsets previous default when adding a new default profile", async () => {
      await store.add(makeProfile({ name: "first", isDefault: true }));
      await store.add(makeProfile({ name: "second", isDefault: true }));

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;

      const first = listResult.value.find((p) => p.name === "first");
      const second = listResult.value.find((p) => p.name === "second");
      expect(first?.isDefault).toBe(false);
      expect(second?.isDefault).toBe(true);
    });
  });

  describe("get", () => {
    it("returns null for non-existent profile", async () => {
      const result = await store.get("nonexistent");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  describe("list", () => {
    it("returns empty array when no profiles exist", async () => {
      const result = await store.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });

    it("returns all profiles", async () => {
      await store.add(makeProfile({ name: "local" }));
      await store.add(makeProfile({ name: "remote", httpUrl: "http://10.0.0.5:7433" }));

      const result = await store.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value.map((p) => p.name)).toEqual(["local", "remote"]);
    });
  });

  describe("update", () => {
    it("updates profile fields", async () => {
      await store.add(makeProfile({ name: "local" }));

      const result = await store.update("local", {
        httpUrl: "http://localhost:8080",
        transportType: "direct",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.httpUrl).toBe("http://localhost:8080");
      expect(result.value.transportType).toBe("direct");
      expect(result.value.name).toBe("local");
    });

    it("preserves name and createdAt on update", async () => {
      const addResult = await store.add(makeProfile({ name: "local" }));
      if (!addResult.ok) return;
      const originalCreatedAt = addResult.value.createdAt;

      const result = await store.update("local", { httpUrl: "http://new:7433" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("local");
      expect(result.value.createdAt).toBe(originalCreatedAt);
    });

    it("returns error for non-existent profile", async () => {
      const result = await store.update("nonexistent", { httpUrl: "http://x:1" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("DAEMON_PROFILE_NOT_FOUND");
    });

    it("unsets previous default when updating a profile to default", async () => {
      await store.add(makeProfile({ name: "first", isDefault: true }));
      await store.add(makeProfile({ name: "second" }));

      await store.update("second", { isDefault: true });

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;

      const first = listResult.value.find((p) => p.name === "first");
      const second = listResult.value.find((p) => p.name === "second");
      expect(first?.isDefault).toBe(false);
      expect(second?.isDefault).toBe(true);
    });
  });

  describe("remove", () => {
    it("removes an existing profile", async () => {
      await store.add(makeProfile({ name: "local" }));
      const result = await store.remove("local");
      expect(result.ok).toBe(true);

      const getResult = await store.get("local");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).toBeNull();
    });

    it("returns error for non-existent profile", async () => {
      const result = await store.remove("nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("DAEMON_PROFILE_NOT_FOUND");
    });
  });

  describe("getDefault", () => {
    it("returns null when no profiles exist", async () => {
      const result = await store.getDefault();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it("returns the default profile", async () => {
      await store.add(makeProfile({ name: "first" }));
      await store.add(makeProfile({ name: "second" }));

      const result = await store.getDefault();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value?.name).toBe("first");
    });
  });

  describe("setDefault", () => {
    it("changes the default profile", async () => {
      await store.add(makeProfile({ name: "first" }));
      await store.add(makeProfile({ name: "second" }));

      const result = await store.setDefault("second");
      expect(result.ok).toBe(true);

      const defaultResult = await store.getDefault();
      expect(defaultResult.ok).toBe(true);
      if (!defaultResult.ok) return;
      expect(defaultResult.value?.name).toBe("second");

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      const first = listResult.value.find((p) => p.name === "first");
      expect(first?.isDefault).toBe(false);
    });

    it("returns error for non-existent profile", async () => {
      const result = await store.setDefault("nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("DAEMON_PROFILE_NOT_FOUND");
    });
  });

  describe("touchLastConnected", () => {
    it("updates the lastConnected timestamp", async () => {
      await store.add(makeProfile({ name: "local" }));

      const before = new Date().toISOString();
      const result = await store.touchLastConnected("local");
      expect(result.ok).toBe(true);

      const getResult = await store.get("local");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value?.lastConnected).not.toBeNull();
      expect(getResult.value!.lastConnected! >= before).toBe(true);
    });

    it("returns error for non-existent profile", async () => {
      const result = await store.touchLastConnected("nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("DAEMON_PROFILE_NOT_FOUND");
    });
  });

  describe("file handling", () => {
    it("handles missing file gracefully (returns empty list)", async () => {
      const result = await store.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });

    it("handles corrupt JSON gracefully", async () => {
      await writeFile(join(tempDir, "daemons.json"), "not valid json{{{");

      const result = await store.list();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("DAEMON_PROFILE_PARSE_ERROR");
    });

    it("handles malformed file structure gracefully", async () => {
      await writeFile(
        join(tempDir, "daemons.json"),
        JSON.stringify({ version: 1, profiles: "not-an-array" }),
      );

      const result = await store.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });

    it("persists profiles to disk as JSON with 2-space indentation", async () => {
      await store.add(makeProfile({ name: "local" }));

      const raw = await readFile(join(tempDir, "daemons.json"), "utf-8");
      expect(raw.endsWith("\n")).toBe(true);

      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.profiles).toHaveLength(1);
      expect(parsed.profiles[0].name).toBe("local");

      // Verify 2-space indentation
      expect(raw).toContain('  "version"');
    });

    it("creates parent directories if they do not exist", async () => {
      const nestedDir = join(tempDir, "nested", "deep");
      const nestedStore = new DaemonProfileStore({ dataRoot: nestedDir });

      const result = await nestedStore.add(makeProfile({ name: "local" }));
      expect(result.ok).toBe(true);

      const getResult = await nestedStore.get("local");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value?.name).toBe("local");
    });
  });
});

import { describe, expect, test } from "bun:test";

import { SyncPolicy } from "../../src/sync/policy";

describe("SyncPolicy", () => {
  test("isSyncable returns true for supported sync domains", () => {
    expect(SyncPolicy.isSyncable("credentials")).toBe(true);
    expect(SyncPolicy.isSyncable("billing")).toBe(true);
    expect(SyncPolicy.isSyncable("config")).toBe(true);
    expect(SyncPolicy.isSyncable("conversations")).toBe(false);
  });

  test("isLocalOnly returns true for local-only domains", () => {
    expect(SyncPolicy.isLocalOnly("conversations")).toBe(true);
    expect(SyncPolicy.isLocalOnly("sessions")).toBe(true);
    expect(SyncPolicy.isLocalOnly("transcripts")).toBe(true);
    expect(SyncPolicy.isLocalOnly("cron")).toBe(true);
    expect(SyncPolicy.isLocalOnly("memory")).toBe(true);
    expect(SyncPolicy.isLocalOnly("credentials")).toBe(false);
  });

  test("resolveConflict returns local_wins when checksums match", () => {
    const resolution = SyncPolicy.resolveConflict(
      { checksum: "same", updatedAt: 1000 },
      { checksum: "same", updatedAt: 1200 },
    );

    expect(resolution).toBe("local_wins");
  });

  test("resolveConflict returns latest winner when checksums differ outside conflict window", () => {
    const localWins = SyncPolicy.resolveConflict(
      { checksum: "local-v2", updatedAt: 20000 },
      { checksum: "remote-v1", updatedAt: 10000 },
    );
    const remoteWins = SyncPolicy.resolveConflict(
      { checksum: "local-v1", updatedAt: 10000 },
      { checksum: "remote-v2", updatedAt: 20000 },
    );

    expect(localWins).toBe("local_wins");
    expect(remoteWins).toBe("remote_wins");
  });

  test("resolveConflict returns flagged when checksums differ within conflict window", () => {
    const resolution = SyncPolicy.resolveConflict(
      { checksum: "local", updatedAt: 10000 },
      { checksum: "remote", updatedAt: 13000 },
    );

    expect(resolution).toBe("flagged");
  });

  test("validateSyncPayload rejects local-only domains", () => {
    const result = SyncPolicy.validateSyncPayload("conversations", { messages: [] });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.name).toBe("SyncError");
    expect(result.error.message).toContain("local-only");
  });

  test("validateSyncPayload accepts syncable domains", () => {
    const result = SyncPolicy.validateSyncPayload("credentials", { id: "cred_1" });
    expect(result.ok).toBe(true);
  });
});

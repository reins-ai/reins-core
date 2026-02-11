import { describe, expect, test } from "bun:test";

import { SyncPolicy } from "../../src/sync/policy";

describe("credential sync policy integration", () => {
  test("blocks local-only conversation domain from sync payload validation", () => {
    const result = SyncPolicy.validateSyncPayload("conversations", {
      conversationId: "conv_1",
      content: "never sync this",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.message).toBe('Domain "conversations" is local-only and cannot be synced');
  });

  test("allows credential domain for cloud sync payloads", () => {
    const result = SyncPolicy.validateSyncPayload("credentials", {
      credentialId: "cred_1",
      encryptedPayload: "abc",
    });

    expect(result.ok).toBe(true);
  });

  test("resolves conflicts deterministically based on checksum and timestamps", () => {
    const sameChecksum = SyncPolicy.resolveConflict(
      { checksum: "same", updatedAt: 1000 },
      { checksum: "same", updatedAt: 1001 },
    );
    const closeTimestampConflict = SyncPolicy.resolveConflict(
      { checksum: "local-a", updatedAt: 10000 },
      { checksum: "remote-b", updatedAt: 12000 },
    );
    const clearOrderingWinner = SyncPolicy.resolveConflict(
      { checksum: "local-a", updatedAt: 20000 },
      { checksum: "remote-b", updatedAt: 10000 },
    );

    expect(sameChecksum).toBe("local_wins");
    expect(closeTimestampConflict).toBe("flagged");
    expect(clearOrderingWinner).toBe("local_wins");
  });
});

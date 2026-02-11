import { describe, expect, test } from "bun:test";

import { SyncTriggerManager } from "../../src/sync/triggers";

describe("SyncTriggerManager", () => {
  test("default config enables auto-sync on credential change", () => {
    const manager = new SyncTriggerManager();
    expect(manager.shouldAutoSync("credential_change")).toBe(true);
    expect(manager.shouldAutoSync("billing_change")).toBe(false);
    expect(manager.shouldAutoSync("startup")).toBe(false);
    expect(manager.shouldAutoSync("manual")).toBe(false);
  });

  test("fire invokes all registered handlers for a trigger", async () => {
    const manager = new SyncTriggerManager();
    const calls: string[] = [];

    manager.onTrigger("manual", async () => {
      calls.push("first");
    });
    manager.onTrigger("manual", async () => {
      calls.push("second");
    });

    await manager.fire("manual");
    expect(calls.sort()).toEqual(["first", "second"]);
  });

  test("shouldAutoSync respects custom configuration", () => {
    const manager = new SyncTriggerManager({
      autoSyncOnCredentialChange: false,
      autoSyncOnBillingChange: true,
      autoSyncOnStartup: true,
    });

    expect(manager.shouldAutoSync("credential_change")).toBe(false);
    expect(manager.shouldAutoSync("billing_change")).toBe(true);
    expect(manager.shouldAutoSync("startup")).toBe(true);
  });

  test("updateConfig changes runtime trigger behavior", () => {
    const manager = new SyncTriggerManager();
    manager.updateConfig({
      autoSyncOnCredentialChange: false,
      autoSyncOnStartup: true,
    });

    expect(manager.shouldAutoSync("credential_change")).toBe(false);
    expect(manager.shouldAutoSync("startup")).toBe(true);

    const config = manager.getConfig();
    expect(config.autoSyncOnCredentialChange).toBe(false);
    expect(config.autoSyncOnStartup).toBe(true);
  });
});

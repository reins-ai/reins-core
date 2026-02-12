import { describe, expect, it } from "bun:test";

import type { PluginDataAccess } from "../../src/plugins/api";
import { InMemoryPermissionAuditLog } from "../../src/plugins/audit";
import { EnforcedDataAccess, PermissionGuard } from "../../src/plugins/enforcement";
import { PluginPermissionChecker, PluginPermissionError } from "../../src/plugins/permissions";

function createDataAccess(): PluginDataAccess {
  return {
    conversations: {
      list: async () => [
        {
          id: "c1",
          title: "Conversation",
          model: "mock",
          messageCount: 1,
          lastMessageAt: new Date(),
          createdAt: new Date(),
        },
      ],
      getMessages: async () => [
        { id: "m1", role: "user", content: "hello", createdAt: new Date() },
      ],
    },
    calendar: {
      list: async () => [{ id: "e1", title: "Event", startAt: new Date(), endAt: new Date() }],
      create: async (input) => ({ id: "e2", ...input }),
    },
    notes: {
      list: async () => [{ id: "n1", title: "Note", content: "body", updatedAt: new Date() }],
      create: async (input) => ({ id: "n2", ...input, updatedAt: new Date() }),
    },
    reminders: {
      list: async () => [{ id: "r1", title: "Reminder", dueAt: new Date(), completed: false }],
      create: async (input) => ({ id: "r2", ...input, completed: false }),
    },
  };
}

describe("EnforcedDataAccess", () => {
  it("blocks unauthorized conversation access", async () => {
    const checker = new PluginPermissionChecker("test", [], new InMemoryPermissionAuditLog());
    const access = new EnforcedDataAccess(createDataAccess(), checker);

    await expect(access.conversations.list({ limit: 1 })).rejects.toThrow(PluginPermissionError);
  });

  it("allows authorized conversation access", async () => {
    const checker = new PluginPermissionChecker(
      "test",
      ["read_conversations"],
      new InMemoryPermissionAuditLog(),
    );
    const access = new EnforcedDataAccess(createDataAccess(), checker);

    const conversations = await access.conversations.list({ limit: 1 });
    expect(conversations).toHaveLength(1);
  });

  it("blocks unauthorized calendar access", async () => {
    const checker = new PluginPermissionChecker("test", [], new InMemoryPermissionAuditLog());
    const access = new EnforcedDataAccess(createDataAccess(), checker);

    await expect(access.calendar.create({
      title: "Meeting",
      startAt: new Date(),
      endAt: new Date(),
    })).rejects.toThrow(PluginPermissionError);
  });

  it("blocks unauthorized notes access", async () => {
    const checker = new PluginPermissionChecker("test", [], new InMemoryPermissionAuditLog());
    const access = new EnforcedDataAccess(createDataAccess(), checker);

    await expect(access.notes.list({ limit: 5 })).rejects.toThrow(PluginPermissionError);
  });

  it("blocks unauthorized reminders access", async () => {
    const checker = new PluginPermissionChecker("test", [], new InMemoryPermissionAuditLog());
    const access = new EnforcedDataAccess(createDataAccess(), checker);

    await expect(access.reminders.list({ limit: 5 })).rejects.toThrow(PluginPermissionError);
  });

  it("audit logs denied attempts", async () => {
    const audit = new InMemoryPermissionAuditLog();
    const checker = new PluginPermissionChecker("test", [], audit);
    const access = new EnforcedDataAccess(createDataAccess(), checker);

    await expect(access.notes.create({ title: "New", content: "Body" })).rejects.toThrow(
      PluginPermissionError,
    );

    const deniedEntries = audit.getEntries("test").filter((entry) => !entry.granted);
    expect(deniedEntries).toHaveLength(1);
    expect(deniedEntries[0]?.action).toBe("notes.create");
  });

  it("enforces network and file permissions", async () => {
    const checker = new PluginPermissionChecker("test", [], new InMemoryPermissionAuditLog());
    const guard = new PermissionGuard(checker);

    expect(() => guard.assertNetworkAccess("network.fetch")).toThrow(PluginPermissionError);
    expect(() => guard.assertFileAccess("file.read")).toThrow(PluginPermissionError);
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginDataAccess } from "../../../src/plugins/api";
import { InMemoryPermissionAuditLog } from "../../../src/plugins/audit";
import { PermissionGuard } from "../../../src/plugins/enforcement";
import { PluginPermissionChecker } from "../../../src/plugins/permissions";
import { DEFAULT_RESOURCE_LIMITS, MockPluginSandbox, type SandboxConfig } from "../../../src/plugins/sandbox";
import type { PluginPermission } from "../../../src/types";

const createdRoots: string[] = [];

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createPluginEntryPoint(root: string, fileName: string, source: string): Promise<string> {
  const entryPoint = join(root, fileName);
  await writeFile(entryPoint, source, "utf8");
  return entryPoint;
}

function createConfig(
  pluginName: string,
  entryPoint: string,
  permissions: PluginPermission[],
): SandboxConfig {
  return {
    pluginName,
    entryPoint,
    permissions,
    limits: {
      ...DEFAULT_RESOURCE_LIMITS,
      maxEventHandlerMs: 100,
    },
    timeout: 500,
  };
}

function createDataAccess(track: {
  conversationLists: number;
  noteCreates: number;
}): PluginDataAccess {
  return {
    conversations: {
      list: async () => {
        track.conversationLists += 1;
        return [];
      },
      getMessages: async () => [],
    },
    calendar: {
      list: async () => [],
      create: async (input) => ({ id: "calendar-1", ...input }),
    },
    notes: {
      list: async () => [],
      create: async (input) => {
        track.noteCreates += 1;
        return {
          id: "note-1",
          title: input.title,
          content: input.content,
          updatedAt: new Date(),
        };
      },
    },
    reminders: {
      list: async () => [],
      create: async (input) => ({ id: "reminder-1", completed: false, ...input }),
    },
  };
}

const readConversationsPlugin = `
export default async function setupPlugin(context) {
  context.on("message", async () => {
    await context.data.conversations.list({ limit: 5 });
  });
}
`;

const writeNotesPlugin = `
export default async function setupPlugin(context) {
  context.on("message", async () => {
    await context.data.notes.create({ title: "T", content: "C" });
  });
}
`;

describe("integration/plugins/permissions", () => {
  it("enforces permission checks and records denials in the audit log", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-int-permissions-"));
    createdRoots.push(root);

    const track = { conversationLists: 0, noteCreates: 0 };
    const auditLog = new InMemoryPermissionAuditLog();

    const conversationEntryPoint = await createPluginEntryPoint(
      root,
      "read-conversations.ts",
      readConversationsPlugin,
    );
    const notesEntryPoint = await createPluginEntryPoint(root, "write-notes.ts", writeNotesPlugin);

    const allowedReader = new MockPluginSandbox(
      createConfig("reader-allowed", conversationEntryPoint, ["read_conversations"]),
      auditLog,
    );
    allowedReader.setDataAccess(createDataAccess(track));
    await allowedReader.start();
    await allowedReader.sendEvent("message", { text: "go" });
    expect(track.conversationLists).toBe(1);

    const deniedReader = new MockPluginSandbox(
      createConfig("reader-denied", conversationEntryPoint, []),
      auditLog,
    );
    deniedReader.setDataAccess(createDataAccess(track));
    await deniedReader.start();
    await expect(deniedReader.sendEvent("message", { text: "blocked" })).rejects.toThrow(
      "missing required permission: read_conversations",
    );

    const allowedWriter = new MockPluginSandbox(
      createConfig("writer-allowed", notesEntryPoint, ["write_notes"]),
      auditLog,
    );
    allowedWriter.setDataAccess(createDataAccess(track));
    await allowedWriter.start();
    await allowedWriter.sendEvent("message", { text: "create" });
    expect(track.noteCreates).toBe(1);

    const deniedWriter = new MockPluginSandbox(
      createConfig("writer-denied", notesEntryPoint, []),
      auditLog,
    );
    deniedWriter.setDataAccess(createDataAccess(track));
    await deniedWriter.start();
    await expect(deniedWriter.sendEvent("message", { text: "blocked" })).rejects.toThrow(
      "missing required permission: write_notes",
    );

    const networkAllowedChecker = new PluginPermissionChecker(
      "network-allowed",
      ["network_access"],
      auditLog,
    );
    const networkAllowedGuard = new PermissionGuard(networkAllowedChecker);
    const networkResult = await networkAllowedGuard.runWithNetworkAccess("network.fetch", async () => {
      return { ok: true, status: 200 };
    });
    expect(networkResult).toEqual({ ok: true, status: 200 });

    const networkDeniedChecker = new PluginPermissionChecker("network-denied", [], auditLog);
    const networkDeniedGuard = new PermissionGuard(networkDeniedChecker);
    await expect(
      networkDeniedGuard.runWithNetworkAccess("network.fetch", async () => ({ ok: true })),
    ).rejects.toThrow("missing required permission: network_access");

    const deniedEntries = auditLog.getEntries().filter((entry) => !entry.granted);
    expect(deniedEntries.length).toBeGreaterThanOrEqual(3);
    expect(deniedEntries.every((entry) => entry.error !== undefined)).toBe(true);

    const deniedActions = deniedEntries.map((entry) => `${entry.pluginName}:${entry.action}`).sort();
    expect(deniedActions).toContain("reader-denied:conversations.list");
    expect(deniedActions).toContain("writer-denied:notes.create");
    expect(deniedActions).toContain("network-denied:network.fetch");

    await allowedReader.stop();
    await deniedReader.stop();
    await allowedWriter.stop();
    await deniedWriter.stop();
  });
});

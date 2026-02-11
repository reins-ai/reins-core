import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { TranscriptStore, type TranscriptEntry } from "../../src/conversation";
import { getTranscriptsDir } from "../../src/daemon/paths";
import { StreamingResponse } from "../../src/streaming";
import type { StreamEvent } from "../../src/types";

const tempDirs: string[] = [];

async function createStore() {
  const homeDirectory = await mkdtemp(join(tmpdir(), "reins-transcript-"));
  tempDirs.push(homeDirectory);

  const daemonPathOptions = {
    platform: "linux" as const,
    env: {},
    homeDirectory,
  };

  const store = new TranscriptStore({ daemonPathOptions });

  return {
    homeDirectory,
    store,
    transcriptsDir: getTranscriptsDir(daemonPathOptions),
  };
}

async function* eventStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

describe("TranscriptStore", () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const path = tempDirs.pop();
      if (!path) {
        continue;
      }

      await rm(path, { recursive: true, force: true });
    }
  });

  it("appends entries and reads them back", async () => {
    const { store } = await createStore();
    const sessionId = "sess_round_trip";
    const entries: TranscriptEntry[] = [
      {
        type: "session_start",
        timestamp: "2026-02-11T12:00:00.000Z",
        sessionId,
      },
      {
        type: "message",
        timestamp: "2026-02-11T12:00:01.000Z",
        role: "user",
        content: "Hello",
        messageId: "msg_user_1",
      },
    ];

    for (const entry of entries) {
      const appendResult = await store.append(sessionId, entry);
      expect(appendResult.ok).toBe(true);
    }

    const syncResult = await store.sync(sessionId);
    expect(syncResult.ok).toBe(true);

    const readResult = await store.read(sessionId);
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) {
      return;
    }

    expect(readResult.value).toEqual(entries);
  });

  it("writes one valid JSON document per line", async () => {
    const { store } = await createStore();
    const sessionId = "sess_jsonl";

    const first = await store.append(sessionId, {
      type: "session_start",
      timestamp: "2026-02-11T12:01:00.000Z",
      sessionId,
    });
    const second = await store.append(sessionId, {
      type: "message",
      timestamp: "2026-02-11T12:01:01.000Z",
      role: "assistant",
      content: "Ready",
      messageId: "msg_assistant_1",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const content = await readFile(store.getPath(sessionId), "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("reads the tail entries in order", async () => {
    const { store } = await createStore();
    const sessionId = "sess_tail";

    const entries: TranscriptEntry[] = Array.from({ length: 5 }, (_, index) => ({
      type: "message",
      timestamp: `2026-02-11T12:02:0${index}.000Z`,
      role: "assistant",
      content: `message-${index}`,
      messageId: `msg_${index}`,
    }));

    const appendResult = await store.appendBatch(sessionId, entries);
    expect(appendResult.ok).toBe(true);

    const tailResult = await store.readTail(sessionId, 2);
    expect(tailResult.ok).toBe(true);
    if (!tailResult.ok) {
      return;
    }

    expect(tailResult.value.map((entry) => (entry.type === "message" ? entry.messageId : ""))).toEqual([
      "msg_3",
      "msg_4",
    ]);
  });

  it("repairs a truncated final line after a crash", async () => {
    const { store } = await createStore();
    const sessionId = "sess_repair";

    await store.append(sessionId, {
      type: "session_start",
      timestamp: "2026-02-11T12:03:00.000Z",
      sessionId,
    });
    await store.append(sessionId, {
      type: "message",
      timestamp: "2026-02-11T12:03:01.000Z",
      role: "assistant",
      content: "stable",
      messageId: "msg_stable",
    });

    await appendFile(store.getPath(sessionId), "{\"type\":\"message\",\"timestamp\":", "utf8");

    const repairResult = await store.repair(sessionId);
    expect(repairResult.ok).toBe(true);
    if (!repairResult.ok) {
      return;
    }

    expect(repairResult.value).toBe(true);

    const readResult = await store.read(sessionId);
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) {
      return;
    }

    expect(readResult.value).toHaveLength(2);
    expect(readResult.value[1]).toMatchObject({ type: "message", messageId: "msg_stable" });
  });

  it("recovers transcript replay after restart simulation", async () => {
    const { homeDirectory, store } = await createStore();
    const sessionId = "sess_restart";

    await store.appendBatch(sessionId, [
      {
        type: "session_start",
        timestamp: "2026-02-11T12:04:00.000Z",
        sessionId,
      },
      {
        type: "message",
        timestamp: "2026-02-11T12:04:01.000Z",
        role: "user",
        content: "persist me",
        messageId: "msg_persist",
      },
    ]);
    await appendFile(store.getPath(sessionId), "{\"type\":\"turn_end\"", "utf8");

    const restartedStore = new TranscriptStore({
      daemonPathOptions: {
        platform: "linux",
        env: {},
        homeDirectory,
      },
    });

    const repairResult = await restartedStore.repair(sessionId);
    expect(repairResult.ok).toBe(true);
    if (!repairResult.ok) {
      return;
    }

    expect(repairResult.value).toBe(true);

    const replayResult = await restartedStore.read(sessionId);
    expect(replayResult.ok).toBe(true);
    if (!replayResult.ok) {
      return;
    }

    expect(replayResult.value.map((entry) => entry.type)).toEqual(["session_start", "message"]);
  });

  it("uses session id for transcript file naming", async () => {
    const { store, transcriptsDir } = await createStore();
    const sessionId = "sess_filename";

    const expectedPath = join(transcriptsDir, `${sessionId}.jsonl`);
    expect(store.getPath(sessionId)).toBe(expectedPath);
    expect(dirname(store.getPath(sessionId))).toBe(transcriptsDir);
  });

  it("records tool events and turn boundaries from streaming hooks", async () => {
    const { store } = await createStore();
    const sessionId = "sess_streaming";

    const events: StreamEvent[] = [
      {
        type: "tool_call_start",
        toolCall: {
          id: "tool_1",
          name: "calendar.create",
          arguments: { title: "Standup" },
        },
      },
      {
        type: "tool_call_end",
        result: {
          callId: "tool_1",
          name: "calendar.create",
          result: { success: true },
        },
      },
      {
        type: "token",
        content: "Done",
      },
      {
        type: "done",
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
        },
        finishReason: "stop",
      },
    ];

    const response = new StreamingResponse(eventStream(events), {
      turn: {
        turnId: "turn_1",
        model: "gpt-4o-mini",
        provider: "openai",
      },
      onTranscript: async (entry) => {
        await store.append(sessionId, entry);
      },
    });

    await response.collect();
    await store.sync(sessionId);

    const readResult = await store.read(sessionId);
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) {
      return;
    }

    expect(readResult.value.map((entry) => entry.type)).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
      "message",
      "turn_end",
    ]);
  });
});

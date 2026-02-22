import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ConversationMapper,
  type OpenClawSessionLine,
} from "../../../src/conversion/mappers/conversation-mapper";
import type { Conversation } from "../../../src/conversation/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpBase(): string {
  const id = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `reins-test-conv-${id}`);
}

function makeLine(overrides: Partial<OpenClawSessionLine> = {}): OpenClawSessionLine {
  return {
    role: "user",
    content: "Hello",
    ...overrides,
  };
}

function toJsonl(lines: Array<Partial<OpenClawSessionLine>>): string {
  return lines.map((l) => JSON.stringify(makeLine(l))).join("\n");
}

async function writeFixture(dir: string, name: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await Bun.write(path, content);
  return path;
}

async function readConversation(path: string): Promise<Conversation> {
  const file = Bun.file(path);
  const text = await file.text();
  return JSON.parse(text) as Conversation;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationMapper", () => {
  let base: string;
  let inputDir: string;
  let outputDir: string;

  beforeEach(async () => {
    base = tmpBase();
    inputDir = join(base, "input");
    outputDir = join(base, "output");
    await mkdir(inputDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(base, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("basic conversion", () => {
    it("converts a single JSONL file with one session", async () => {
      const jsonl = toJsonl([
        { sessionId: "sess-1", role: "user", content: "Hi" },
        { sessionId: "sess-1", role: "assistant", content: "Hello!" },
      ]);
      const filePath = await writeFixture(inputDir, "session.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([filePath]);

      expect(result.converted).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      const conv = await readConversation(join(outputDir, "sess-1.json"));
      expect(conv.id).toBe("sess-1");
      expect(conv.messages).toHaveLength(2);
      expect(conv.messages[0].role).toBe("user");
      expect(conv.messages[0].content).toBe("Hi");
      expect(conv.messages[1].role).toBe("assistant");
      expect(conv.messages[1].content).toBe("Hello!");
    });

    it("groups messages by sessionId into separate conversations", async () => {
      const jsonl = toJsonl([
        { sessionId: "a", role: "user", content: "Q1" },
        { sessionId: "b", role: "user", content: "Q2" },
        { sessionId: "a", role: "assistant", content: "A1" },
        { sessionId: "b", role: "assistant", content: "A2" },
      ]);
      const filePath = await writeFixture(inputDir, "multi.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([filePath]);

      expect(result.converted).toBe(2);

      const convA = await readConversation(join(outputDir, "a.json"));
      expect(convA.messages).toHaveLength(2);
      expect(convA.messages[0].content).toBe("Q1");
      expect(convA.messages[1].content).toBe("A1");

      const convB = await readConversation(join(outputDir, "b.json"));
      expect(convB.messages).toHaveLength(2);
      expect(convB.messages[0].content).toBe("Q2");
      expect(convB.messages[1].content).toBe("A2");
    });

    it("uses filename as session key when no sessionId present", async () => {
      const jsonl = toJsonl([
        { role: "user", content: "No session ID" },
        { role: "assistant", content: "Still no session ID" },
      ]);
      const filePath = await writeFixture(inputDir, "my-chat.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([filePath]);

      expect(result.converted).toBe(1);

      const conv = await readConversation(join(outputDir, "my-chat.json"));
      expect(conv.id).toBe("my-chat");
      expect(conv.messages).toHaveLength(2);
    });
  });

  describe("conversation fields", () => {
    it("sets model from first message with a model field", async () => {
      const jsonl = toJsonl([
        { sessionId: "s1", role: "user", content: "Hi" },
        { sessionId: "s1", role: "assistant", content: "Hey", model: "claude-3" },
      ]);
      const filePath = await writeFixture(inputDir, "model.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      await mapper.map([filePath]);

      const conv = await readConversation(join(outputDir, "s1.json"));
      expect(conv.model).toBe("claude-3");
    });

    it("defaults model to unknown when no message has model", async () => {
      const jsonl = toJsonl([
        { sessionId: "s2", role: "user", content: "Hi" },
      ]);
      const filePath = await writeFixture(inputDir, "no-model.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      await mapper.map([filePath]);

      const conv = await readConversation(join(outputDir, "s2.json"));
      expect(conv.model).toBe("unknown");
    });

    it("sets provider to openclaw-import", async () => {
      const jsonl = toJsonl([
        { sessionId: "s3", role: "user", content: "Hi" },
      ]);
      const filePath = await writeFixture(inputDir, "provider.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      await mapper.map([filePath]);

      const conv = await readConversation(join(outputDir, "s3.json"));
      expect(conv.provider).toBe("openclaw-import");
    });

    it("sets personaId from agentId when present", async () => {
      const jsonl = toJsonl([
        { sessionId: "s4", role: "user", content: "Hi", agentId: "eleanor" },
      ]);
      const filePath = await writeFixture(inputDir, "agent.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      await mapper.map([filePath]);

      const conv = await readConversation(join(outputDir, "s4.json"));
      expect(conv.personaId).toBe("eleanor");
    });

    it("preserves message timestamps", async () => {
      const ts = "2026-01-15T10:30:00.000Z";
      const jsonl = toJsonl([
        { sessionId: "s5", role: "user", content: "Hi", timestamp: ts },
      ]);
      const filePath = await writeFixture(inputDir, "ts.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      await mapper.map([filePath]);

      const conv = await readConversation(join(outputDir, "s5.json"));
      expect(new Date(conv.messages[0].createdAt).toISOString()).toBe(ts);
    });

    it("preserves message metadata", async () => {
      const jsonl = toJsonl([
        {
          sessionId: "s6",
          role: "user",
          content: "Hi",
          metadata: { source: "tui", version: 2 },
        },
      ]);
      const filePath = await writeFixture(inputDir, "meta.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      await mapper.map([filePath]);

      const conv = await readConversation(join(outputDir, "s6.json"));
      expect(conv.messages[0].metadata).toEqual({ source: "tui", version: 2 });
    });

    it("generates title from session id", async () => {
      const jsonl = toJsonl([
        { sessionId: "abc-123", role: "user", content: "Hi" },
      ]);
      const filePath = await writeFixture(inputDir, "title.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      await mapper.map([filePath]);

      const conv = await readConversation(join(outputDir, "abc-123.json"));
      expect(conv.title).toBe("Imported session abc-123");
    });

    it("generates unique message ids when not provided", async () => {
      const jsonl = toJsonl([
        { sessionId: "s7", role: "user", content: "A" },
        { sessionId: "s7", role: "assistant", content: "B" },
      ]);
      const filePath = await writeFixture(inputDir, "ids.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      await mapper.map([filePath]);

      const conv = await readConversation(join(outputDir, "s7.json"));
      expect(conv.messages[0].id).toBeTruthy();
      expect(conv.messages[1].id).toBeTruthy();
      expect(conv.messages[0].id).not.toBe(conv.messages[1].id);
    });

    it("preserves original message id when provided", async () => {
      const jsonl = toJsonl([
        { sessionId: "s8", role: "user", content: "Hi", id: "orig-msg-42" },
      ]);
      const filePath = await writeFixture(inputDir, "orig-id.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      await mapper.map([filePath]);

      const conv = await readConversation(join(outputDir, "s8.json"));
      expect(conv.messages[0].id).toBe("orig-msg-42");
    });
  });

  describe("empty and edge cases", () => {
    it("returns skipped=1 for an empty JSONL file", async () => {
      const filePath = await writeFixture(inputDir, "empty.jsonl", "");

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([filePath]);

      expect(result.converted).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("returns skipped=1 for a file with only whitespace lines", async () => {
      const filePath = await writeFixture(inputDir, "blank.jsonl", "  \n\n  \n");

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([filePath]);

      expect(result.converted).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("handles empty sessionPaths array", async () => {
      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([]);

      expect(result.converted).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("records error for non-existent file", async () => {
      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map(["/nonexistent/path.jsonl"]);

      expect(result.converted).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].item).toBe("/nonexistent/path.jsonl");
      expect(result.errors[0].reason).toContain("Failed to read file");
    });
  });

  describe("malformed JSONL handling", () => {
    it("skips malformed lines and records errors", async () => {
      const lines = [
        JSON.stringify(makeLine({ sessionId: "s", role: "user", content: "Good" })),
        "not valid json",
        JSON.stringify(makeLine({ sessionId: "s", role: "assistant", content: "Also good" })),
      ].join("\n");
      const filePath = await writeFixture(inputDir, "mixed.jsonl", lines);

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([filePath]);

      expect(result.converted).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toBe("Malformed JSONL line");

      const conv = await readConversation(join(outputDir, "s.json"));
      expect(conv.messages).toHaveLength(2);
    });

    it("skips lines missing required role field", async () => {
      const lines = [
        JSON.stringify({ content: "no role" }),
        JSON.stringify(makeLine({ sessionId: "s", role: "user", content: "valid" })),
      ].join("\n");
      const filePath = await writeFixture(inputDir, "no-role.jsonl", lines);

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([filePath]);

      expect(result.converted).toBe(1);
      expect(result.errors).toHaveLength(1);
    });

    it("skips lines missing required content field", async () => {
      const lines = [
        JSON.stringify({ role: "user" }),
        JSON.stringify(makeLine({ sessionId: "s", role: "user", content: "valid" })),
      ].join("\n");
      const filePath = await writeFixture(inputDir, "no-content.jsonl", lines);

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([filePath]);

      expect(result.converted).toBe(1);
      expect(result.errors).toHaveLength(1);
    });

    it("skips lines with invalid role value", async () => {
      const lines = [
        JSON.stringify({ role: "moderator", content: "invalid role" }),
        JSON.stringify(makeLine({ sessionId: "s", role: "user", content: "valid" })),
      ].join("\n");
      const filePath = await writeFixture(inputDir, "bad-role.jsonl", lines);

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([filePath]);

      expect(result.converted).toBe(1);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe("progress callbacks", () => {
    it("invokes onProgress per batch of 100 messages", async () => {
      // Create 250 lines → expect 3 progress calls (100, 200, 250)
      const lines: string[] = [];
      for (let i = 0; i < 250; i++) {
        lines.push(
          JSON.stringify(makeLine({
            sessionId: "big",
            role: i % 2 === 0 ? "user" : "assistant",
            content: `Message ${i}`,
          })),
        );
      }
      const filePath = await writeFixture(inputDir, "large.jsonl", lines.join("\n"));

      const progressCalls: Array<[number, number]> = [];
      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([filePath], {
        onProgress: (processed, total) => {
          progressCalls.push([processed, total]);
        },
      });

      expect(result.converted).toBe(1);
      expect(progressCalls).toHaveLength(3);
      expect(progressCalls[0]).toEqual([100, 250]);
      expect(progressCalls[1]).toEqual([200, 250]);
      expect(progressCalls[2]).toEqual([250, 250]);

      const conv = await readConversation(join(outputDir, "big.json"));
      expect(conv.messages).toHaveLength(250);
    });

    it("invokes onProgress once for files smaller than batch size", async () => {
      const jsonl = toJsonl([
        { sessionId: "small", role: "user", content: "Hi" },
        { sessionId: "small", role: "assistant", content: "Hey" },
      ]);
      const filePath = await writeFixture(inputDir, "small.jsonl", jsonl);

      const progressCalls: Array<[number, number]> = [];
      const mapper = new ConversationMapper({ outputDir });
      await mapper.map([filePath], {
        onProgress: (processed, total) => {
          progressCalls.push([processed, total]);
        },
      });

      expect(progressCalls).toHaveLength(1);
      expect(progressCalls[0]).toEqual([2, 2]);
    });

    it("supports custom batch size", async () => {
      const lines: string[] = [];
      for (let i = 0; i < 25; i++) {
        lines.push(
          JSON.stringify(makeLine({
            sessionId: "custom",
            role: "user",
            content: `Msg ${i}`,
          })),
        );
      }
      const filePath = await writeFixture(inputDir, "custom-batch.jsonl", lines.join("\n"));

      const progressCalls: Array<[number, number]> = [];
      const mapper = new ConversationMapper({ outputDir, batchSize: 10 });
      await mapper.map([filePath], {
        onProgress: (processed, total) => {
          progressCalls.push([processed, total]);
        },
      });

      expect(progressCalls).toHaveLength(3);
      expect(progressCalls[0]).toEqual([10, 25]);
      expect(progressCalls[1]).toEqual([20, 25]);
      expect(progressCalls[2]).toEqual([25, 25]);
    });
  });

  describe("multiple files", () => {
    it("processes multiple JSONL files", async () => {
      const file1 = await writeFixture(
        inputDir,
        "chat1.jsonl",
        toJsonl([
          { sessionId: "c1", role: "user", content: "File 1" },
        ]),
      );
      const file2 = await writeFixture(
        inputDir,
        "chat2.jsonl",
        toJsonl([
          { sessionId: "c2", role: "user", content: "File 2" },
        ]),
      );

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([file1, file2]);

      expect(result.converted).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      const conv1 = await readConversation(join(outputDir, "c1.json"));
      expect(conv1.messages[0].content).toBe("File 1");

      const conv2 = await readConversation(join(outputDir, "c2.json"));
      expect(conv2.messages[0].content).toBe("File 2");
    });

    it("aggregates results across files", async () => {
      const file1 = await writeFixture(inputDir, "ok.jsonl", toJsonl([
        { sessionId: "ok", role: "user", content: "Good" },
      ]));
      const file2 = await writeFixture(inputDir, "empty.jsonl", "");

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([file1, file2]);

      expect(result.converted).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });

  describe("dry-run mode", () => {
    it("does not write files in dry-run mode", async () => {
      const jsonl = toJsonl([
        { sessionId: "dry", role: "user", content: "Dry run" },
      ]);
      const filePath = await writeFixture(inputDir, "dry.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([filePath], { dryRun: true });

      expect(result.converted).toBe(1);
      expect(result.skipped).toBe(0);

      const fileExists = await Bun.file(join(outputDir, "dry.json")).exists();
      expect(fileExists).toBe(false);
    });
  });

  describe("system role messages", () => {
    it("handles system role messages", async () => {
      const jsonl = toJsonl([
        { sessionId: "sys", role: "system", content: "You are helpful." },
        { sessionId: "sys", role: "user", content: "Hi" },
        { sessionId: "sys", role: "assistant", content: "Hello!" },
      ]);
      const filePath = await writeFixture(inputDir, "system.jsonl", jsonl);

      const mapper = new ConversationMapper({ outputDir });
      const result = await mapper.map([filePath]);

      expect(result.converted).toBe(1);

      const conv = await readConversation(join(outputDir, "sys.json"));
      expect(conv.messages).toHaveLength(3);
      expect(conv.messages[0].role).toBe("system");
    });
  });

  describe("file ops injection", () => {
    it("uses injected file ops for all I/O", async () => {
      const written: Array<{ path: string; data: unknown }> = [];
      const mockFileOps = {
        async readFileText(): Promise<string> {
          return [
            JSON.stringify(makeLine({ sessionId: "mock", role: "user", content: "Injected" })),
          ].join("\n");
        },
        async writeJson(path: string, data: unknown): Promise<void> {
          written.push({ path, data });
        },
        async exists(): Promise<boolean> {
          return false;
        },
      };

      const mapper = new ConversationMapper(
        { outputDir: "/fake/output" },
        mockFileOps,
      );
      const result = await mapper.map(["/fake/input.jsonl"]);

      expect(result.converted).toBe(1);
      expect(written).toHaveLength(1);
      expect(written[0].path).toContain("mock.json");

      const conv = written[0].data as Conversation;
      expect(conv.id).toBe("mock");
      expect(conv.messages[0].content).toBe("Injected");
    });
  });

  describe("default output path", () => {
    it("uses ~/.reins/conversations when no outputDir given", async () => {
      const written: Array<{ path: string; data: unknown }> = [];
      const mockFileOps = {
        async readFileText(): Promise<string> {
          return JSON.stringify(makeLine({ sessionId: "def", role: "user", content: "X" }));
        },
        async writeJson(path: string, data: unknown): Promise<void> {
          written.push({ path, data });
        },
        async exists(): Promise<boolean> {
          return false;
        },
      };

      const mapper = new ConversationMapper(undefined, mockFileOps);
      await mapper.map(["/fake/input.jsonl"]);

      expect(written).toHaveLength(1);
      expect(written[0].path).toContain(".reins");
      expect(written[0].path).toContain("conversations");
      expect(written[0].path).toContain("def.json");
    });
  });
});

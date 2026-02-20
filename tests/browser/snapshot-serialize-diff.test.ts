import { describe, expect, it } from "bun:test";

import { ElementRefRegistry } from "../../src/browser/element-ref-registry";
import { SnapshotEngine } from "../../src/browser/snapshot";
import type { ElementRef, Snapshot, SnapshotDiff } from "../../src/browser/types";

function makeSnapshot(nodes: ElementRef[]): Snapshot {
  return {
    tabId: "tab-1",
    url: "https://example.com",
    title: "Example",
    timestamp: Date.now(),
    nodes,
    format: "text",
    tokenCount: 0,
    truncated: false,
  };
}

function makeDiff(overrides: Partial<SnapshotDiff> = {}): SnapshotDiff {
  return {
    added: [],
    changed: [],
    removed: [],
    ...overrides,
  };
}

describe("SnapshotEngine.serializeDiff", () => {
  const engine = new SnapshotEngine(new ElementRefRegistry());

  describe("json format", () => {
    it("returns valid JSON representation of diff", () => {
      const diff = makeDiff({
        added: [{ ref: "e0", backendNodeId: 1, role: "button", name: "New", depth: 0 }],
        changed: [{ ref: "e1", backendNodeId: 2, role: "textbox", name: "Email", value: "b", depth: 0 }],
        removed: [{ ref: "e2", backendNodeId: 3, role: "link", name: "Old", depth: 0 }],
      });

      const output = engine.serializeDiff(diff, "json");
      const parsed = JSON.parse(output) as SnapshotDiff;

      expect(parsed.added).toHaveLength(1);
      expect(parsed.changed).toHaveLength(1);
      expect(parsed.removed).toHaveLength(1);
      expect(parsed.added[0]?.name).toBe("New");
    });
  });

  describe("text format", () => {
    it("produces added/changed/removed sections with + ~ - prefixes", () => {
      const diff = makeDiff({
        added: [{ ref: "e0", backendNodeId: 1, role: "button", name: "Save", depth: 0 }],
        changed: [{ ref: "e1", backendNodeId: 2, role: "textbox", name: "q", value: "new", depth: 1 }],
        removed: [{ ref: "e2", backendNodeId: 3, role: "link", name: "Gone", depth: 0 }],
      });

      const output = engine.serializeDiff(diff, "text");

      expect(output).toContain("added:");
      expect(output).toContain("+ ");
      expect(output).toContain("changed:");
      expect(output).toContain("~ ");
      expect(output).toContain("removed:");
      expect(output).toContain("- ");
      expect(output).toContain("button");
      expect(output).toContain("link");
    });

    it("shows (none) for empty sections", () => {
      const diff = makeDiff({
        added: [],
        changed: [],
        removed: [],
      });

      const output = engine.serializeDiff(diff, "text");

      expect(output).toContain("+ (none)");
      expect(output).toContain("~ (none)");
      expect(output).toContain("- (none)");
    });

    it("shows (none) only for empty sections, content for non-empty", () => {
      const diff = makeDiff({
        added: [{ ref: "e0", backendNodeId: 1, role: "button", name: "X", depth: 0 }],
        changed: [],
        removed: [],
      });

      const output = engine.serializeDiff(diff, "text");

      expect(output).not.toContain("+ (none)");
      expect(output).toContain("~ (none)");
      expect(output).toContain("- (none)");
    });
  });

  describe("compact format", () => {
    it("produces compact one-line-per-node output with prefixes", () => {
      const diff = makeDiff({
        added: [{ ref: "e0", backendNodeId: 1, role: "button", name: "Add", depth: 0 }],
        changed: [],
        removed: [{ ref: "e1", backendNodeId: 2, role: "link", name: "Del", depth: 0 }],
      });

      const output = engine.serializeDiff(diff, "compact");

      expect(output).toContain("added:");
      expect(output).toContain("removed:");
      expect(output).toContain("+ ");
      expect(output).toContain("- ");
    });
  });
});

import { describe, expect, it, mock } from "bun:test";

import { ElementRefRegistry } from "../../src/browser/element-ref-registry";
import { SnapshotEngine } from "../../src/browser/snapshot";
import type { CdpClient } from "../../src/browser/cdp-client";
import type { CdpAXNode, Snapshot } from "../../src/browser/types";

function makeMockCdpClient(getNodes: () => CdpAXNode[]): CdpClient {
  return {
    send: mock(async (method: string) => {
      if (method === "Accessibility.getFullAXTree") {
        return { nodes: getNodes() };
      }
      return {};
    }),
    on: mock(() => () => {}),
    isConnected: true,
  } as unknown as CdpClient;
}

function createBaseNodes(): CdpAXNode[] {
  return [
    {
      nodeId: 1,
      backendDOMNodeId: 11,
      ignored: false,
      role: { value: "RootWebArea" },
      name: { value: "Home Page" },
      childIds: [2, 3, 4, 5, 6, 7, 8, 9],
    },
    {
      nodeId: 2,
      backendDOMNodeId: 12,
      ignored: false,
      role: { value: "heading" },
      name: { value: "Home Page" },
    },
    {
      nodeId: 3,
      backendDOMNodeId: 13,
      ignored: false,
      role: { value: "link" },
      name: { value: "About Us" },
      properties: [{ name: "focused", value: { value: true } }],
    },
    {
      nodeId: 4,
      backendDOMNodeId: 14,
      ignored: false,
      role: { value: "button" },
      name: { value: "Sign In" },
      properties: [{ name: "disabled", value: { value: true } }],
    },
    {
      nodeId: 5,
      backendDOMNodeId: 15,
      ignored: false,
      role: { value: "textbox" },
      value: { value: "search term" },
    },
    {
      nodeId: 6,
      backendDOMNodeId: 16,
      ignored: false,
      role: { value: "generic" },
      name: { value: "Container" },
    },
    {
      nodeId: 7,
      backendDOMNodeId: 17,
      ignored: false,
      role: { value: "InlineTextBox" },
      name: { value: "Inline" },
    },
    {
      nodeId: 8,
      backendDOMNodeId: 18,
      ignored: false,
      role: { value: "StaticText" },
    },
    {
      nodeId: 9,
      backendDOMNodeId: 19,
      ignored: true,
      role: { value: "button" },
      name: { value: "Hidden" },
    },
    {
      nodeId: 10,
      backendDOMNodeId: 20,
      ignored: false,
      role: { value: "form" },
      name: { value: "Signup" },
    },
  ];
}

function makeSnapshot(nodes: Snapshot["nodes"]): Snapshot {
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

describe("SnapshotEngine", () => {
  describe("text format", () => {
    it("produces indented outline with correct depth", async () => {
      const registry = new ElementRefRegistry();
      let nodes = createBaseNodes();
      nodes[0] = {
        ...nodes[0],
        childIds: [2],
      };
      nodes[1] = {
        ...nodes[1],
        childIds: [3],
      };

      const engine = new SnapshotEngine(registry);
      const cdpClient = makeMockCdpClient(() => nodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
      });

      const output = engine.serializeSnapshot(snapshot, "text");
      expect(output).toContain('e0:RootWebArea "Home Page"');
      expect(output).toContain('  e1:heading "Home Page"');
      expect(output).toContain('    e2:link "About Us" [focused]');
    });

    it("includes name, value, focused, disabled markers", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
      });

      const output = engine.serializeSnapshot(snapshot, "text");
      expect(output).toContain('link "About Us" [focused]');
      expect(output).toContain('button "Sign In" [disabled]');
      expect(output).toContain('textbox val="search term"');
    });

    it("omits markers when not present", async () => {
      const nodes = createBaseNodes();
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(() => [nodes[0] as CdpAXNode, nodes[1] as CdpAXNode]);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
      });

      const output = engine.serializeSnapshot(snapshot, "text");
      expect(output).not.toContain("[focused]");
      expect(output).not.toContain("[disabled]");
    });
  });

  describe("compact format", () => {
    it("produces one-line-per-node output", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { format: "compact" },
      });

      const output = engine.serializeSnapshot(snapshot, "compact");
      const lines = output.split("\n");
      expect(lines.length).toBe(snapshot.nodes.length);
      expect(lines.every((line) => line.startsWith("e"))).toBe(true);
    });

    it("uses * for focused, - for disabled", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { format: "compact" },
      });

      const output = engine.serializeSnapshot(snapshot, "compact");
      expect(output).toContain('*');
      expect(output).toContain('-');
    });
  });

  describe("json format", () => {
    it("produces valid JSON with all ElementRef fields", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { format: "json" },
      });

      const output = engine.serializeSnapshot(snapshot, "json");
      const parsed = JSON.parse(output) as Array<Record<string, unknown>>;

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]).toHaveProperty("ref");
      expect(parsed[0]).toHaveProperty("backendNodeId");
      expect(parsed[0]).toHaveProperty("role");
      expect(parsed[0]).toHaveProperty("depth");
    });
  });

  describe("filters", () => {
    it("filter=interactive returns only interactive roles", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { filter: "interactive" },
      });

      expect(snapshot.nodes.every((node) => ["link", "button", "textbox"].includes(node.role))).toBe(true);
    });

    it("filter=forms returns only form-related roles", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { filter: "forms" },
      });

      expect(snapshot.nodes.map((node) => node.role).sort()).toEqual(["form", "textbox"]);
    });

    it("filter=none returns all non-ignored nodes", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { filter: "none" },
      });

      expect(snapshot.nodes.map((node) => node.role)).toEqual([
        "RootWebArea",
        "heading",
        "link",
        "button",
        "textbox",
        "form",
      ]);
    });

    it("interactive filter reduces node count significantly", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const noneSnapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { filter: "none" },
      });

      const interactiveSnapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { filter: "interactive" },
      });

      expect(interactiveSnapshot.nodes.length).toBeLessThan(noneSnapshot.nodes.length);
      expect(interactiveSnapshot.nodes.length / noneSnapshot.nodes.length).toBeLessThan(0.75);
    });
  });

  describe("diff mode", () => {
    it("diff=true with no previous snapshot returns all as added", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const diffSnapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { diff: true },
      });

      expect(diffSnapshot.nodes.length).toBeGreaterThan(0);
      expect(diffSnapshot.nodes.length).toBe(engine.getLastSnapshot("tab-1")?.nodes.length);
    });

    it("detects added nodes correctly", async () => {
      const registry = new ElementRefRegistry();
      const engine = new SnapshotEngine(registry);
      let nodes = createBaseNodes();
      const cdpClient = makeMockCdpClient(() => nodes);

      await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
      });

      nodes = [
        ...nodes,
        {
          nodeId: 22,
          backendDOMNodeId: 122,
          ignored: false,
          role: { value: "button" },
          name: { value: "New" },
        },
      ];

      const current = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
      });
      const prev = engine.getLastSnapshot("tab-1");
      const diff = engine.computeDiff(makeSnapshot(current.nodes.filter((n) => n.backendNodeId !== 122)), current);

      expect(diff.added.some((node) => node.backendNodeId === 122)).toBe(true);
      expect(prev).toBeDefined();
    });

    it("detects removed nodes correctly", () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());

      const prev = makeSnapshot([
        { ref: "e0", backendNodeId: 1, role: "button", depth: 0 },
        { ref: "e1", backendNodeId: 2, role: "link", depth: 0 },
      ]);
      const current = makeSnapshot([
        { ref: "e2", backendNodeId: 1, role: "button", depth: 0 },
      ]);

      const diff = engine.computeDiff(prev, current);

      expect(diff.removed).toHaveLength(1);
      expect(diff.removed[0]?.backendNodeId).toBe(2);
    });

    it("detects changed nodes (value changes)", () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());

      const prev = makeSnapshot([
        { ref: "e0", backendNodeId: 1, role: "textbox", name: "q", value: "a", depth: 0 },
      ]);
      const current = makeSnapshot([
        { ref: "e1", backendNodeId: 1, role: "textbox", name: "q", value: "b", depth: 0 },
      ]);

      const diff = engine.computeDiff(prev, current);

      expect(diff.changed).toHaveLength(1);
      expect(diff.changed[0]?.value).toBe("b");
    });

    it("unchanged nodes not in diff", () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());

      const prev = makeSnapshot([
        { ref: "e0", backendNodeId: 1, role: "button", name: "ok", depth: 0 },
      ]);
      const current = makeSnapshot([
        { ref: "e1", backendNodeId: 1, role: "button", name: "ok", depth: 0 },
      ]);

      const diff = engine.computeDiff(prev, current);

      expect(diff.added).toHaveLength(0);
      expect(diff.changed).toHaveLength(0);
      expect(diff.removed).toHaveLength(0);
    });
  });

  describe("maxTokens", () => {
    it("truncates output when over limit", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { maxTokens: 5 },
      });

      expect(snapshot.truncated).toBe(true);
      expect(snapshot.nodes.length).toBeLessThan(6);
    });

    it("appends [truncated] marker", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { maxTokens: 5 },
      });

      const output = engine.serializeSnapshot(snapshot, "text");
      expect(output.endsWith("[truncated]")).toBe(true);
    });

    it("sets truncated=true on snapshot", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { maxTokens: 2 },
      });

      expect(snapshot.truncated).toBe(true);
    });

    it("does not truncate when under limit", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        options: { maxTokens: 1000 },
      });

      expect(snapshot.truncated).toBe(false);
    });
  });

  describe("element ref assignment", () => {
    it("assigns e0, e1, e2... sequentially", async () => {
      const registry = new ElementRefRegistry();
      const engine = new SnapshotEngine(registry);
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
      });

      expect(snapshot.nodes[0]?.ref).toBe("e0");
      expect(snapshot.nodes[1]?.ref).toBe("e1");
      expect(snapshot.nodes[2]?.ref).toBe("e2");
    });

    it("refs stored in registry for later lookup", async () => {
      const registry = new ElementRefRegistry();
      const engine = new SnapshotEngine(registry);
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
      });

      const first = snapshot.nodes[0];
      expect(first).toBeDefined();
      expect(registry.lookupRef("tab-1", first?.ref ?? "")).toBe(first?.backendNodeId);
    });

    it("ignores nodes with ignored=true", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const cdpClient = makeMockCdpClient(createBaseNodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
      });

      expect(snapshot.nodes.some((node) => node.name === "Hidden")).toBe(false);
    });

    it("skips roles: none, generic, InlineTextBox", async () => {
      const engine = new SnapshotEngine(new ElementRefRegistry());
      const nodes = createBaseNodes();
      nodes.push({
        nodeId: 11,
        backendDOMNodeId: 21,
        ignored: false,
        role: { value: "none" },
      });
      const cdpClient = makeMockCdpClient(() => nodes);

      const snapshot = await engine.takeSnapshot({
        cdpClient,
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
      });

      const roles = snapshot.nodes.map((node) => node.role);
      expect(roles.includes("none")).toBe(false);
      expect(roles.includes("generic")).toBe(false);
      expect(roles.includes("InlineTextBox")).toBe(false);
    });
  });
});

describe("computeDiff", () => {
  it("returns added/changed/removed correctly", () => {
    const engine = new SnapshotEngine(new ElementRefRegistry());

    const prev = makeSnapshot([
      { ref: "e0", backendNodeId: 1, role: "button", name: "Save", depth: 0 },
      { ref: "e1", backendNodeId: 2, role: "textbox", name: "Email", value: "a", depth: 0 },
      { ref: "e2", backendNodeId: 3, role: "link", name: "Docs", depth: 0 },
    ]);
    const current = makeSnapshot([
      { ref: "e3", backendNodeId: 1, role: "button", name: "Save", depth: 0 },
      { ref: "e4", backendNodeId: 2, role: "textbox", name: "Email", value: "b", depth: 0 },
      { ref: "e5", backendNodeId: 4, role: "button", name: "New", depth: 0 },
    ]);

    const diff = engine.computeDiff(prev, current);

    expect(diff.added.map((node) => node.backendNodeId)).toEqual([4]);
    expect(diff.changed.map((node) => node.backendNodeId)).toEqual([2]);
    expect(diff.removed.map((node) => node.backendNodeId)).toEqual([3]);
  });

  it("returns empty diff for identical snapshots", () => {
    const engine = new SnapshotEngine(new ElementRefRegistry());
    const snapshot = makeSnapshot([
      { ref: "e0", backendNodeId: 1, role: "button", name: "Save", depth: 0 },
    ]);

    const diff = engine.computeDiff(snapshot, makeSnapshot([
      { ref: "e1", backendNodeId: 1, role: "button", name: "Save", depth: 0 },
    ]));

    expect(diff).toEqual({ added: [], changed: [], removed: [] });
  });

  it("handles all-added case", () => {
    const engine = new SnapshotEngine(new ElementRefRegistry());

    const diff = engine.computeDiff(
      makeSnapshot([]),
      makeSnapshot([
        { ref: "e0", backendNodeId: 1, role: "button", depth: 0 },
      ]),
    );

    expect(diff.added).toHaveLength(1);
    expect(diff.changed).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("handles all-removed case", () => {
    const engine = new SnapshotEngine(new ElementRefRegistry());

    const diff = engine.computeDiff(
      makeSnapshot([
        { ref: "e0", backendNodeId: 1, role: "button", depth: 0 },
      ]),
      makeSnapshot([]),
    );

    expect(diff.added).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.removed).toHaveLength(1);
  });
});

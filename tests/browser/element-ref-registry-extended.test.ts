import { describe, expect, it } from "bun:test";

import { ElementRefRegistry } from "../../src/browser/element-ref-registry";
import type { AccessibilityNode } from "../../src/browser/types";

function makeNode(overrides: Partial<AccessibilityNode> = {}): AccessibilityNode {
  return {
    nodeId: 1,
    backendDOMNodeId: 100,
    role: "button",
    name: "Save",
    depth: 0,
    ignored: false,
    ...overrides,
  };
}

describe("ElementRefRegistry._resetForTests", () => {
  it("resets ref counter and clears all tab data", () => {
    const registry = new ElementRefRegistry();

    // Assign refs for two tabs
    registry.assignRefs("tab-1", [
      makeNode({ nodeId: 1, backendDOMNodeId: 100 }),
      makeNode({ nodeId: 2, backendDOMNodeId: 101 }),
    ]);
    registry.assignRefs("tab-2", [
      makeNode({ nodeId: 3, backendDOMNodeId: 200 }),
    ]);

    expect(registry.lookupRef("tab-1", "e0")).toBe(100);
    expect(registry.lookupRef("tab-1", "e1")).toBe(101);
    expect(registry.lookupRef("tab-2", "e2")).toBe(200);

    // Reset
    registry._resetForTests();

    // After reset, old refs should not be found
    expect(registry.lookupRef("tab-1", "e0")).toBeUndefined();
    expect(registry.lookupRef("tab-2", "e2")).toBeUndefined();

    // New refs should start from e0 again
    const newRefs = registry.assignRefs("tab-1", [
      makeNode({ nodeId: 4, backendDOMNodeId: 300 }),
    ]);
    expect(newRefs[0]?.ref).toBe("e0");
    expect(registry.lookupRef("tab-1", "e0")).toBe(300);
  });
});

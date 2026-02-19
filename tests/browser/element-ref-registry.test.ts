import { describe, expect, it } from "bun:test";

import { ElementRefRegistry } from "../../src/browser/element-ref-registry";
import type { AccessibilityNode } from "../../src/browser/types";

function makeNode(id: number, role = "button"): AccessibilityNode {
  return {
    nodeId: id,
    backendDOMNodeId: 1000 + id,
    role,
    depth: 0,
    ignored: false,
  };
}

describe("ElementRefRegistry", () => {
  it("assigns monotonically increasing refs starting at e0", () => {
    const registry = new ElementRefRegistry();

    const refs = registry.assignRefs("tab-a", [makeNode(1), makeNode(2)]);

    expect(refs.map((ref) => ref.ref)).toEqual(["e0", "e1"]);
  });

  it("never reuses refs even after clearTab()", () => {
    const registry = new ElementRefRegistry();

    registry.assignRefs("tab-a", [makeNode(1), makeNode(2)]);
    registry.clearTab("tab-a");
    const refs = registry.assignRefs("tab-a", [makeNode(3)]);

    expect(refs[0]?.ref).toBe("e2");
  });

  it("lookupRef returns correct backendNodeId", () => {
    const registry = new ElementRefRegistry();

    registry.assignRefs("tab-a", [makeNode(1)]);

    expect(registry.lookupRef("tab-a", "e0")).toBe(1001);
  });

  it("lookupRef returns undefined for unknown ref", () => {
    const registry = new ElementRefRegistry();

    registry.assignRefs("tab-a", [makeNode(1)]);

    expect(registry.lookupRef("tab-a", "e999")).toBeUndefined();
  });

  it("clearTab removes tab refs but keeps counter", () => {
    const registry = new ElementRefRegistry();

    registry.assignRefs("tab-a", [makeNode(1)]);
    registry.clearTab("tab-a");

    expect(registry.lookupRef("tab-a", "e0")).toBeUndefined();

    const refs = registry.assignRefs("tab-b", [makeNode(2)]);
    expect(refs[0]?.ref).toBe("e1");
  });

  it("assigns new refs starting after previous counter when tab cleared and re-added", () => {
    const registry = new ElementRefRegistry();

    registry.assignRefs("tab-a", [makeNode(1), makeNode(2), makeNode(3)]);
    registry.clearTab("tab-a");
    const refs = registry.assignRefs("tab-a", [makeNode(4), makeNode(5)]);

    expect(refs.map((ref) => ref.ref)).toEqual(["e3", "e4"]);
  });

  it("handles multiple tabs independently", () => {
    const registry = new ElementRefRegistry();

    registry.assignRefs("tab-a", [makeNode(1), makeNode(2)]);
    registry.assignRefs("tab-b", [makeNode(3)]);

    expect(registry.lookupRef("tab-a", "e0")).toBe(1001);
    expect(registry.lookupRef("tab-a", "e1")).toBe(1002);
    expect(registry.lookupRef("tab-b", "e2")).toBe(1003);
    expect(registry.lookupRef("tab-b", "e1")).toBeUndefined();
  });

  it("lookupRefInfo returns full element metadata", () => {
    const registry = new ElementRefRegistry();

    registry.assignRefs("tab-a", [
      {
        ...makeNode(1, "textbox"),
        name: "Search",
        value: "hello",
        focused: true,
      },
    ]);

    expect(registry.lookupRefInfo("tab-a", "e0")).toEqual({
      ref: "e0",
      backendNodeId: 1001,
      role: "textbox",
      name: "Search",
      value: "hello",
      depth: 0,
      focused: true,
      disabled: undefined,
    });
  });
});

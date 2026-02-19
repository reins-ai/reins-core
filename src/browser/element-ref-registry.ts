import type { AccessibilityNode, ElementRef } from "./types";

export class ElementRefRegistry {
  private nextRefId = 0;
  private readonly tabRefs = new Map<string, Map<string, number>>();
  private readonly tabRefInfo = new Map<string, Map<string, ElementRef>>();

  assignRefs(tabId: string, nodes: AccessibilityNode[]): ElementRef[] {
    const refsForTab = new Map<string, number>();
    const refInfoForTab = new Map<string, ElementRef>();
    const elementRefs: ElementRef[] = [];

    for (const node of nodes) {
      const ref = `e${this.nextRefId}`;
      this.nextRefId += 1;

      const elementRef: ElementRef = {
        ref,
        backendNodeId: node.backendDOMNodeId,
        role: node.role,
        name: node.name,
        value: node.value,
        depth: node.depth,
        focused: node.focused,
        disabled: node.disabled,
      };

      refsForTab.set(ref, node.backendDOMNodeId);
      refInfoForTab.set(ref, elementRef);
      elementRefs.push(elementRef);
    }

    this.tabRefs.set(tabId, refsForTab);
    this.tabRefInfo.set(tabId, refInfoForTab);

    return elementRefs;
  }

  lookupRef(tabId: string, ref: string): number | undefined {
    return this.tabRefs.get(tabId)?.get(ref);
  }

  lookupRefInfo(tabId: string, ref: string): ElementRef | undefined {
    return this.tabRefInfo.get(tabId)?.get(ref);
  }

  clearTab(tabId: string): void {
    this.tabRefs.delete(tabId);
    this.tabRefInfo.delete(tabId);
  }

  _resetForTests(): void {
    this.nextRefId = 0;
    this.tabRefs.clear();
    this.tabRefInfo.clear();
  }
}

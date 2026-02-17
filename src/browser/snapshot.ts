import type { CdpClient } from "./cdp-client";
import type { ElementRefRegistry } from "./element-ref-registry";
import type {
  AccessibilityNode,
  CdpAXNode,
  ElementRef,
  GetFullAXTreeResult,
  Snapshot,
  SnapshotDiff,
  SnapshotFilter,
  SnapshotFormat,
} from "./types";

const EXCLUDED_ROLES = new Set(["none", "generic", "InlineTextBox"]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "spinbutton",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "slider",
  "switch",
]);

const FORMS_ROLES = new Set([
  "form",
  "textbox",
  "searchbox",
  "spinbutton",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "select",
  "option",
  "group",
  "radiogroup",
]);

export interface SnapshotOptions {
  format?: SnapshotFormat;
  filter?: SnapshotFilter;
  diff?: boolean;
  maxTokens?: number;
}

export interface TakeSnapshotParams {
  cdpClient: CdpClient;
  tabId: string;
  url: string;
  title: string;
  options?: SnapshotOptions;
  sessionId?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }

  return undefined;
}

function nodeKey(node: ElementRef): string {
  return `${node.role}:${node.name ?? ""}:${node.backendNodeId}`;
}

function quote(value: string): string {
  return value.replace(/"/g, '\\"');
}

function formatNodeText(node: ElementRef): string {
  const indent = "  ".repeat(node.depth);
  const parts = [`${indent}${node.ref}:${node.role}`];
  if (node.name !== undefined && node.name.length > 0) {
    parts.push(`"${quote(node.name)}"`);
  }
  if (node.value !== undefined && node.value.length > 0) {
    parts.push(`val="${quote(node.value)}"`);
  }
  if (node.focused) {
    parts.push("[focused]");
  }
  if (node.disabled) {
    parts.push("[disabled]");
  }
  return parts.join(" ");
}

function formatNodeCompact(node: ElementRef): string {
  const parts = [`${node.ref}:${node.role}`];
  if (node.name !== undefined && node.name.length > 0) {
    parts.push(`"${quote(node.name)}"`);
  }
  if (node.value !== undefined && node.value.length > 0) {
    parts.push(`val="${quote(node.value)}"`);
  }
  if (node.focused) {
    parts.push("*");
  }
  if (node.disabled) {
    parts.push("-");
  }
  return parts.join(" ");
}

function estimateTokensForText(text: string, format: SnapshotFormat): number {
  const divisor = format === "json" ? 3 : 4;
  return Math.ceil(new TextEncoder().encode(text).length / divisor);
}

export class SnapshotEngine {
  private readonly elementRefRegistry: ElementRefRegistry;
  private readonly lastSnapshots = new Map<string, Snapshot>();

  constructor(elementRefRegistry: ElementRefRegistry) {
    this.elementRefRegistry = elementRefRegistry;
  }

  async takeSnapshot(params: TakeSnapshotParams): Promise<Snapshot> {
    const format = params.options?.format ?? "text";
    const filter = params.options?.filter ?? "none";
    const diff = params.options?.diff ?? false;
    const maxTokens = params.options?.maxTokens;

    const result = await params.cdpClient.send<GetFullAXTreeResult>(
      "Accessibility.getFullAXTree",
      undefined,
      params.sessionId,
    );

    const parsedNodes = this.parseAXNodes(result.nodes);
    const filteredNodes = this.applyFilter(parsedNodes, filter);
    const elementRefs = this.elementRefRegistry.assignRefs(params.tabId, filteredNodes);
    const { nodes, tokenCount, truncated } = this.applyTokenLimit(elementRefs, format, maxTokens);

    const fullSnapshot: Snapshot = {
      tabId: params.tabId,
      url: params.url,
      title: params.title,
      timestamp: Date.now(),
      nodes,
      format,
      tokenCount,
      truncated,
    };

    const previous = this.lastSnapshots.get(params.tabId);
    this.lastSnapshots.set(params.tabId, fullSnapshot);

    if (!diff) {
      return fullSnapshot;
    }

    const diffResult = previous
      ? this.computeDiff(previous, fullSnapshot)
      : {
          added: [...fullSnapshot.nodes],
          changed: [],
          removed: [],
        };

    return {
      ...fullSnapshot,
      nodes: [
        ...diffResult.added,
        ...diffResult.changed,
        ...diffResult.removed,
      ],
    };
  }

  getLastSnapshot(tabId: string): Snapshot | undefined {
    return this.lastSnapshots.get(tabId);
  }

  computeDiff(prev: Snapshot, current: Snapshot): SnapshotDiff {
    const prevByKey = new Map<string, ElementRef>();
    const currentByKey = new Map<string, ElementRef>();

    for (const node of prev.nodes) {
      prevByKey.set(nodeKey(node), node);
    }
    for (const node of current.nodes) {
      currentByKey.set(nodeKey(node), node);
    }

    const added: ElementRef[] = [];
    const changed: ElementRef[] = [];
    const removed: ElementRef[] = [];

    for (const [key, node] of currentByKey) {
      const prevNode = prevByKey.get(key);
      if (prevNode === undefined) {
        added.push(node);
        continue;
      }

      if (
        prevNode.value !== node.value
        || prevNode.focused !== node.focused
        || prevNode.disabled !== node.disabled
      ) {
        changed.push(node);
      }
    }

    for (const [key, node] of prevByKey) {
      if (!currentByKey.has(key)) {
        removed.push(node);
      }
    }

    return { added, changed, removed };
  }

  serializeSnapshot(snapshot: Snapshot, format: SnapshotFormat): string {
    let body: string;

    if (format === "json") {
      body = JSON.stringify(snapshot.nodes, null, 2);
    } else if (format === "compact") {
      body = snapshot.nodes.map((node) => formatNodeCompact(node)).join("\n");
    } else {
      body = snapshot.nodes.map((node) => formatNodeText(node)).join("\n");
    }

    if (!snapshot.truncated) {
      return body;
    }

    if (body.length === 0) {
      return "[truncated]";
    }

    return `${body}\n[truncated]`;
  }

  serializeDiff(diff: SnapshotDiff, format: SnapshotFormat): string {
    if (format === "json") {
      return JSON.stringify(diff, null, 2);
    }

    const sections: string[] = [];
    const formatter = format === "compact" ? formatNodeCompact : formatNodeText;

    sections.push("added:");
    sections.push(...(diff.added.length > 0
      ? diff.added.map((node) => `+ ${formatter(node)}`)
      : ["+ (none)"]));

    sections.push("changed:");
    sections.push(...(diff.changed.length > 0
      ? diff.changed.map((node) => `~ ${formatter(node)}`)
      : ["~ (none)"]));

    sections.push("removed:");
    sections.push(...(diff.removed.length > 0
      ? diff.removed.map((node) => `- ${formatter(node)}`)
      : ["- (none)"]));

    return sections.join("\n");
  }

  private parseAXNodes(nodes: CdpAXNode[]): AccessibilityNode[] {
    const byNodeId = new Map<number, CdpAXNode>();
    const childNodeIds = new Set<number>();

    for (const node of nodes) {
      byNodeId.set(node.nodeId, node);
      for (const childId of node.childIds ?? []) {
        childNodeIds.add(childId);
      }
    }

    const depthByNodeId = new Map<number, number>();
    const roots = nodes.filter((node) => !childNodeIds.has(node.nodeId));
    const queue: Array<{ nodeId: number; depth: number }> = roots.length > 0
      ? roots.map((node) => ({ nodeId: node.nodeId, depth: 0 }))
      : nodes.slice(0, 1).map((node) => ({ nodeId: node.nodeId, depth: 0 }));

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        continue;
      }

      const existingDepth = depthByNodeId.get(current.nodeId);
      if (existingDepth !== undefined && existingDepth <= current.depth) {
        continue;
      }

      depthByNodeId.set(current.nodeId, current.depth);
      const node = byNodeId.get(current.nodeId);
      if (node === undefined) {
        continue;
      }

      for (const childId of node.childIds ?? []) {
        queue.push({ nodeId: childId, depth: current.depth + 1 });
      }
    }

    return nodes.map((node) => {
      const focused = this.getPropertyBoolean(node, "focused");
      const disabled = this.getPropertyBoolean(node, "disabled");
      return {
        nodeId: node.nodeId,
        backendDOMNodeId: node.backendDOMNodeId,
        role: asString(node.role?.value) ?? "unknown",
        name: asString(node.name?.value),
        value: asString(node.value?.value),
        description: asString(node.description?.value),
        depth: depthByNodeId.get(node.nodeId) ?? 0,
        ignored: node.ignored,
        focused,
        disabled,
        childIds: node.childIds,
      };
    });
  }

  private applyFilter(nodes: AccessibilityNode[], filter: SnapshotFilter): AccessibilityNode[] {
    return nodes.filter((node) => {
      if (node.ignored) {
        return false;
      }

      if (EXCLUDED_ROLES.has(node.role)) {
        return false;
      }

      if (node.role === "StaticText" && !node.name && !node.value) {
        return false;
      }

      if (filter === "interactive") {
        return INTERACTIVE_ROLES.has(node.role);
      }

      if (filter === "forms") {
        return FORMS_ROLES.has(node.role);
      }

      return true;
    });
  }

  private getPropertyBoolean(node: CdpAXNode, propertyName: string): boolean | undefined {
    const property = node.properties?.find((entry) => entry.name === propertyName);
    if (property === undefined) {
      return undefined;
    }

    return asBoolean(property.value.value);
  }

  private applyTokenLimit(
    nodes: ElementRef[],
    format: SnapshotFormat,
    maxTokens?: number,
  ): { nodes: ElementRef[]; tokenCount: number; truncated: boolean } {
    if (maxTokens === undefined || maxTokens <= 0) {
      return {
        nodes,
        tokenCount: estimateTokensForText(this.serializeNodes(nodes, format), format),
        truncated: false,
      };
    }

    const accepted: ElementRef[] = [];
    let tokenCount = 0;
    let truncated = false;

    for (const node of nodes) {
      const nextCount = tokenCount + estimateTokensForText(this.serializeNode(node, format), format);
      if (nextCount > maxTokens) {
        truncated = true;
        break;
      }

      accepted.push(node);
      tokenCount = nextCount;
    }

    if (truncated) {
      tokenCount += estimateTokensForText("[truncated]", format);
    }

    return {
      nodes: accepted,
      tokenCount,
      truncated,
    };
  }

  private serializeNodes(nodes: ElementRef[], format: SnapshotFormat): string {
    if (format === "json") {
      return JSON.stringify(nodes);
    }

    if (format === "compact") {
      return nodes.map((node) => formatNodeCompact(node)).join("\n");
    }

    return nodes.map((node) => formatNodeText(node)).join("\n");
  }

  private serializeNode(node: ElementRef, format: SnapshotFormat): string {
    if (format === "json") {
      return JSON.stringify(node);
    }

    if (format === "compact") {
      return formatNodeCompact(node);
    }

    return formatNodeText(node);
  }
}

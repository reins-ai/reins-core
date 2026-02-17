export interface CdpCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpResponse {
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
}

export type CdpMethod =
  | "Page.enable"
  | "Page.navigate"
  | "Page.reload"
  | "Page.captureScreenshot"
  | "Page.addScriptToEvaluateOnNewDocument"
  | "Target.getTargets"
  | "Target.createTarget"
  | "Target.closeTarget"
  | "Target.activateTarget"
  | "Target.attachToTarget"
  | "Accessibility.getFullAXTree"
  | "DOM.getDocument"
  | "DOM.querySelector"
  | "DOM.resolveNode"
  | "DOM.focus"
  | "DOM.getBoxModel"
  | "Runtime.evaluate"
  | "Runtime.callFunctionOn"
  | "Input.dispatchMouseEvent"
  | "Input.dispatchKeyEvent";

export interface CdpTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
}

export interface CdpAXValue {
  value: unknown;
}

export interface CdpAXProperty {
  name: string;
  value: CdpAXValue;
}

export interface CdpAXNode {
  nodeId: number;
  backendDOMNodeId: number;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  description?: { value: string };
  properties?: CdpAXProperty[];
  childIds?: number[];
}

export interface NavigateResult {
  frameId: string;
  loaderId?: string;
  errorText?: string;
}

export interface CaptureScreenshotResult {
  data: string;
}

export interface GetTargetsResult {
  targetInfos: CdpTargetInfo[];
}

export interface CreateTargetResult {
  targetId: string;
}

export interface CloseTargetResult {
  success: boolean;
}

export interface AttachToTargetResult {
  sessionId: string;
}

export interface GetFullAXTreeResult {
  nodes: CdpAXNode[];
}

export interface GetDocumentResult {
  root: {
    nodeId: number;
    backendNodeId: number;
    nodeName: string;
    localName: string;
    nodeType: number;
    childNodeCount?: number;
  };
}

export interface QuerySelectorResult {
  nodeId: number;
}

export interface ResolveNodeResult {
  object: {
    type: string;
    className?: string;
    description?: string;
    objectId?: string;
  };
}

export interface EvaluateResult {
  result: {
    type: string;
    subtype?: string;
    value?: unknown;
    description?: string;
    objectId?: string;
  };
  exceptionDetails?: {
    text: string;
    lineNumber: number;
    columnNumber: number;
    stackTrace?: {
      description?: string;
    };
  };
}

export interface GetBoxModelResult {
  model: {
    width: number;
    height: number;
    content: number[];
    padding: number[];
    border: number[];
    margin: number[];
  };
}

export type BrowserAction =
  | "navigate"
  | "new_tab"
  | "close_tab"
  | "list_tabs"
  | "switch_tab"
  | "status";

export interface BrowserNavigateArgs {
  action: "navigate";
  url: string;
  waitUntil?: "load" | "networkIdle";
}

export interface BrowserNewTabArgs {
  action: "new_tab";
  url?: string;
}

export interface BrowserCloseTabArgs {
  action: "close_tab";
  tabId?: string;
}

export interface BrowserListTabsArgs {
  action: "list_tabs";
}

export interface BrowserSwitchTabArgs {
  action: "switch_tab";
  tabId: string;
}

export interface BrowserStatusArgs {
  action: "status";
}

export type BrowserArgs =
  | BrowserNavigateArgs
  | BrowserNewTabArgs
  | BrowserCloseTabArgs
  | BrowserListTabsArgs
  | BrowserSwitchTabArgs
  | BrowserStatusArgs;

export type SnapshotFormat = "text" | "compact" | "json";

export type SnapshotFilter = "interactive" | "forms" | "none";

export interface BrowserSnapshotArgs {
  format?: SnapshotFormat;
  filter?: SnapshotFilter;
  diff?: boolean;
  maxTokens?: number;
}

export type BrowserActAction =
  | "click"
  | "type"
  | "fill"
  | "select"
  | "scroll"
  | "hover"
  | "press_key"
  | "evaluate"
  | "screenshot"
  | "watch"
  | "unwatch"
  | "list_watchers";

export interface BrowserClickArgs {
  action: "click";
  ref: string;
}

export interface BrowserTypeArgs {
  action: "type";
  ref: string;
  text: string;
  clear?: boolean;
}

export interface BrowserFillArgs {
  action: "fill";
  ref: string;
  value: string;
}

export interface BrowserSelectArgs {
  action: "select";
  ref: string;
  value: string;
}

export interface BrowserScrollArgs {
  action: "scroll";
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
}

export interface BrowserHoverArgs {
  action: "hover";
  ref: string;
}

export interface BrowserPressKeyArgs {
  action: "press_key";
  key: string;
  modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
}

export interface BrowserEvaluateArgs {
  action: "evaluate";
  script: string;
  awaitPromise?: boolean;
}

export interface BrowserScreenshotArgs {
  action: "screenshot";
  quality?: number;
  output?: "inline" | "file";
}

export interface BrowserWatchArgs {
  action: "watch";
  url: string;
  interval: string;
  maxTokens?: number;
}

export interface BrowserUnwatchArgs {
  action: "unwatch";
  watcherId: string;
}

export interface BrowserListWatchersArgs {
  action: "list_watchers";
}

export type BrowserActArgs =
  | BrowserClickArgs
  | BrowserTypeArgs
  | BrowserFillArgs
  | BrowserSelectArgs
  | BrowserScrollArgs
  | BrowserHoverArgs
  | BrowserPressKeyArgs
  | BrowserEvaluateArgs
  | BrowserScreenshotArgs
  | BrowserWatchArgs
  | BrowserUnwatchArgs
  | BrowserListWatchersArgs;

export interface ElementRef {
  ref: string;
  backendNodeId: number;
  role: string;
  name?: string;
  value?: string;
  depth: number;
  focused?: boolean;
  disabled?: boolean;
}

export interface AccessibilityNode {
  nodeId: number;
  backendDOMNodeId: number;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  depth: number;
  ignored: boolean;
  focused?: boolean;
  disabled?: boolean;
  childIds?: number[];
}

export interface Snapshot {
  tabId: string;
  url: string;
  title: string;
  timestamp: number;
  nodes: ElementRef[];
  format: SnapshotFormat;
  tokenCount: number;
  truncated: boolean;
}

export interface SnapshotDiff {
  added: ElementRef[];
  changed: ElementRef[];
  removed: ElementRef[];
}

export type WatcherStatus = "active" | "paused" | "failed";

export interface WatcherConfig {
  id: string;
  url: string;
  interval: string;
  maxTokens?: number;
}

export interface WatcherState extends WatcherConfig {
  status: WatcherStatus;
  createdAt: number;
  lastCheckedAt?: number;
  baselineSnapshot?: Snapshot;
  lastDiff?: SnapshotDiff;
  cronJobId?: string;
}

export interface WatcherDiff {
  watcherId: string;
  url: string;
  diff: SnapshotDiff;
  checkedAt: number;
}

export interface WatcherNotification {
  watcherId: string;
  url: string;
  summary: string;
  addedCount: number;
  changedCount: number;
  removedCount: number;
  compactDiff: string;
  timestamp: number;
}

export interface ChromeInfo {
  pid: number;
  port: number;
  webSocketDebuggerUrl: string;
  startedAt: number;
}

export interface BrowserConfig {
  profilePath: string;
  port: number;
  headless: boolean;
  maxWatchers: number;
  binaryPath?: string;
}

export interface TabInfo {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserStatus {
  running: boolean;
  chrome?: ChromeInfo;
  tabs: TabInfo[];
  activeTabId?: string;
  profilePath: string;
  headless: boolean;
  memoryUsageMb?: number;
}

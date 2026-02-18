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
  | "Input.dispatchKeyEvent"
  | "Network.getCookies"
  | "Network.setCookie"
  | "Network.clearBrowserCookies"
  | "Runtime.enable"
  | "Console.enable"
  | "Network.enable"
  | "Page.frameNavigated";

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
  | "list_watchers"
  | "wait"
  | "batch"
  | "get_cookies"
  | "set_cookie"
  | "clear_cookies"
  | "get_storage"
  | "set_storage"
  | "clear_storage";

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

// --- Wait primitive types ---

export type WaitCondition = "ref_visible" | "ref_present" | "text_present" | "load_state";

export type LoadState = "complete" | "interactive";

export interface BrowserWaitArgs {
  action: "wait";
  condition: WaitCondition;
  ref?: string;
  text?: string;
  state?: LoadState;
  timeout?: number;
}

// --- Batch action types ---

export interface BrowserBatchArgs {
  action: "batch";
  actions: Array<
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
    | BrowserListWatchersArgs
    | BrowserWaitArgs
    | BrowserGetCookiesArgs
    | BrowserSetCookieArgs
    | BrowserClearCookiesArgs
    | BrowserGetStorageArgs
    | BrowserSetStorageArgs
    | BrowserClearStorageArgs
  >;
}

export interface BatchActionResult {
  completedCount: number;
  results: unknown[];
  error?: {
    step: number;
    message: string;
    code: string;
  };
}

// --- Cookie and storage types ---

export type StorageType = "local" | "session";

export interface BrowserGetCookiesArgs {
  action: "get_cookies";
}

export interface BrowserSetCookieArgs {
  action: "set_cookie";
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface BrowserClearCookiesArgs {
  action: "clear_cookies";
}

export interface BrowserGetStorageArgs {
  action: "get_storage";
  storageType?: StorageType;
}

export interface BrowserSetStorageArgs {
  action: "set_storage";
  key: string;
  value: string;
  storageType?: StorageType;
}

export interface BrowserClearStorageArgs {
  action: "clear_storage";
  storageType?: StorageType;
}

// --- Debug tool types ---

export type DebugAction = "console" | "errors" | "network" | "all";

export interface BrowserDebugArgs {
  action: DebugAction;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: number;
}

export interface PageError {
  message: string;
  stack?: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  failed: boolean;
}

export interface DebugSnapshot {
  console?: ConsoleEntry[];
  errors?: PageError[];
  network?: NetworkEntry[];
}

// --- Humanized interaction types ---

export interface HumanizeConfig {
  minDelay: number;
  maxDelay: number;
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
  | BrowserListWatchersArgs
  | BrowserWaitArgs
  | BrowserBatchArgs
  | BrowserGetCookiesArgs
  | BrowserSetCookieArgs
  | BrowserClearCookiesArgs
  | BrowserGetStorageArgs
  | BrowserSetStorageArgs
  | BrowserClearStorageArgs;

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

export type WatcherStatus = "active" | "paused" | "error";

export interface WatcherConfig {
  id: string;
  url: string;
  intervalSeconds: number;
  format: SnapshotFormat;
  filter: SnapshotFilter;
  maxTokens?: number;
  createdAt: number;
}

export interface WatcherDiff {
  added: string[];
  changed: string[];
  removed: string[];
  timestamp: number;
  hasChanges: boolean;
}

export interface WatcherState {
  config: WatcherConfig;
  status: WatcherStatus;
  baselineSnapshot?: string;
  lastDiff?: WatcherDiff;
  lastCheckedAt?: number;
  lastError?: string;
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
  screenshotDir?: string;
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

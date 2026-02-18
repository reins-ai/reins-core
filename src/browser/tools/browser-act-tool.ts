import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  BrowserError,
  CdpError,
  ElementNotFoundError,
} from "../errors";
import type { BrowserDaemonService } from "../browser-daemon-service";
import type { CdpClient } from "../cdp-client";
import type { ElementRefRegistry } from "../element-ref-registry";
import type { WatcherCronManager } from "../watcher-cron-manager";
import type {
  AttachToTargetResult,
  BatchActionResult,
  CaptureScreenshotResult,
  CdpTargetInfo,
  EvaluateResult,
  GetBoxModelResult,
  GetTargetsResult,
  ResolveNodeResult,
  SnapshotFilter,
  SnapshotFormat,
} from "../types";
import type {
  Tool,
  ToolContext,
  ToolDefinition,
  ToolErrorDetail,
  ToolResult,
} from "../../types";

type SupportedBrowserActAction =
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

export interface BrowserActToolOptions {
  screenshotDir?: string;
  mkdirFn?: typeof mkdir;
  writeFileFn?: typeof writeFile;
  watcherManager?: WatcherCronManager;
}

export class BrowserActTool implements Tool {
  readonly definition: ToolDefinition = {
    name: "browser_act",
    description:
      "Interact with page elements using element refs from browser_snapshot. Supports click, type, fill, select, scroll, hover, press_key, evaluate, screenshot, watch, unwatch, list_watchers, wait, batch, and cookie/storage actions.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["click", "type", "fill", "select", "scroll", "hover", "press_key", "evaluate", "screenshot", "watch", "unwatch", "list_watchers", "wait", "batch", "get_cookies", "set_cookie", "clear_cookies", "get_storage", "set_storage", "clear_storage"],
          description: "Interaction action to perform.",
        },
        ref: {
          type: "string",
          description:
            "Element ref from browser_snapshot (e.g., 'e0', 'e5'). Required for click, type, fill, select, hover.",
        },
        text: {
          type: "string",
          description: "Text to type character by character (for type action).",
        },
        value: {
          type: "string",
          description: "Value to set (for fill and select actions).",
        },
        clear: {
          type: "boolean",
          description: "Clear existing value before typing (for type action). Default: false.",
        },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction (for scroll action). Default: down.",
        },
        amount: {
          type: "number",
          description: "Scroll amount in pixels (for scroll action). Default: 300.",
        },
        key: {
          type: "string",
          description:
            "Key name to press (for press_key). Examples: 'Enter', 'Escape', 'Tab', 'ArrowDown', 'a', 'F5'.",
        },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
          description: "Modifier keys to hold while pressing key.",
        },
        script: {
          type: "string",
          description:
            "JavaScript expression to evaluate in the page context (for evaluate action).",
        },
        awaitPromise: {
          type: "boolean",
          description:
            "Whether to await a Promise returned by the script (for evaluate action).",
        },
        quality: {
          type: "number",
          description:
            "JPEG quality for screenshot (0–100, default 80).",
        },
        output: {
          type: "string",
          enum: ["inline", "file"],
          description:
            "Screenshot output mode. 'inline' (default) returns base64 JPEG. 'file' saves to disk and returns path.",
        },
        url: {
          type: "string",
          description: "URL to watch for changes (for watch action).",
        },
        intervalSeconds: {
          type: "number",
          description: "Check interval in seconds (for watch action, default 300, minimum 60).",
        },
        format: {
          type: "string",
          enum: ["text", "compact", "json"],
          description: "Snapshot format for watcher (for watch action, default 'compact').",
        },
        filter: {
          type: "string",
          enum: ["interactive", "forms", "none"],
          description: "Snapshot filter for watcher (for watch action, default 'interactive').",
        },
        maxTokens: {
          type: "number",
          description: "Max tokens for watcher snapshots (for watch action).",
        },
        watcherId: {
          type: "string",
          description: "Watcher ID to remove (for unwatch action).",
        },
        condition: {
          type: "string",
          enum: ["ref_visible", "ref_present", "text_present", "load_state"],
          description: "Condition to wait for (for wait action).",
        },
        state: {
          type: "string",
          enum: ["complete", "interactive"],
          description: "Page load state to wait for (for wait action with load_state condition).",
        },
        timeout: {
          type: "number",
          description: "Maximum wait time in milliseconds (for wait action). Default: 5000.",
        },
        actions: {
          type: "array",
          items: { type: "object", description: "A single browser_act action object with an 'action' field." },
          description: "Array of actions to execute sequentially (for batch action). Each item follows the same schema as a single browser_act call.",
        },
        name: {
          type: "string",
          description: "Cookie name (for set_cookie action).",
        },
        domain: {
          type: "string",
          description: "Cookie domain (for set_cookie action).",
        },
        path: {
          type: "string",
          description: "Cookie path (for set_cookie action).",
        },
        storageType: {
          type: "string",
          enum: ["local", "session"],
          description: "Storage type for get_storage, set_storage, clear_storage actions. Default: local.",
        },
      },
      required: ["action"],
    },
  };

  private readonly screenshotDir: string;
  private readonly mkdirFn: typeof mkdir;
  private readonly writeFileFn: typeof writeFile;
  private readonly watcherManager?: WatcherCronManager;

  constructor(
    private readonly service: BrowserDaemonService,
    private readonly elementRefRegistry: ElementRefRegistry,
    options: BrowserActToolOptions = {},
  ) {
    this.screenshotDir = options.screenshotDir
      ?? process.env.REINS_BROWSER_SCREENSHOTS?.trim()
      ?? join(homedir(), ".reins", "browser", "screenshots");
    this.mkdirFn = options.mkdirFn ?? mkdir;
    this.writeFileFn = options.writeFileFn ?? writeFile;
    this.watcherManager = options.watcherManager;
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const callId = typeof args.callId === "string" ? args.callId : "unknown-call";

    try {
      const result = await this.executeAction(args);
      return this.success(callId, result);
    } catch (error) {
      return this.toErrorResult(callId, error);
    }
  }

  private async executeAction(args: Record<string, unknown>): Promise<unknown> {
    const action = this.readAction(args.action);
    if (!action) {
      throw new BrowserError("Missing or invalid 'action' argument.");
    }

    switch (action) {
      case "click":
        return await this.click(this.requireString(args.ref, "'ref' is required for click action."));
      case "type":
        return await this.type(
          this.requireString(args.ref, "'ref' is required for type action."),
          this.requireString(args.text, "'text' is required for type action."),
          typeof args.clear === "boolean" ? args.clear : false,
        );
      case "fill":
        return await this.fill(
          this.requireString(args.ref, "'ref' is required for fill action."),
          this.requireString(args.value, "'value' is required for fill action."),
        );
      case "select":
        return await this.select(
          this.requireString(args.ref, "'ref' is required for select action."),
          this.requireString(args.value, "'value' is required for select action."),
        );
      case "scroll":
        return await this.scroll(
          this.readDirection(args.direction),
          typeof args.amount === "number" && Number.isFinite(args.amount) ? args.amount : undefined,
        );
      case "hover":
        return await this.hover(this.requireString(args.ref, "'ref' is required for hover action."));
      case "press_key":
        return await this.pressKeyAction(
          this.requireString(args.key, "'key' is required for press_key action."),
          this.readModifiers(args.modifiers),
        );
      case "evaluate":
        return await this.evaluate(
          this.requireString(args.script, "'script' is required for evaluate action."),
          typeof args.awaitPromise === "boolean" ? args.awaitPromise : false,
        );
      case "screenshot":
        return await this.screenshot(
          this.readQuality(args.quality),
          this.readOutput(args.output),
        );
      case "watch":
        return await this.watch(args);
      case "unwatch":
        return await this.unwatch(this.requireString(args.watcherId, "'watcherId' is required for unwatch action."));
      case "list_watchers":
        return this.listWatchers();
      case "wait":
        return await this.wait(args);
      case "batch":
        return await this.executeBatch(args);
      case "get_cookies":
        return await this.getCookies();
      case "set_cookie":
        return await this.setCookie(args);
      case "clear_cookies":
        return await this.clearCookies();
      case "get_storage":
        return await this.getStorage(this.readStorageType(args.storageType));
      case "set_storage":
        return await this.setStorage(
          this.requireString(args.key, "'key' is required for set_storage action."),
          this.requireString(args.value, "'value' is required for set_storage action."),
          this.readStorageType(args.storageType),
        );
      case "clear_storage":
        return await this.clearStorage(this.readStorageType(args.storageType));
    }
  }

  private async executeBatch(args: Record<string, unknown>): Promise<BatchActionResult> {
    const actions = args.actions;
    if (!Array.isArray(actions)) {
      throw new BrowserError("'actions' must be an array for batch action.");
    }

    if (actions.length === 0) {
      return { completedCount: 0, results: [] };
    }

    const results: unknown[] = [];
    for (let step = 0; step < actions.length; step++) {
      const subAction = actions[step];
      if (typeof subAction !== "object" || subAction === null) {
        return {
          completedCount: step,
          results,
          error: { step, message: `Step ${step}: action must be an object`, code: "BROWSER_ERROR" },
        };
      }

      const subArgs = subAction as Record<string, unknown>;
      if (subArgs.action === "batch") {
        return {
          completedCount: step,
          results,
          error: { step, message: "Nested batch actions are not supported.", code: "BROWSER_ERROR" },
        };
      }

      try {
        const subResult = await this.executeAction(subArgs);
        results.push(subResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = this.classifyError(error);
        return {
          completedCount: step,
          results,
          error: { step, message, code: detail.code },
        };
      }
    }

    return { completedCount: actions.length, results };
  }

  private async getCookies(): Promise<unknown> {
    const { client, sessionId } = await this.attachToActiveTab();
    const result = await client.send<{ cookies: unknown[] }>("Network.getCookies", {}, sessionId);
    return { action: "get_cookies", cookies: result.cookies };
  }

  private async setCookie(args: Record<string, unknown>): Promise<unknown> {
    const { client, sessionId } = await this.attachToActiveTab();
    const name = this.requireString(args.name, "'name' is required for set_cookie action.");
    const value = this.requireString(args.value, "'value' is required for set_cookie action.");
    const params: Record<string, unknown> = { name, value };
    if (typeof args.domain === "string") params.domain = args.domain;
    if (typeof args.path === "string") params.path = args.path;
    await client.send("Network.setCookie", params, sessionId);
    return { action: "set_cookie", name, value };
  }

  private async clearCookies(): Promise<unknown> {
    const { client, sessionId } = await this.attachToActiveTab();
    await client.send("Network.clearBrowserCookies", {}, sessionId);
    return { action: "clear_cookies" };
  }

  private async getStorage(storageType: "local" | "session"): Promise<unknown> {
    const { client, sessionId } = await this.attachToActiveTab();
    const prop = storageType === "local" ? "localStorage" : "sessionStorage";
    const evalResult = await client.send<EvaluateResult>("Runtime.evaluate", {
      expression: `JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(${prop}))))`,
      returnByValue: true,
    }, sessionId);
    return { action: "get_storage", storageType, data: evalResult.result.value };
  }

  private async setStorage(
    key: string,
    value: string,
    storageType: "local" | "session",
  ): Promise<unknown> {
    const { client, sessionId } = await this.attachToActiveTab();
    const prop = storageType === "local" ? "localStorage" : "sessionStorage";
    await client.send<EvaluateResult>("Runtime.evaluate", {
      expression: `${prop}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
      returnByValue: true,
    }, sessionId);
    return { action: "set_storage", storageType, key, value };
  }

  private async clearStorage(storageType: "local" | "session"): Promise<unknown> {
    const { client, sessionId } = await this.attachToActiveTab();
    const prop = storageType === "local" ? "localStorage" : "sessionStorage";
    await client.send<EvaluateResult>("Runtime.evaluate", {
      expression: `${prop}.clear()`,
      returnByValue: true,
    }, sessionId);
    return { action: "clear_storage", storageType };
  }

  private readStorageType(value: unknown): "local" | "session" {
    if (value === "session") return "session";
    return "local";
  }

  private async attachToActiveTab(): Promise<{ client: CdpClient; tabId: string; sessionId: string }> {
    const client = await this.service.ensureBrowser();
    const tabId = this.service.getCurrentTabId() ?? await this.getFirstTabId(client);
    if (!tabId) {
      throw new BrowserError("No active tab — navigate to a page first");
    }

    const attached = await client.send<AttachToTargetResult>("Target.attachToTarget", {
      targetId: tabId,
      flatten: true,
    });

    return { client, tabId, sessionId: attached.sessionId };
  }

  private async getFirstTabId(client: CdpClient): Promise<string | undefined> {
    const targets = await client.send<GetTargetsResult>("Target.getTargets");
    const firstPage = targets.targetInfos.find((target: CdpTargetInfo) => target.type === "page");
    return firstPage?.targetId;
  }

  private async click(ref: string): Promise<unknown> {
    const { client, tabId, sessionId } = await this.attachToActiveTab();
    const backendNodeId = this.resolveRef(tabId, ref);

    const boxModel = await client.send<GetBoxModelResult>("DOM.getBoxModel", { backendNodeId }, sessionId);
    const [x1, y1, x2, y2, x3, y3, x4, y4] = boxModel.model.content;
    const x = ((x1 ?? 0) + (x2 ?? 0) + (x3 ?? 0) + (x4 ?? 0)) / 4;
    const y = ((y1 ?? 0) + (y2 ?? 0) + (y3 ?? 0) + (y4 ?? 0)) / 4;

    const commonParams = { x, y, button: "left" as const, clickCount: 1, buttons: 1 };
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", ...commonParams }, sessionId);
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...commonParams }, sessionId);

    return { action: "click", ref, x, y };
  }

  private async type(ref: string, text: string, clear: boolean): Promise<unknown> {
    const { client, tabId, sessionId } = await this.attachToActiveTab();
    const backendNodeId = this.resolveRef(tabId, ref);

    await client.send("DOM.focus", { backendNodeId }, sessionId);
    if (clear) {
      await this.pressKey(client, sessionId, "a", ["Control"]);
      await this.pressKey(client, sessionId, "Delete");
    }

    for (const char of text) {
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: char,
        text: char,
      }, sessionId);
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: char,
        text: char,
      }, sessionId);
    }

    return { action: "type", ref, text };
  }

  private async fill(ref: string, value: string): Promise<unknown> {
    const { client, tabId, sessionId } = await this.attachToActiveTab();
    const backendNodeId = this.resolveRef(tabId, ref);

    const resolved = await client.send<ResolveNodeResult>("DOM.resolveNode", { backendNodeId }, sessionId);
    if (!resolved.object.objectId) {
      throw new BrowserError(`Could not resolve element ref ${ref} to a DOM object`);
    }

    await client.send("Runtime.callFunctionOn", {
      functionDeclaration: `function(v) {
    this.value = v;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }`,
      objectId: resolved.object.objectId,
      arguments: [{ value }],
    }, sessionId);

    return { action: "fill", ref, value };
  }

  private async select(ref: string, value: string): Promise<unknown> {
    const { client, tabId, sessionId } = await this.attachToActiveTab();
    const backendNodeId = this.resolveRef(tabId, ref);

    const resolved = await client.send<ResolveNodeResult>("DOM.resolveNode", { backendNodeId }, sessionId);
    if (!resolved.object.objectId) {
      throw new BrowserError(`Could not resolve element ref ${ref} to a DOM object`);
    }

    await client.send("Runtime.callFunctionOn", {
      functionDeclaration: `function(v) {
    this.value = v;
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }`,
      objectId: resolved.object.objectId,
      arguments: [{ value }],
    }, sessionId);

    return { action: "select", ref, value };
  }

  private async scroll(
    direction?: "up" | "down" | "left" | "right",
    amount?: number,
  ): Promise<unknown> {
    const { client, sessionId } = await this.attachToActiveTab();
    const dir = direction ?? "down";
    const px = amount ?? 300;
    const x = dir === "right" ? px : dir === "left" ? -px : 0;
    const y = dir === "down" ? px : dir === "up" ? -px : 0;

    await client.send("Runtime.evaluate", {
      expression: `window.scrollBy(${x}, ${y})`,
      returnByValue: true,
    }, sessionId);

    return { action: "scroll", direction: dir, amount: px };
  }

  private async hover(ref: string): Promise<unknown> {
    const { client, tabId, sessionId } = await this.attachToActiveTab();
    const backendNodeId = this.resolveRef(tabId, ref);

    const boxModel = await client.send<GetBoxModelResult>("DOM.getBoxModel", { backendNodeId }, sessionId);
    const [x1, y1, x2, y2, x3, y3, x4, y4] = boxModel.model.content;
    const x = ((x1 ?? 0) + (x2 ?? 0) + (x3 ?? 0) + (x4 ?? 0)) / 4;
    const y = ((y1 ?? 0) + (y2 ?? 0) + (y3 ?? 0) + (y4 ?? 0)) / 4;

    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
    return { action: "hover", ref, x, y };
  }

  private async pressKeyAction(
    key: string,
    modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">,
  ): Promise<unknown> {
    const { client, sessionId } = await this.attachToActiveTab();
    await this.pressKey(client, sessionId, key, modifiers);
    return { action: "press_key", key, modifiers };
  }

  private async evaluate(script: string, awaitPromise: boolean): Promise<unknown> {
    const { client, sessionId } = await this.attachToActiveTab();
    const evalResult = await client.send<EvaluateResult>("Runtime.evaluate", {
      expression: script,
      returnByValue: true,
      awaitPromise,
    }, sessionId);

    if (evalResult.exceptionDetails) {
      throw new BrowserError(`Script evaluation failed: ${evalResult.exceptionDetails.text}`);
    }

    return { action: "evaluate", result: evalResult.result.value };
  }

  private async screenshot(quality: number, output: "inline" | "file"): Promise<unknown> {
    const { client, sessionId } = await this.attachToActiveTab();
    const result = await client.send<CaptureScreenshotResult>("Page.captureScreenshot", {
      format: "jpeg",
      quality,
    }, sessionId);

    if (output === "file") {
      await this.mkdirFn(this.screenshotDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `screenshot-${timestamp}.jpg`;
      const filePath = join(this.screenshotDir, filename);
      const buffer = Buffer.from(result.data, "base64");
      await this.writeFileFn(filePath, buffer);
      return { action: "screenshot", output: "file", path: filePath };
    }

    return { action: "screenshot", output: "inline", data: result.data, mimeType: "image/jpeg" };
  }

  private async watch(args: Record<string, unknown>): Promise<unknown> {
    if (!this.watcherManager) {
      throw new BrowserError("Watcher mode not available");
    }

    const url = this.requireString(args.url, "'url' is required for watch action.");
    const intervalSeconds = typeof args.intervalSeconds === "number" && Number.isFinite(args.intervalSeconds)
      ? args.intervalSeconds
      : 300;
    const format = this.readSnapshotFormat(args.format);
    const filter = this.readSnapshotFilter(args.filter);
    const maxTokens = typeof args.maxTokens === "number" && Number.isFinite(args.maxTokens)
      ? args.maxTokens
      : undefined;

    const watcher = await this.watcherManager.createWatcher({
      id: "",
      url,
      intervalSeconds,
      format,
      filter,
      maxTokens,
      createdAt: Date.now(),
    });

    return {
      watcherId: watcher.id,
      url,
      intervalSeconds: watcher.state.config.intervalSeconds,
      message: `Watcher created for ${url} checking every ${watcher.state.config.intervalSeconds}s`,
    };
  }

  private async unwatch(watcherId: string): Promise<unknown> {
    if (!this.watcherManager) {
      throw new BrowserError("Watcher mode not available");
    }

    const existing = this.watcherManager.getWatcher(watcherId);
    if (!existing) {
      throw new BrowserError(`Watcher not found: ${watcherId}`);
    }

    await this.watcherManager.removeWatcher(watcherId);
    return {
      watcherId,
      message: `Watcher removed: ${watcherId}`,
    };
  }

  private listWatchers(): unknown {
    if (!this.watcherManager) {
      throw new BrowserError("Watcher mode not available");
    }

    return this.watcherManager.listWatchers().map((watcher) => {
      const state = watcher.state;
      return {
        watcherId: state.config.id,
        url: state.config.url,
        status: state.status,
        intervalSeconds: state.config.intervalSeconds,
        lastCheckedAt: state.lastCheckedAt ?? null,
        hasChanges: state.lastDiff?.hasChanges ?? false,
      };
    });
  }

  private async wait(args: Record<string, unknown>): Promise<unknown> {
    const condition = args.condition;
    if (
      condition !== "ref_visible"
      && condition !== "ref_present"
      && condition !== "text_present"
      && condition !== "load_state"
    ) {
      throw new BrowserError(
        "'condition' must be one of: ref_visible, ref_present, text_present, load_state",
      );
    }

    const timeoutMs = typeof args.timeout === "number" && Number.isFinite(args.timeout)
      ? args.timeout
      : 5000;
    const pollIntervalMs = 250;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const conditionMet = await this.checkWaitCondition(condition, args);
      if (conditionMet) {
        return { action: "wait", condition, satisfied: true };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new BrowserError(`Wait condition '${condition}' timed out after ${timeoutMs}ms`);
  }

  private async checkWaitCondition(
    condition: "ref_visible" | "ref_present" | "text_present" | "load_state",
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const { client, tabId, sessionId } = await this.attachToActiveTab();

    switch (condition) {
      case "ref_visible": {
        const ref = this.requireString(args.ref, "'ref' is required for ref_visible condition.");
        const backendNodeId = this.elementRefRegistry.lookupRef(tabId, ref);
        if (backendNodeId === undefined) return false;
        try {
          const boxModel = await client.send<GetBoxModelResult>(
            "DOM.getBoxModel",
            { backendNodeId },
            sessionId,
          );
          return boxModel.model.width > 0 && boxModel.model.height > 0;
        } catch {
          return false;
        }
      }
      case "ref_present": {
        const ref = this.requireString(args.ref, "'ref' is required for ref_present condition.");
        return this.elementRefRegistry.lookupRef(tabId, ref) !== undefined;
      }
      case "text_present": {
        const text = this.requireString(args.text, "'text' is required for text_present condition.");
        try {
          const evalResult = await client.send<EvaluateResult>("Runtime.evaluate", {
            expression: `document.body.innerText.includes(${JSON.stringify(text)})`,
            returnByValue: true,
          }, sessionId);
          return evalResult.result.value === true;
        } catch {
          return false;
        }
      }
      case "load_state": {
        const state = args.state;
        if (state !== "complete" && state !== "interactive") {
          throw new BrowserError(
            "'state' must be 'complete' or 'interactive' for load_state condition.",
          );
        }
        try {
          const evalResult = await client.send<EvaluateResult>("Runtime.evaluate", {
            expression: "document.readyState",
            returnByValue: true,
          }, sessionId);
          const readyState = evalResult.result.value as string;
          if (state === "complete") return readyState === "complete";
          return readyState === "complete" || readyState === "interactive";
        } catch {
          return false;
        }
      }
    }
  }

  private readSnapshotFormat(value: unknown): SnapshotFormat {
    if (value === "text" || value === "compact" || value === "json") {
      return value;
    }
    return "compact";
  }

  private readSnapshotFilter(value: unknown): SnapshotFilter {
    if (value === "interactive" || value === "forms" || value === "none") {
      return value;
    }
    return "interactive";
  }

  private async pressKey(
    client: CdpClient,
    sessionId: string,
    key: string,
    modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">,
  ): Promise<void> {
    const modifierBitmask = this.calculateModifiers(modifiers ?? []);
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      modifiers: modifierBitmask,
    }, sessionId);
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      modifiers: modifierBitmask,
    }, sessionId);
  }

  private calculateModifiers(modifiers: string[]): number {
    let bitmask = 0;
    if (modifiers.includes("Alt")) bitmask |= 1;
    if (modifiers.includes("Control")) bitmask |= 2;
    if (modifiers.includes("Meta")) bitmask |= 4;
    if (modifiers.includes("Shift")) bitmask |= 8;
    return bitmask;
  }

  private resolveRef(tabId: string, ref: string): number {
    const backendNodeId = this.elementRefRegistry.lookupRef(tabId, ref);
    if (backendNodeId === undefined) {
      throw new ElementNotFoundError(ref);
    }
    return backendNodeId;
  }

  private readAction(value: unknown): SupportedBrowserActAction | null {
    if (typeof value !== "string") {
      return null;
    }

    if (
      value === "click"
      || value === "type"
      || value === "fill"
      || value === "select"
      || value === "scroll"
      || value === "hover"
      || value === "press_key"
      || value === "evaluate"
      || value === "screenshot"
      || value === "watch"
      || value === "unwatch"
      || value === "list_watchers"
      || value === "wait"
      || value === "batch"
      || value === "get_cookies"
      || value === "set_cookie"
      || value === "clear_cookies"
      || value === "get_storage"
      || value === "set_storage"
      || value === "clear_storage"
    ) {
      return value;
    }

    return null;
  }

  private readQuality(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.min(100, Math.round(value)));
    }
    return 80;
  }

  private readOutput(value: unknown): "inline" | "file" {
    if (value === "file") {
      return "file";
    }
    return "inline";
  }

  private readDirection(value: unknown): "up" | "down" | "left" | "right" | undefined {
    if (value === "up" || value === "down" || value === "left" || value === "right") {
      return value;
    }
    return undefined;
  }

  private readModifiers(value: unknown): Array<"Alt" | "Control" | "Meta" | "Shift"> | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const parsed: Array<"Alt" | "Control" | "Meta" | "Shift"> = [];
    for (const item of value) {
      if (item === "Alt" || item === "Control" || item === "Meta" || item === "Shift") {
        parsed.push(item);
      }
    }

    return parsed;
  }

  private requireString(value: unknown, message: string): string {
    if (typeof value !== "string") {
      throw new BrowserError(message);
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new BrowserError(message);
    }

    return trimmed;
  }

  private success(callId: string, result: unknown): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result,
    };
  }

  private toErrorResult(callId: string, error: unknown): ToolResult {
    const detail = this.classifyError(error);
    return {
      callId,
      name: this.definition.name,
      result: null,
      error: detail.message,
      errorDetail: detail,
    };
  }

  private classifyError(error: unknown): ToolErrorDetail {
    if (error instanceof ElementNotFoundError) {
      return {
        code: "ELEMENT_NOT_FOUND",
        message: error.message,
        retryable: false,
      };
    }

    if (error instanceof CdpError) {
      return {
        code: "CDP_ERROR",
        message: error.message,
        retryable: true,
      };
    }

    if (error instanceof BrowserError) {
      return {
        code: "BROWSER_ERROR",
        message: error.message,
        retryable: false,
      };
    }

    return {
      code: "BROWSER_ERROR",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}

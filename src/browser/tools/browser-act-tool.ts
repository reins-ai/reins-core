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
import type {
  AttachToTargetResult,
  CaptureScreenshotResult,
  CdpTargetInfo,
  EvaluateResult,
  GetBoxModelResult,
  GetTargetsResult,
  ResolveNodeResult,
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
  | "screenshot";

export interface BrowserActToolOptions {
  screenshotDir?: string;
  mkdirFn?: typeof mkdir;
  writeFileFn?: typeof writeFile;
}

export class BrowserActTool implements Tool {
  readonly definition: ToolDefinition = {
    name: "browser_act",
    description:
      "Interact with page elements using element refs from browser_snapshot. Supports click, type, fill, select, scroll, hover, press_key, evaluate, and screenshot actions.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["click", "type", "fill", "select", "scroll", "hover", "press_key", "evaluate", "screenshot"],
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
      },
      required: ["action"],
    },
  };

  private readonly screenshotDir: string;
  private readonly mkdirFn: typeof mkdir;
  private readonly writeFileFn: typeof writeFile;

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
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const callId = typeof args.callId === "string" ? args.callId : "unknown-call";

    try {
      const action = this.readAction(args.action);
      if (!action) {
        throw new BrowserError("Missing or invalid 'action' argument.");
      }

      switch (action) {
        case "click":
          return this.success(callId, await this.click(this.requireString(args.ref, "'ref' is required for click action.")));
        case "type":
          return this.success(
            callId,
            await this.type(
              this.requireString(args.ref, "'ref' is required for type action."),
              this.requireString(args.text, "'text' is required for type action."),
              typeof args.clear === "boolean" ? args.clear : false,
            ),
          );
        case "fill":
          return this.success(
            callId,
            await this.fill(
              this.requireString(args.ref, "'ref' is required for fill action."),
              this.requireString(args.value, "'value' is required for fill action."),
            ),
          );
        case "select":
          return this.success(
            callId,
            await this.select(
              this.requireString(args.ref, "'ref' is required for select action."),
              this.requireString(args.value, "'value' is required for select action."),
            ),
          );
        case "scroll":
          return this.success(
            callId,
            await this.scroll(
              this.readDirection(args.direction),
              typeof args.amount === "number" && Number.isFinite(args.amount) ? args.amount : undefined,
            ),
          );
        case "hover":
          return this.success(callId, await this.hover(this.requireString(args.ref, "'ref' is required for hover action.")));
        case "press_key":
          return this.success(
            callId,
            await this.pressKeyAction(
              this.requireString(args.key, "'key' is required for press_key action."),
              this.readModifiers(args.modifiers),
            ),
          );
        case "evaluate":
          return this.success(
            callId,
            await this.evaluate(
              this.requireString(args.script, "'script' is required for evaluate action."),
              typeof args.awaitPromise === "boolean" ? args.awaitPromise : false,
            ),
          );
        case "screenshot":
          return this.success(
            callId,
            await this.screenshot(
              this.readQuality(args.quality),
              this.readOutput(args.output),
            ),
          );
      }
    } catch (error) {
      return this.toErrorResult(callId, error);
    }
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

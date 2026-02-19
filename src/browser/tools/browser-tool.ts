import { BrowserError, BrowserNotRunningError } from "../errors";
import type {
  AttachToTargetResult,
  BrowserAction,
  BrowserStatus,
  CdpTargetInfo,
  CreateTargetResult,
  EvaluateResult,
  GetTargetsResult,
  TabInfo,
} from "../types";
import type { BrowserDaemonService } from "../browser-daemon-service";
import type { CdpClient } from "../cdp-client";
import type {
  Tool,
  ToolContext,
  ToolDefinition,
  ToolErrorDetail,
  ToolResult,
} from "../../types";

interface PageMetadata {
  url?: string;
  title?: string;
}

interface BrowserToolFailure {
  code: string;
  message: string;
}

export class BrowserTool implements Tool {
  readonly definition: ToolDefinition = {
    name: "browser",
    description:
      "Manage browser lifecycle and navigation across tabs (navigate, tab management, status).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["navigate", "new_tab", "close_tab", "list_tabs", "switch_tab", "status"],
          description: "Browser action to execute.",
        },
        url: {
          type: "string",
          description: "URL to navigate to (required for navigate; optional for new_tab).",
        },
        tabId: {
          type: "string",
          description: "Tab ID (required for switch_tab; optional for close_tab).",
        },
      },
      required: ["action"],
    },
  };

  constructor(private readonly service: BrowserDaemonService) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const callId = this.readString(args.callId) ?? "unknown-call";
    const action = this.normalizeAction(args.action);

    if (!action) {
      return this.errorResult(callId, new BrowserError("Missing or invalid 'action' argument."));
    }

    try {
      switch (action) {
        case "navigate":
          return this.successResult(callId, await this.navigate(args, context));
        case "new_tab":
          return this.successResult(callId, await this.newTab(args));
        case "close_tab":
          return this.successResult(callId, await this.closeTab(args));
        case "list_tabs":
          return this.successResult(callId, await this.listTabs());
        case "switch_tab":
          return this.successResult(callId, await this.switchTab(args));
        case "status":
          return this.successResult(callId, this.status());
      }
    } catch (error) {
      return this.errorResult(callId, this.toBrowserError(error));
    }
  }

  private async navigate(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    const url = this.requireString(args.url, "'url' is required for navigate action.");
    const client = await this.service.ensureBrowser();
    const tabId = await this.getOrCreateActiveTabId(client);
    const sessionId = await this.attachToTarget(client, tabId);

    await client.send("Page.enable", undefined, sessionId);
    await client.send("Page.navigate", { url }, sessionId);
    await this.waitForLoadComplete(client, sessionId, context.abortSignal);

    const metadata = await this.readPageMetadata(client, sessionId);
    await this.refreshAndStoreTabs(client, tabId);

    return {
      action: "navigate",
      tabId,
      url: metadata.url ?? url,
      title: metadata.title,
    };
  }

  private async newTab(args: Record<string, unknown>): Promise<unknown> {
    const client = await this.service.ensureBrowser();
    const url = this.readString(args.url) ?? "about:blank";
    const created = await client.send<CreateTargetResult>("Target.createTarget", { url });

    await this.refreshAndStoreTabs(client, created.targetId);

    return {
      action: "new_tab",
      tabId: created.targetId,
      url,
    };
  }

  private async closeTab(args: Record<string, unknown>): Promise<unknown> {
    const client = await this.service.ensureBrowser();
    const explicitTabId = this.readString(args.tabId);
    const resolvedTabId = explicitTabId
      ?? this.service.getCurrentTabId()
      ?? (await this.getFirstTabId(client));

    if (!resolvedTabId) {
      throw new BrowserNotRunningError("No tab is available to close");
    }

    await client.send("Target.closeTarget", { targetId: resolvedTabId });
    const tabState = await this.refreshAndStoreTabs(client);

    return {
      action: "close_tab",
      tabId: resolvedTabId,
      activeTabId: tabState.activeTabId,
    };
  }

  private async listTabs(): Promise<unknown> {
    const client = await this.service.ensureBrowser();
    const tabState = await this.refreshAndStoreTabs(client, this.service.getCurrentTabId());

    return {
      action: "list_tabs",
      tabs: tabState.tabs,
      activeTabId: tabState.activeTabId,
    };
  }

  private async switchTab(args: Record<string, unknown>): Promise<unknown> {
    const tabId = this.requireString(args.tabId, "'tabId' is required for switch_tab action.");
    const client = await this.service.ensureBrowser();

    await client.send("Target.activateTarget", { targetId: tabId });
    const tabState = await this.refreshAndStoreTabs(client, tabId);

    return {
      action: "switch_tab",
      tabId,
      activeTabId: tabState.activeTabId,
    };
  }

  private status(): BrowserStatus {
    return this.service.getStatus();
  }

  private async refreshAndStoreTabs(
    client: CdpClient,
    preferredActiveTabId?: string,
  ): Promise<{ tabs: TabInfo[]; activeTabId?: string }> {
    const targets = await this.getPageTargets(client);
    const activeTabId = this.selectActiveTabId(targets, preferredActiveTabId);
    const tabs = targets.map((target) => ({
      tabId: target.targetId,
      url: target.url,
      title: target.title,
      active: target.targetId === activeTabId,
    }));

    this.service.updateTabState(tabs, activeTabId);

    return {
      tabs,
      activeTabId,
    };
  }

  private async getOrCreateActiveTabId(
    client: CdpClient,
  ): Promise<string> {
    const targets = await this.getPageTargets(client);
    const currentTabId = this.service.getCurrentTabId();

    if (currentTabId && targets.some((target) => target.targetId === currentTabId)) {
      return currentTabId;
    }

    const firstTab = targets[0]?.targetId;
    if (firstTab) {
      return firstTab;
    }

    const created = await client.send<CreateTargetResult>("Target.createTarget", {
      url: "about:blank",
    });

    return created.targetId;
  }

  private async getFirstTabId(
    client: CdpClient,
  ): Promise<string | undefined> {
    const targets = await this.getPageTargets(client);
    return targets[0]?.targetId;
  }

  private selectActiveTabId(
    targets: CdpTargetInfo[],
    preferredActiveTabId?: string,
  ): string | undefined {
    if (preferredActiveTabId && targets.some((target) => target.targetId === preferredActiveTabId)) {
      return preferredActiveTabId;
    }

    return targets[0]?.targetId;
  }

  private async getPageTargets(
    client: CdpClient,
  ): Promise<CdpTargetInfo[]> {
    const result = await client.send<GetTargetsResult>("Target.getTargets");
    return result.targetInfos.filter((target) => target.type === "page");
  }

  private async attachToTarget(
    client: CdpClient,
    tabId: string,
  ): Promise<string> {
    const attached = await client.send<AttachToTargetResult>("Target.attachToTarget", {
      targetId: tabId,
      flatten: true,
    });

    return attached.sessionId;
  }

  private async waitForLoadComplete(
    client: CdpClient,
    sessionId: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const timeoutMs = 10_000;
    const intervalMs = 100;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (abortSignal?.aborted) {
        throw new BrowserError("Navigate aborted by caller");
      }

      const result = await client.send<EvaluateResult>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      }, sessionId);
      const readyState = result.result.value;
      if (readyState === "complete") {
        return;
      }

      await this.sleep(intervalMs);
    }

    throw new BrowserError(`Navigation did not complete within ${timeoutMs}ms`);
  }

  private async readPageMetadata(
    client: CdpClient,
    sessionId: string,
  ): Promise<PageMetadata> {
    const result = await client.send<EvaluateResult>("Runtime.evaluate", {
      expression: "({ url: window.location.href, title: document.title })",
      returnByValue: true,
    }, sessionId);
    const value = result.result.value;

    if (!this.isRecord(value)) {
      return {};
    }

    return {
      url: this.readString(value.url) ?? undefined,
      title: this.readString(value.title) ?? undefined,
    };
  }

  private sleep(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, timeoutMs);
    });
  }

  private successResult(callId: string, result: unknown): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result,
    };
  }

  private errorResult(callId: string, error: BrowserToolFailure): ToolResult {
    const detail: ToolErrorDetail = {
      code: error.code,
      message: error.message,
      retryable: false,
    };

    return {
      callId,
      name: this.definition.name,
      result: null,
      error: error.message,
      errorDetail: detail,
    };
  }

  private normalizeAction(value: unknown): BrowserAction | null {
    const action = this.readString(value);
    if (!action) {
      return null;
    }

    if (
      action === "navigate"
      || action === "new_tab"
      || action === "close_tab"
      || action === "list_tabs"
      || action === "switch_tab"
      || action === "status"
    ) {
      return action;
    }

    return null;
  }

  private readString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private requireString(value: unknown, message: string): string {
    const read = this.readString(value);
    if (!read) {
      throw new BrowserError(message);
    }

    return read;
  }

  private toBrowserError(error: unknown): BrowserToolFailure {
    if (error instanceof BrowserError || error instanceof BrowserNotRunningError) {
      return error;
    }

    if (error instanceof Error) {
      return new BrowserError(error.message, error);
    }

    return new BrowserError(String(error));
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}

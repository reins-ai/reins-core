import { BrowserError, BrowserNotRunningError, CdpError } from "../errors";
import type { SnapshotEngine, TakeSnapshotParams } from "../snapshot";
import type {
  AttachToTargetResult,
  CreateTargetResult,
  CdpTargetInfo,
  GetTargetsResult,
  SnapshotFilter,
  SnapshotFormat,
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

export class BrowserSnapshotTool implements Tool {
  readonly definition: ToolDefinition = {
    name: "browser_snapshot",
    description:
      "Read the current page as an accessibility tree snapshot. Returns a structured representation of all interactive and semantic elements on the page with stable element refs (e0, e1, e2...) for use with browser_act.",
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["text", "compact", "json"],
          description:
            "Output format. text=indented outline (default), compact=one-line-per-node (~56% smaller), json=full structured data.",
        },
        filter: {
          type: "string",
          enum: ["interactive", "forms", "none"],
          description:
            "Filter nodes. interactive=buttons/links/inputs only (75% fewer tokens), forms=form-related elements, none=all elements (default).",
        },
        diff: {
          type: "boolean",
          description:
            "If true, return only elements added/changed/removed since last snapshot.",
        },
        maxTokens: {
          type: "number",
          description:
            "Hard cap on output tokens. Truncates with [truncated] marker if exceeded.",
        },
      },
    },
  };

  constructor(
    private readonly service: BrowserDaemonService,
    private readonly snapshotEngine: SnapshotEngine,
  ) {}

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const callId = typeof args.callId === "string" ? args.callId : "unknown-call";

    try {
      const format = this.readFormat(args.format);
      const filter = this.readFilter(args.filter);
      const isDiff = typeof args.diff === "boolean" ? args.diff : false;
      const maxTokens = typeof args.maxTokens === "number" && Number.isFinite(args.maxTokens)
        ? args.maxTokens
        : undefined;

      const client = await this.service.ensureBrowser();
      const tabId = await this.getOrCreateActiveTabId(client);
      const sessionId = await this.attachToTarget(client, tabId);

      const tabInfo = this.service.getStatus().tabs.find((t) => t.tabId === tabId);
      const url = tabInfo?.url ?? "about:blank";
      const title = tabInfo?.title ?? "";

      const previous = isDiff ? this.snapshotEngine.getLastSnapshot(tabId) : undefined;

      const snapshotParams: TakeSnapshotParams = {
        cdpClient: client,
        tabId,
        url,
        title,
        sessionId,
        options: {
          format,
          filter,
          diff: false,
          maxTokens,
        },
      };

      const snapshot = await this.snapshotEngine.takeSnapshot(snapshotParams);

      let content: string;
      if (isDiff && previous) {
        const diff = this.snapshotEngine.computeDiff(previous, snapshot);
        content = this.snapshotEngine.serializeDiff(diff, format);
      } else if (isDiff && !previous) {
        const diff = {
          added: [...snapshot.nodes],
          changed: [],
          removed: [],
        };
        content = this.snapshotEngine.serializeDiff(diff, format);
      } else {
        content = this.snapshotEngine.serializeSnapshot(snapshot, format);
      }

      return {
        callId,
        name: this.definition.name,
        result: {
          content,
          tokenCount: snapshot.tokenCount,
          truncated: snapshot.truncated,
          tabId: snapshot.tabId,
          url: snapshot.url,
          title: snapshot.title,
          format,
        },
      };
    } catch (error) {
      return this.toErrorResult(callId, error);
    }
  }

  private readFormat(value: unknown): SnapshotFormat {
    if (typeof value === "string" && (value === "text" || value === "compact" || value === "json")) {
      return value;
    }
    return "text";
  }

  private readFilter(value: unknown): SnapshotFilter {
    if (typeof value === "string" && (value === "interactive" || value === "forms" || value === "none")) {
      return value;
    }
    return "none";
  }

  private async getOrCreateActiveTabId(client: CdpClient): Promise<string> {
    const currentTabId = this.service.getCurrentTabId();
    if (currentTabId) {
      return currentTabId;
    }

    const status = this.service.getStatus();
    const firstTab = status.tabs[0];
    if (firstTab) {
      return firstTab.tabId;
    }

    const targets = await client.send<GetTargetsResult>("Target.getTargets");
    const pageTarget = targets.targetInfos.find((t: CdpTargetInfo) => t.type === "page");
    if (pageTarget) {
      return pageTarget.targetId;
    }

    const created = await client.send<CreateTargetResult>("Target.createTarget", {
      url: "about:blank",
    });
    return created.targetId;
  }

  private async attachToTarget(client: CdpClient, tabId: string): Promise<string> {
    const attached = await client.send<AttachToTargetResult>("Target.attachToTarget", {
      targetId: tabId,
      flatten: true,
    });
    return attached.sessionId;
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
    if (error instanceof BrowserNotRunningError) {
      return {
        code: "BROWSER_NOT_RUNNING",
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

    const message = error instanceof Error ? error.message : String(error);
    return {
      code: "BROWSER_ERROR",
      message,
      retryable: false,
    };
  }
}

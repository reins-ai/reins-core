import { BrowserError, CdpError } from "../errors";
import type { DebugEventBuffer } from "../debug-event-buffer";
import type { BrowserDaemonService } from "../browser-daemon-service";
import type {
  Tool,
  ToolContext,
  ToolDefinition,
  ToolErrorDetail,
  ToolResult,
} from "../../types";

export class BrowserDebugTool implements Tool {
  readonly definition: ToolDefinition = {
    name: "browser_debug",
    description:
      "Read buffered runtime debug information from the active browser session. Returns console messages, page errors, and network requests captured via CDP. Data is buffered per tab session and cleared on navigation.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["console", "errors", "network", "all"],
          description:
            "Which debug data to retrieve. console=console messages, errors=JavaScript errors, network=HTTP requests, all=everything.",
        },
      },
      required: ["action"],
    },
  };

  constructor(
    private readonly service: BrowserDaemonService,
    private readonly debugBuffer: DebugEventBuffer,
  ) {}

  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    const callId =
      typeof args.callId === "string" ? args.callId : "unknown-call";

    try {
      const action = this.readAction(args.action);
      if (!action) {
        throw new BrowserError(
          "Missing or invalid 'action' argument. Must be: console, errors, network, or all.",
        );
      }

      await this.service.ensureBrowser();

      switch (action) {
        case "console":
          return this.success(callId, {
            action: "console",
            entries: this.debugBuffer.getConsole(),
          });
        case "errors":
          return this.success(callId, {
            action: "errors",
            entries: this.debugBuffer.getErrors(),
          });
        case "network":
          return this.success(callId, {
            action: "network",
            entries: this.debugBuffer.getNetwork(),
          });
        case "all":
          return this.success(callId, {
            action: "all",
            ...this.debugBuffer.getAll(),
          });
      }
    } catch (error) {
      return this.toErrorResult(callId, error);
    }
  }

  private readAction(
    value: unknown,
  ): "console" | "errors" | "network" | "all" | null {
    if (
      value === "console" ||
      value === "errors" ||
      value === "network" ||
      value === "all"
    ) {
      return value;
    }
    return null;
  }

  private success(callId: string, result: unknown): ToolResult {
    return { callId, name: this.definition.name, result };
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
    if (error instanceof CdpError) {
      return { code: "CDP_ERROR", message: error.message, retryable: true };
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

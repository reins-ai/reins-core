import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../types";
import type { VoiceInputMode } from "../voice";

type VoiceAction =
  | "enable_voice"
  | "disable_voice"
  | "set_language"
  | "set_input_mode"
  | "get_voice_status";

export interface VoiceStatus {
  enabled: boolean;
  language: string;
  inputMode: VoiceInputMode;
  isListening: boolean;
  isSpeaking: boolean;
}

export interface VoiceBackendClient {
  enableVoice(params: {
    conversationId: string;
    userId: string;
    language?: string;
    mode?: VoiceInputMode;
  }): Promise<VoiceStatus>;
  disableVoice(params: { conversationId: string; userId: string }): Promise<void>;
  setLanguage(params: { conversationId: string; userId: string; language: string }): Promise<VoiceStatus>;
  setInputMode(params: { conversationId: string; userId: string; mode: VoiceInputMode }): Promise<VoiceStatus>;
  getVoiceStatus(params: { conversationId: string; userId: string }): Promise<VoiceStatus>;
}

export class VoiceTool implements Tool {
  definition: ToolDefinition = {
    name: "voice",
    description:
      "Manage conversation voice mode, including enabling voice, setting language, input mode, and checking current voice status.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: ["enable_voice", "disable_voice", "set_language", "set_input_mode", "get_voice_status"],
        },
        language: {
          type: "string",
          description: "Language code for speech recognition and text-to-speech, such as 'en-US'.",
        },
        mode: {
          type: "string",
          description: "Voice input mode.",
          enum: ["push-to-talk", "continuous"],
        },
      },
      required: ["action"],
    },
  };

  constructor(private readonly backendClient: VoiceBackendClient) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const callId = this.readString(args.callId) ?? "unknown-call";
    const action = this.normalizeAction(args.action);

    if (!action) {
      return this.errorResult(callId, "Missing or invalid 'action' argument.");
    }

    try {
      switch (action) {
        case "enable_voice":
          return await this.enableVoice(callId, args, context);
        case "disable_voice":
          return await this.disableVoice(callId, context);
        case "set_language":
          return await this.setLanguage(callId, args, context);
        case "set_input_mode":
          return await this.setInputMode(callId, args, context);
        case "get_voice_status":
          return await this.getVoiceStatus(callId, context);
      }
    } catch (error) {
      return this.errorResult(callId, this.formatError(error));
    }
  }

  private async enableVoice(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const language = this.optionalString(args.language);
    const mode = this.optionalInputMode(args.mode, "'mode' must be either 'push-to-talk' or 'continuous'.");

    const status = await this.backendClient.enableVoice({
      conversationId: context.conversationId,
      userId: context.userId,
      language,
      mode,
    });

    return this.successResult(callId, {
      action: "enable_voice",
      status,
    });
  }

  private async disableVoice(callId: string, context: ToolContext): Promise<ToolResult> {
    await this.backendClient.disableVoice({
      conversationId: context.conversationId,
      userId: context.userId,
    });

    return this.successResult(callId, {
      action: "disable_voice",
      success: true,
    });
  }

  private async setLanguage(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const language = this.requireString(args.language, "'language' is required for set_language action.");

    const status = await this.backendClient.setLanguage({
      conversationId: context.conversationId,
      userId: context.userId,
      language,
    });

    return this.successResult(callId, {
      action: "set_language",
      status,
    });
  }

  private async setInputMode(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const mode = this.requireInputMode(args.mode, "'mode' is required for set_input_mode action.");

    const status = await this.backendClient.setInputMode({
      conversationId: context.conversationId,
      userId: context.userId,
      mode,
    });

    return this.successResult(callId, {
      action: "set_input_mode",
      status,
    });
  }

  private async getVoiceStatus(callId: string, context: ToolContext): Promise<ToolResult> {
    const status = await this.backendClient.getVoiceStatus({
      conversationId: context.conversationId,
      userId: context.userId,
    });

    return this.successResult(callId, {
      action: "get_voice_status",
      status,
    });
  }

  private normalizeAction(value: unknown): VoiceAction | null {
    const action = this.readString(value);
    if (!action) {
      return null;
    }

    if (
      action === "enable_voice" ||
      action === "disable_voice" ||
      action === "set_language" ||
      action === "set_input_mode" ||
      action === "get_voice_status"
    ) {
      return action;
    }

    return null;
  }

  private requireInputMode(value: unknown, message: string): VoiceInputMode {
    if (value === undefined) {
      throw new Error(message);
    }

    const mode = this.optionalInputMode(value, "'mode' must be either 'push-to-talk' or 'continuous'.");
    if (!mode) {
      throw new Error("'mode' must be either 'push-to-talk' or 'continuous'.");
    }

    return mode;
  }

  private optionalInputMode(value: unknown, message: string): VoiceInputMode | undefined {
    if (value === undefined) {
      return undefined;
    }

    const mode = this.readString(value);
    if (!mode) {
      throw new Error(message);
    }

    if (mode === "push-to-talk" || mode === "continuous") {
      return mode;
    }

    throw new Error(message);
  }

  private successResult(callId: string, result: unknown): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result,
    };
  }

  private errorResult(callId: string, error: string): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result: null,
      error,
    };
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
      throw new Error(message);
    }
    return read;
  }

  private optionalString(value: unknown): string | undefined {
    const read = this.readString(value);
    return read ?? undefined;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Voice tool execution failed.";
  }
}

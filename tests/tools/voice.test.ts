import { describe, expect, it } from "bun:test";

import { ToolRegistry, VoiceTool, type VoiceBackendClient, type VoiceStatus } from "../../src/tools";
import type { ToolContext } from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "conv-voice-123",
  userId: "user-voice-123",
  workspaceId: "ws-voice-123",
};

describe("VoiceTool", () => {
  it("registers in ToolRegistry and exposes definition", () => {
    const tool = new VoiceTool(createMockBackendClient());
    const registry = new ToolRegistry();

    registry.register(tool);

    const definition = registry.getDefinitions()[0];
    expect(definition?.name).toBe("voice");
    expect(definition?.parameters.required).toEqual(["action"]);
  });

  it("enables voice mode", async () => {
    let capturedLanguage: string | undefined;
    let capturedMode: string | undefined;

    const tool = new VoiceTool(
      createMockBackendClient({
        async enableVoice(params) {
          capturedLanguage = params.language;
          capturedMode = params.mode;
          return {
            enabled: true,
            language: params.language ?? "en-US",
            inputMode: params.mode ?? "push-to-talk",
            isListening: true,
            isSpeaking: false,
          };
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-enable",
        action: "enable_voice",
        language: "es-ES",
        mode: "continuous",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as { action: string; status: VoiceStatus };
    expect(payload.action).toBe("enable_voice");
    expect(payload.status.enabled).toBe(true);
    expect(payload.status.language).toBe("es-ES");
    expect(payload.status.inputMode).toBe("continuous");
    expect(capturedLanguage).toBe("es-ES");
    expect(capturedMode).toBe("continuous");
  });

  it("disables voice mode", async () => {
    let disableCalled = false;

    const tool = new VoiceTool(
      createMockBackendClient({
        async disableVoice() {
          disableCalled = true;
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-disable",
        action: "disable_voice",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(disableCalled).toBe(true);
    expect(result.result).toEqual({ action: "disable_voice", success: true });
  });

  it("sets language", async () => {
    let capturedLanguage: string | undefined;

    const tool = new VoiceTool(
      createMockBackendClient({
        async setLanguage(params) {
          capturedLanguage = params.language;
          return {
            enabled: true,
            language: params.language,
            inputMode: "push-to-talk",
            isListening: false,
            isSpeaking: false,
          };
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-language",
        action: "set_language",
        language: "fr-FR",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedLanguage).toBe("fr-FR");
    const payload = result.result as { action: string; status: VoiceStatus };
    expect(payload.action).toBe("set_language");
    expect(payload.status.language).toBe("fr-FR");
  });

  it("sets input mode", async () => {
    let capturedMode: string | undefined;

    const tool = new VoiceTool(
      createMockBackendClient({
        async setInputMode(params) {
          capturedMode = params.mode;
          return {
            enabled: true,
            language: "en-US",
            inputMode: params.mode,
            isListening: false,
            isSpeaking: false,
          };
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-mode",
        action: "set_input_mode",
        mode: "continuous",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedMode).toBe("continuous");
    const payload = result.result as { action: string; status: VoiceStatus };
    expect(payload.action).toBe("set_input_mode");
    expect(payload.status.inputMode).toBe("continuous");
  });

  it("gets voice status", async () => {
    const tool = new VoiceTool(
      createMockBackendClient({
        async getVoiceStatus() {
          return {
            enabled: true,
            language: "en-US",
            inputMode: "push-to-talk",
            isListening: true,
            isSpeaking: false,
          };
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-status",
        action: "get_voice_status",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as { action: string; status: VoiceStatus };
    expect(payload.action).toBe("get_voice_status");
    expect(payload.status.enabled).toBe(true);
    expect(payload.status.isListening).toBe(true);
  });

  it("returns error for invalid action", async () => {
    const tool = new VoiceTool(createMockBackendClient());

    const result = await tool.execute({ callId: "call-invalid", action: "unknown" }, toolContext);

    expect(result.error).toBe("Missing or invalid 'action' argument.");
  });

  it("returns validation errors for missing required params", async () => {
    const tool = new VoiceTool(createMockBackendClient());

    const missingLanguage = await tool.execute(
      {
        callId: "call-missing-language",
        action: "set_language",
      },
      toolContext,
    );
    expect(missingLanguage.error).toBe("'language' is required for set_language action.");

    const missingMode = await tool.execute(
      {
        callId: "call-missing-mode",
        action: "set_input_mode",
      },
      toolContext,
    );
    expect(missingMode.error).toBe("'mode' is required for set_input_mode action.");

    const invalidMode = await tool.execute(
      {
        callId: "call-invalid-mode",
        action: "set_input_mode",
        mode: "always-on",
      },
      toolContext,
    );
    expect(invalidMode.error).toBe("'mode' must be either 'push-to-talk' or 'continuous'.");
  });

  it("returns backend client errors", async () => {
    const tool = new VoiceTool(
      createMockBackendClient({
        async getVoiceStatus() {
          throw new Error("Backend unavailable");
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-backend-error",
        action: "get_voice_status",
      },
      toolContext,
    );

    expect(result.error).toBe("Backend unavailable");
  });
});

function createMockBackendClient(overrides?: Partial<VoiceBackendClient>): VoiceBackendClient {
  return {
    async enableVoice(params) {
      if (overrides?.enableVoice) {
        return overrides.enableVoice(params);
      }

      return {
        enabled: true,
        language: params.language ?? "en-US",
        inputMode: params.mode ?? "push-to-talk",
        isListening: true,
        isSpeaking: false,
      };
    },
    async disableVoice(params) {
      if (overrides?.disableVoice) {
        return overrides.disableVoice(params);
      }
    },
    async setLanguage(params) {
      if (overrides?.setLanguage) {
        return overrides.setLanguage(params);
      }

      return {
        enabled: true,
        language: params.language,
        inputMode: "push-to-talk",
        isListening: false,
        isSpeaking: false,
      };
    },
    async setInputMode(params) {
      if (overrides?.setInputMode) {
        return overrides.setInputMode(params);
      }

      return {
        enabled: true,
        language: "en-US",
        inputMode: params.mode,
        isListening: false,
        isSpeaking: false,
      };
    },
    async getVoiceStatus(params) {
      if (overrides?.getVoiceStatus) {
        return overrides.getVoiceStatus(params);
      }

      return {
        enabled: false,
        language: "en-US",
        inputMode: "push-to-talk",
        isListening: false,
        isSpeaking: false,
      };
    },
  };
}

import { BaseVoiceInput } from "./input";
import type { VoiceActivityDetector } from "./input";
import { DEFAULT_VOICE_INPUT_CONFIG } from "./types";
import type { VoiceError, VoiceInputConfig, VoiceInputEvents, VoiceTranscript } from "./types";

type MockCallMethod =
  | "start"
  | "stop"
  | "simulateTranscript"
  | "simulateError"
  | "on"
  | "off";

export interface MockVoiceInputCall {
  method: MockCallMethod;
  timestamp: number;
  details?: Record<string, string | number | boolean | undefined>;
}

export interface MockVoiceInputOptions {
  supported?: boolean;
  supportedLanguages?: string[];
  voiceActivityDetector?: VoiceActivityDetector;
}

const DEFAULT_SUPPORTED_LANGUAGES = ["en-US", "es-ES", "fr-FR", "de-DE"];

const DEFAULT_VOICE_ACTIVITY_DETECTOR: VoiceActivityDetector = {
  shouldAutoStop(elapsedSilenceMs: number, config: VoiceInputConfig): boolean {
    const timeout = config.silenceTimeout ?? DEFAULT_VOICE_INPUT_CONFIG.silenceTimeout ?? 0;
    return elapsedSilenceMs >= timeout;
  },
};

export class MockVoiceInput extends BaseVoiceInput {
  private readonly supported: boolean;
  private readonly supportedLanguages: string[];
  private readonly voiceActivityDetector: VoiceActivityDetector;
  private readonly callLog: MockVoiceInputCall[] = [];

  private partialTranscriptText = "";
  private finalTranscript: VoiceTranscript | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSpeechTimestamp = 0;

  constructor(options: MockVoiceInputOptions = {}) {
    super();
    this.supported = options.supported ?? true;
    this.supportedLanguages = options.supportedLanguages ?? DEFAULT_SUPPORTED_LANGUAGES;
    this.voiceActivityDetector = options.voiceActivityDetector ?? DEFAULT_VOICE_ACTIVITY_DETECTOR;
  }

  public override on<E extends keyof VoiceInputEvents>(event: E, handler: VoiceInputEvents[E]): void {
    this.recordCall("on", { event });
    super.on(event, handler);
  }

  public override off<E extends keyof VoiceInputEvents>(event: E, handler: VoiceInputEvents[E]): void {
    this.recordCall("off", { event });
    super.off(event, handler);
  }

  public isSupported(): boolean {
    return this.supported;
  }

  public getSupportedLanguages(): string[] {
    return [...this.supportedLanguages];
  }

  public async start(config?: Partial<VoiceInputConfig>): Promise<void> {
    this.recordCall("start", {
      mode: config?.mode,
      language: config?.language,
      sampleRate: config?.sampleRate,
      silenceTimeout: config?.silenceTimeout,
      maxDuration: config?.maxDuration,
    });

    const state = this.getState();
    if (state === "listening" || state === "processing") {
      this.emitError({
        code: "already-listening",
        message: "Voice input is already active",
        recoverable: true,
      });
      throw new Error("Voice input is already listening");
    }

    if (!this.isSupported()) {
      const error: VoiceError = {
        code: "not-supported",
        message: "Voice input is not supported on this platform",
        recoverable: false,
      };
      this.emitError(error);
      this.setState("error");
      throw new Error(error.message);
    }

    const mergedConfig = this.mergeConfig(config);
    this.partialTranscriptText = "";
    this.finalTranscript = null;
    this.lastSpeechTimestamp = Date.now();

    this.clearTimers();
    this.setState("listening");

    if (mergedConfig.mode === "continuous") {
      this.scheduleSilenceTimeout();
    }

    if (mergedConfig.maxDuration && mergedConfig.maxDuration > 0) {
      this.maxDurationTimer = setTimeout(() => {
        void this.stop();
      }, mergedConfig.maxDuration);
    }
  }

  public async stop(): Promise<VoiceTranscript | null> {
    this.recordCall("stop");

    const state = this.getState();
    if (state === "idle") {
      return null;
    }

    this.clearTimers();
    this.setState("processing");

    const transcript = this.getFinalTranscript();
    this.setState("idle");

    return transcript;
  }

  public simulateTranscript(text: string, isFinal: boolean, confidence?: number): VoiceTranscript {
    this.recordCall("simulateTranscript", {
      textLength: text.length,
      isFinal,
      confidence,
    });

    if (this.getState() !== "listening") {
      throw new Error("Cannot simulate transcript while voice input is not listening");
    }

    const config = this.getConfig();
    const transcript: VoiceTranscript = {
      text,
      isFinal,
      confidence,
      language: config.language,
      timestamp: Date.now(),
    };

    this.lastSpeechTimestamp = transcript.timestamp;

    if (isFinal) {
      this.finalTranscript = transcript;
      this.partialTranscriptText = "";
    } else {
      this.partialTranscriptText = text;
    }

    this.emitTranscript(transcript);

    if (config.mode === "continuous") {
      this.scheduleSilenceTimeout();
    }

    return transcript;
  }

  public simulateError(code: string, message: string, recoverable = true): void {
    this.recordCall("simulateError", { code, recoverable });

    const error: VoiceError = {
      code,
      message,
      recoverable,
    };

    this.clearTimers();
    this.emitError(error);
    this.setState("error");
  }

  public getCallLog(): MockVoiceInputCall[] {
    return [...this.callLog];
  }

  public clearCallLog(): void {
    this.callLog.length = 0;
  }

  private scheduleSilenceTimeout(): void {
    const config = this.getConfig();
    if (config.mode !== "continuous") {
      return;
    }

    if (!config.silenceTimeout || config.silenceTimeout <= 0) {
      return;
    }

    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }

    this.silenceTimer = setTimeout(() => {
      const elapsedSilenceMs = Date.now() - this.lastSpeechTimestamp;
      const shouldStop = this.voiceActivityDetector.shouldAutoStop(elapsedSilenceMs, config);

      if (shouldStop && this.getState() === "listening") {
        void this.stop();
      }
    }, config.silenceTimeout);
  }

  private getFinalTranscript(): VoiceTranscript | null {
    if (this.finalTranscript) {
      return this.finalTranscript;
    }

    if (!this.partialTranscriptText) {
      return null;
    }

    const config = this.getConfig();
    const transcript: VoiceTranscript = {
      text: this.partialTranscriptText,
      isFinal: true,
      language: config.language,
      timestamp: Date.now(),
    };

    this.finalTranscript = transcript;
    this.emitTranscript(transcript);
    this.partialTranscriptText = "";

    return transcript;
  }

  private clearTimers(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
  }

  private recordCall(method: MockCallMethod, details?: Record<string, string | number | boolean | undefined>): void {
    this.callLog.push({
      method,
      timestamp: Date.now(),
      details,
    });
  }
}

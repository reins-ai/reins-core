import { BaseVoiceOutput } from "./output";
import type { VoiceOutputEvents } from "./types";
import type { VoiceInfo } from "./output";
import type { VoiceError, VoiceOutputConfig } from "./types";

type MockCallMethod = "speak" | "stop" | "pause" | "resume" | "simulateComplete" | "simulateError" | "simulateBoundary" | "on" | "off";

export interface MockVoiceOutputCall {
  method: MockCallMethod;
  timestamp: number;
  details?: Record<string, string | number | boolean | undefined>;
}

export interface MockVoiceOutputOptions {
  supported?: boolean;
  availableVoices?: VoiceInfo[];
}

const DEFAULT_AVAILABLE_VOICES: VoiceInfo[] = [
  { id: "en-us-default", name: "English (US)", language: "en-US" },
  { id: "en-gb-default", name: "English (UK)", language: "en-GB" },
  { id: "es-es-default", name: "Spanish (Spain)", language: "es-ES" },
];

export class MockVoiceOutput extends BaseVoiceOutput {
  private readonly supported: boolean;
  private readonly availableVoices: VoiceInfo[];
  private readonly callLog: MockVoiceOutputCall[] = [];
  private readonly spokenTextHistory: string[] = [];

  private activeText: string | null = null;

  constructor(options: MockVoiceOutputOptions = {}) {
    super();
    this.supported = options.supported ?? true;
    this.availableVoices = options.availableVoices ?? DEFAULT_AVAILABLE_VOICES;
  }

  public override on<E extends keyof VoiceOutputEvents>(
    event: E,
    handler: NonNullable<VoiceOutputEvents[E]>,
  ): void {
    this.recordCall("on", { event });
    super.on(event, handler);
  }

  public override off<E extends keyof VoiceOutputEvents>(
    event: E,
    handler: NonNullable<VoiceOutputEvents[E]>,
  ): void {
    this.recordCall("off", { event });
    super.off(event, handler);
  }

  public async speak(text: string, config?: Partial<VoiceOutputConfig>): Promise<void> {
    this.recordCall("speak", {
      textLength: text.length,
      language: config?.language,
      voice: config?.voice,
      rate: config?.rate,
      pitch: config?.pitch,
      volume: config?.volume,
    });

    const normalizedText = text.trim();
    if (normalizedText.length === 0) {
      throw new Error("Voice output text must not be empty.");
    }

    if (!this.supported) {
      const error: VoiceError = {
        code: "not-supported",
        message: "Voice output is not supported on this platform",
        recoverable: false,
      };
      this.emitError(error);
      this.setState("error");
      throw new Error(error.message);
    }

    if (this.getState() === "speaking" || this.getState() === "paused") {
      this.stop();
    }

    this.mergeConfig(config);
    this.activeText = normalizedText;
    this.spokenTextHistory.push(normalizedText);
    this.setState("speaking");
  }

  public stop(): void {
    this.recordCall("stop");

    const state = this.getState();
    if (state === "idle") {
      return;
    }

    this.activeText = null;
    this.setState("idle");
  }

  public pause(): void {
    this.recordCall("pause");

    if (this.getState() !== "speaking") {
      return;
    }

    this.setState("paused");
  }

  public resume(): void {
    this.recordCall("resume");

    if (this.getState() !== "paused") {
      return;
    }

    this.setState("speaking");
  }

  public isSupported(): boolean {
    return this.supported;
  }

  public getAvailableVoices(): VoiceInfo[] {
    return [...this.availableVoices];
  }

  public simulateComplete(): void {
    this.recordCall("simulateComplete");

    if (this.getState() !== "speaking" && this.getState() !== "paused") {
      return;
    }

    this.activeText = null;
    this.emitComplete();
    this.setState("idle");
  }

  public simulateError(code: string, message: string, recoverable = true): void {
    this.recordCall("simulateError", { code, recoverable });

    const error: VoiceError = {
      code,
      message,
      recoverable,
    };

    this.activeText = null;
    this.emitError(error);
    this.setState("error");
  }

  public simulateBoundary(word: string, charIndex: number): void {
    this.recordCall("simulateBoundary", { word, charIndex });

    if (this.getState() !== "speaking" && this.getState() !== "paused") {
      return;
    }

    this.emitBoundary({ word, charIndex });
  }

  public getSpokenTextHistory(): string[] {
    return [...this.spokenTextHistory];
  }

  public clearSpokenTextHistory(): void {
    this.spokenTextHistory.length = 0;
  }

  public getCallLog(): MockVoiceOutputCall[] {
    return [...this.callLog];
  }

  public clearCallLog(): void {
    this.callLog.length = 0;
  }

  public getActiveText(): string | null {
    return this.activeText;
  }

  private recordCall(method: MockCallMethod, details?: Record<string, string | number | boolean | undefined>): void {
    this.callLog.push({
      method,
      timestamp: Date.now(),
      details,
    });
  }
}

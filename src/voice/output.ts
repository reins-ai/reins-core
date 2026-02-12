import { DEFAULT_VOICE_OUTPUT_CONFIG } from "./types";
import type { VoiceError, VoiceOutputConfig, VoiceOutputEvents, VoiceOutputState } from "./types";

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
}

export type VoiceOutputEventName = keyof VoiceOutputEvents;

export interface VoiceOutputPlatformAdapter {
  isSupported(): boolean;
  getAvailableVoices(): VoiceInfo[];
  speak(text: string, config: VoiceOutputConfig, events: VoiceOutputEvents): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): void;
}

export interface VoiceOutput {
  speak(text: string, config?: Partial<VoiceOutputConfig>): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): void;
  getState(): VoiceOutputState;
  getConfig(): VoiceOutputConfig;
  on<E extends VoiceOutputEventName>(event: E, handler: NonNullable<VoiceOutputEvents[E]>): void;
  off<E extends VoiceOutputEventName>(event: E, handler: NonNullable<VoiceOutputEvents[E]>): void;
  isSupported(): boolean;
  getAvailableVoices(): VoiceInfo[];
}

type VoiceBoundary = { word: string; charIndex: number };

export abstract class BaseVoiceOutput implements VoiceOutput {
  private state: VoiceOutputState = "idle";
  private config: VoiceOutputConfig = { ...DEFAULT_VOICE_OUTPUT_CONFIG };

  private readonly listeners: {
    onComplete: Set<() => void>;
    onError: Set<(error: VoiceError) => void>;
    onStateChange: Set<(state: VoiceOutputState) => void>;
    onBoundary: Set<(boundary: VoiceBoundary) => void>;
  } = {
    onComplete: new Set(),
    onError: new Set(),
    onStateChange: new Set(),
    onBoundary: new Set(),
  };

  public abstract speak(text: string, config?: Partial<VoiceOutputConfig>): Promise<void>;

  public abstract stop(): void;

  public abstract pause(): void;

  public abstract resume(): void;

  public abstract isSupported(): boolean;

  public abstract getAvailableVoices(): VoiceInfo[];

  public getState(): VoiceOutputState {
    return this.state;
  }

  public getConfig(): VoiceOutputConfig {
    return { ...this.config };
  }

  public on<E extends VoiceOutputEventName>(event: E, handler: NonNullable<VoiceOutputEvents[E]>): void {
    if (event === "onComplete") {
      this.listeners.onComplete.add(handler as () => void);
      return;
    }

    if (event === "onError") {
      this.listeners.onError.add(handler as (error: VoiceError) => void);
      return;
    }

    if (event === "onStateChange") {
      this.listeners.onStateChange.add(handler as (state: VoiceOutputState) => void);
      return;
    }

    this.listeners.onBoundary.add(handler as (boundary: VoiceBoundary) => void);
  }

  public off<E extends VoiceOutputEventName>(event: E, handler: NonNullable<VoiceOutputEvents[E]>): void {
    if (event === "onComplete") {
      this.listeners.onComplete.delete(handler as () => void);
      return;
    }

    if (event === "onError") {
      this.listeners.onError.delete(handler as (error: VoiceError) => void);
      return;
    }

    if (event === "onStateChange") {
      this.listeners.onStateChange.delete(handler as (state: VoiceOutputState) => void);
      return;
    }

    this.listeners.onBoundary.delete(handler as (boundary: VoiceBoundary) => void);
  }

  protected mergeConfig(config?: Partial<VoiceOutputConfig>): VoiceOutputConfig {
    this.config = {
      ...this.config,
      ...config,
    };

    return { ...this.config };
  }

  protected setState(state: VoiceOutputState): void {
    this.state = state;
    for (const handler of this.listeners.onStateChange) {
      handler(state);
    }
  }

  protected emitComplete(): void {
    for (const handler of this.listeners.onComplete) {
      handler();
    }
  }

  protected emitError(error: VoiceError): void {
    for (const handler of this.listeners.onError) {
      handler(error);
    }
  }

  protected emitBoundary(boundary: VoiceBoundary): void {
    for (const handler of this.listeners.onBoundary) {
      handler(boundary);
    }
  }
}

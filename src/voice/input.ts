import { DEFAULT_VOICE_INPUT_CONFIG } from "./types";
import type {
  VoiceError,
  VoiceInputConfig,
  VoiceInputEvents,
  VoiceInputState,
  VoiceTranscript,
} from "./types";

export type VoiceInputEventName = keyof VoiceInputEvents;

export interface VoiceActivityDetector {
  shouldAutoStop(elapsedSilenceMs: number, config: VoiceInputConfig): boolean;
}

export interface VoiceInputPlatformAdapter {
  isSupported(): boolean;
  getSupportedLanguages(): string[];
  start(config: VoiceInputConfig, events: VoiceInputEvents): Promise<void>;
  stop(): Promise<VoiceTranscript | null>;
}

export interface VoiceInput {
  start(config?: Partial<VoiceInputConfig>): Promise<void>;
  stop(): Promise<VoiceTranscript | null>;
  getState(): VoiceInputState;
  getConfig(): VoiceInputConfig;
  on<E extends VoiceInputEventName>(event: E, handler: VoiceInputEvents[E]): void;
  off<E extends VoiceInputEventName>(event: E, handler: VoiceInputEvents[E]): void;
  isSupported(): boolean;
  getSupportedLanguages(): string[];
}

export abstract class BaseVoiceInput implements VoiceInput {
  private state: VoiceInputState = "idle";
  private config: VoiceInputConfig = { ...DEFAULT_VOICE_INPUT_CONFIG };

  private readonly listeners: {
    [K in VoiceInputEventName]: Set<VoiceInputEvents[K]>;
  } = {
    onTranscript: new Set(),
    onError: new Set(),
    onStateChange: new Set(),
  };

  public abstract isSupported(): boolean;

  public abstract getSupportedLanguages(): string[];

  public abstract start(config?: Partial<VoiceInputConfig>): Promise<void>;

  public abstract stop(): Promise<VoiceTranscript | null>;

  public getState(): VoiceInputState {
    return this.state;
  }

  public getConfig(): VoiceInputConfig {
    return { ...this.config };
  }

  public on<E extends VoiceInputEventName>(event: E, handler: VoiceInputEvents[E]): void {
    const handlers = this.listeners[event] as Set<VoiceInputEvents[E]>;
    handlers.add(handler);
  }

  public off<E extends VoiceInputEventName>(event: E, handler: VoiceInputEvents[E]): void {
    const handlers = this.listeners[event] as Set<VoiceInputEvents[E]>;
    handlers.delete(handler);
  }

  protected mergeConfig(config?: Partial<VoiceInputConfig>): VoiceInputConfig {
    this.config = {
      ...this.config,
      ...config,
    };
    return { ...this.config };
  }

  protected setState(state: VoiceInputState): void {
    this.state = state;
    this.emit("onStateChange", state);
  }

  protected emitTranscript(transcript: VoiceTranscript): void {
    this.emit("onTranscript", transcript);
  }

  protected emitError(error: VoiceError): void {
    this.emit("onError", error);
  }

  private emit<E extends VoiceInputEventName>(event: E, payload: Parameters<VoiceInputEvents[E]>[0]): void {
    const handlers = this.listeners[event] as Set<(value: Parameters<VoiceInputEvents[E]>[0]) => void>;
    for (const handler of handlers) {
      handler(payload);
    }
  }
}

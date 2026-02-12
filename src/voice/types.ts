export type VoiceInputMode = "push-to-talk" | "continuous";

export type VoiceInputState = "idle" | "listening" | "processing" | "error";

export interface VoiceInputConfig {
  language: string;
  mode: VoiceInputMode;
  sampleRate?: number;
  silenceTimeout?: number;
  maxDuration?: number;
}

export interface VoiceTranscript {
  text: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
  timestamp: number;
}

export interface VoiceError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface VoiceInputEvents {
  onTranscript: (transcript: VoiceTranscript) => void;
  onError: (error: VoiceError) => void;
  onStateChange: (state: VoiceInputState) => void;
}

export type VoiceOutputState = "idle" | "speaking" | "paused" | "error";

export interface VoiceOutputConfig {
  language: string;
  voice?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

export interface VoiceOutputEvents {
  onComplete: () => void;
  onError: (error: VoiceError) => void;
  onStateChange: (state: VoiceOutputState) => void;
  onBoundary?: (boundary: { word: string; charIndex: number }) => void;
}

export const DEFAULT_VOICE_INPUT_CONFIG: VoiceInputConfig = {
  language: "en-US",
  mode: "push-to-talk",
  sampleRate: 16_000,
  silenceTimeout: 1_500,
  maxDuration: 30_000,
};

export const DEFAULT_VOICE_OUTPUT_CONFIG: VoiceOutputConfig = {
  language: "en-US",
  rate: 1,
  pitch: 1,
  volume: 1,
};

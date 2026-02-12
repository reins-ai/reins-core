import { describe, expect, it } from "bun:test";

import { MockVoiceOutput } from "../../src/voice";
import type { VoiceError, VoiceOutputState } from "../../src/voice";

describe("MockVoiceOutput", () => {
  it("tracks state transitions for speak, pause, resume, stop", async () => {
    const output = new MockVoiceOutput();
    const states: VoiceOutputState[] = [];

    output.on("onStateChange", (state) => {
      states.push(state);
    });

    await output.speak("Hello there");
    output.pause();
    output.resume();
    output.stop();

    expect(states).toEqual(["speaking", "paused", "speaking", "idle"]);
    expect(output.getState()).toBe("idle");
  });

  it("supports event subscription and unsubscription", async () => {
    const output = new MockVoiceOutput();
    const completed: string[] = [];
    const boundaries: Array<{ word: string; charIndex: number }> = [];
    const errors: VoiceError[] = [];

    const onComplete = (): void => {
      completed.push("done");
    };
    const onBoundary = (boundary: { word: string; charIndex: number }): void => {
      boundaries.push(boundary);
    };
    const onError = (error: VoiceError): void => {
      errors.push(error);
    };

    output.on("onComplete", onComplete);
    output.on("onBoundary", onBoundary);
    output.on("onError", onError);

    await output.speak("hello world");
    output.simulateBoundary("hello", 0);
    output.off("onBoundary", onBoundary);
    output.simulateBoundary("world", 6);
    output.simulateComplete();
    output.simulateError("synthesis-failed", "TTS failed", true);

    expect(completed).toEqual(["done"]);
    expect(boundaries).toEqual([{ word: "hello", charIndex: 0 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("synthesis-failed");
  });

  it("tracks spoken text history", async () => {
    const output = new MockVoiceOutput();

    await output.speak("First phrase");
    output.simulateComplete();
    await output.speak("Second phrase");

    expect(output.getSpokenTextHistory()).toEqual(["First phrase", "Second phrase"]);
  });

  it("applies default config and supports overrides", async () => {
    const output = new MockVoiceOutput();

    expect(output.getConfig()).toEqual({
      language: "en-US",
      rate: 1,
      pitch: 1,
      volume: 1,
    });

    await output.speak("Hola", {
      language: "es-ES",
      voice: "es-es-default",
      rate: 1.1,
      pitch: 0.9,
      volume: 0.8,
    });

    expect(output.getConfig()).toEqual({
      language: "es-ES",
      voice: "es-es-default",
      rate: 1.1,
      pitch: 0.9,
      volume: 0.8,
    });
  });

  it("returns available voices", () => {
    const output = new MockVoiceOutput({
      availableVoices: [
        { id: "voice-1", name: "Voice One", language: "en-US" },
        { id: "voice-2", name: "Voice Two", language: "fr-FR" },
      ],
    });

    expect(output.getAvailableVoices()).toEqual([
      { id: "voice-1", name: "Voice One", language: "en-US" },
      { id: "voice-2", name: "Voice Two", language: "fr-FR" },
    ]);
  });

  it("stops current speech when speak is called while speaking", async () => {
    const output = new MockVoiceOutput();

    await output.speak("First");
    await output.speak("Second");

    expect(output.getState()).toBe("speaking");
    expect(output.getSpokenTextHistory()).toEqual(["First", "Second"]);

    const methods = output.getCallLog().map((call) => call.method);
    expect(methods).toContain("stop");
  });

  it("supports pause and resume without losing active text", async () => {
    const output = new MockVoiceOutput();

    await output.speak("Pause and resume");
    output.pause();
    expect(output.getState()).toBe("paused");
    expect(output.getActiveText()).toBe("Pause and resume");

    output.resume();
    expect(output.getState()).toBe("speaking");
    expect(output.getActiveText()).toBe("Pause and resume");
  });

  it("transitions to error state when simulateError is triggered during speaking", async () => {
    const output = new MockVoiceOutput();
    const errors: VoiceError[] = [];

    output.on("onError", (error) => {
      errors.push(error);
    });

    await output.speak("This will fail");
    output.simulateError("audio-device", "Audio device unavailable", false);

    expect(output.getState()).toBe("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      code: "audio-device",
      message: "Audio device unavailable",
      recoverable: false,
    });
  });
});

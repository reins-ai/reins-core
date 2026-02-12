import { describe, expect, it } from "bun:test";

import { MockVoiceInput } from "../../src/voice";
import type { VoiceError, VoiceInputState, VoiceTranscript } from "../../src/voice";

describe("MockVoiceInput", () => {
  it("tracks state transitions idle -> listening -> processing -> idle", async () => {
    const input = new MockVoiceInput();
    const states: VoiceInputState[] = [];

    input.on("onStateChange", (state) => {
      states.push(state);
    });

    await input.start();
    input.simulateTranscript("hello world", false);
    await input.stop();

    expect(states).toEqual(["listening", "processing", "idle"]);
    expect(input.getState()).toBe("idle");
  });

  it("supports push-to-talk mode and returns final transcript on stop", async () => {
    const input = new MockVoiceInput();

    await input.start({ mode: "push-to-talk" });
    input.simulateTranscript("book a meeting for tomorrow", false, 0.87);

    const transcript = await input.stop();

    expect(transcript).not.toBeNull();
    expect(transcript?.text).toBe("book a meeting for tomorrow");
    expect(transcript?.isFinal).toBe(true);
    expect(transcript?.language).toBe("en-US");
  });

  it("supports continuous mode with partial and final transcripts", async () => {
    const input = new MockVoiceInput();
    const transcripts: VoiceTranscript[] = [];

    input.on("onTranscript", (transcript) => {
      transcripts.push(transcript);
    });

    await input.start({ mode: "continuous", silenceTimeout: 1000 });
    input.simulateTranscript("schedule", false, 0.64);
    input.simulateTranscript("schedule lunch tomorrow", false, 0.82);
    input.simulateTranscript("schedule lunch tomorrow at noon", true, 0.94);

    const transcript = await input.stop();

    expect(transcripts).toHaveLength(3);
    expect(transcripts[0]?.isFinal).toBe(false);
    expect(transcripts[2]?.isFinal).toBe(true);
    expect(transcript?.text).toBe("schedule lunch tomorrow at noon");
    expect(transcript?.isFinal).toBe(true);
  });

  it("handles errors during listening and allows recovery", async () => {
    const input = new MockVoiceInput();
    const errors: VoiceError[] = [];

    input.on("onError", (error) => {
      errors.push(error);
    });

    await input.start();
    input.simulateError("mic-denied", "Microphone permission denied", true);

    expect(input.getState()).toBe("error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("mic-denied");

    await input.start({ mode: "push-to-talk" });
    expect(input.getState()).toBe("listening");
  });

  it("supports event subscription and unsubscription", async () => {
    const input = new MockVoiceInput();
    const transcripts: VoiceTranscript[] = [];

    const onTranscript = (transcript: VoiceTranscript): void => {
      transcripts.push(transcript);
    };

    input.on("onTranscript", onTranscript);

    await input.start();
    input.simulateTranscript("first", false);
    input.off("onTranscript", onTranscript);
    input.simulateTranscript("second", false);
    await input.stop();

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.text).toBe("first");
  });

  it("applies default config and supports runtime overrides", async () => {
    const input = new MockVoiceInput();

    expect(input.getConfig()).toEqual({
      language: "en-US",
      mode: "push-to-talk",
      sampleRate: 16000,
      silenceTimeout: 1500,
      maxDuration: 30000,
    });

    await input.start({
      language: "es-ES",
      mode: "continuous",
      sampleRate: 22050,
      silenceTimeout: 300,
      maxDuration: 500,
    });

    expect(input.getConfig()).toEqual({
      language: "es-ES",
      mode: "continuous",
      sampleRate: 22050,
      silenceTimeout: 300,
      maxDuration: 500,
    });
  });

  it("uses selected language for transcripts and exposes supported languages", async () => {
    const input = new MockVoiceInput({ supportedLanguages: ["en-US", "fr-FR"] });

    await input.start({ language: "fr-FR" });
    const transcript = input.simulateTranscript("bonjour", true);

    expect(transcript.language).toBe("fr-FR");
    expect(input.getSupportedLanguages()).toEqual(["en-US", "fr-FR"]);
  });

  it("auto-stops in continuous mode after silence timeout", async () => {
    const input = new MockVoiceInput();

    await input.start({ mode: "continuous", silenceTimeout: 20 });
    input.simulateTranscript("still listening", false);

    await Bun.sleep(60);

    expect(input.getState()).toBe("idle");

    const stopCalls = input.getCallLog().filter((call) => call.method === "stop");
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("auto-stops after max duration", async () => {
    const input = new MockVoiceInput();

    await input.start({ mode: "push-to-talk", maxDuration: 20 });
    await Bun.sleep(60);

    expect(input.getState()).toBe("idle");

    const stopCalls = input.getCallLog().filter((call) => call.method === "stop");
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("throws and emits an error when start is called while listening", async () => {
    const input = new MockVoiceInput();
    const errors: VoiceError[] = [];

    input.on("onError", (error) => {
      errors.push(error);
    });

    await input.start();

    await expect(input.start()).rejects.toThrow("Voice input is already listening");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("already-listening");
    expect(input.getState()).toBe("listening");
  });

  it("returns null when stop is called while idle", async () => {
    const input = new MockVoiceInput();

    const transcript = await input.stop();

    expect(transcript).toBeNull();
  });

  it("records method calls for assertions", async () => {
    const input = new MockVoiceInput();

    await input.start({ language: "de-DE" });
    input.simulateTranscript("hallo", true);
    await input.stop();

    const methods = input.getCallLog().map((entry) => entry.method);
    expect(methods).toContain("start");
    expect(methods).toContain("simulateTranscript");
    expect(methods).toContain("stop");
  });
});

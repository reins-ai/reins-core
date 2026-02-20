import { describe, expect, test } from "bun:test";

import {
  classifyAsBackgroundTask,
  extractTaskDescription,
} from "../../src/tasks/classifier";

describe("classifyAsBackgroundTask", () => {
  describe("explicit /task command", () => {
    test("triggers with confidence 1.0", () => {
      const result = classifyAsBackgroundTask("/task research quantum computing");
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(1.0);
      expect(result.reason).toBe("Explicit /task command");
    });

    test("works with minimal description", () => {
      const result = classifyAsBackgroundTask("/task summarize");
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(1.0);
    });

    test("works with leading whitespace", () => {
      const result = classifyAsBackgroundTask("  /task do something");
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(1.0);
    });

    test("does not match /task without description", () => {
      const result = classifyAsBackgroundTask("/task");
      expect(result.shouldOffer).toBe(false);
    });

    test("does not match /tasks (different command)", () => {
      const result = classifyAsBackgroundTask("/tasks list");
      expect(result.shouldOffer).toBe(false);
    });

    test("does not match /task embedded in text", () => {
      const result = classifyAsBackgroundTask("please run /task something");
      expect(result.shouldOffer).toBe(false);
    });
  });

  describe("high confidence keywords", () => {
    test('"in the background" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "Can you do this in the background?"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.95);
      expect(result.reason).toContain("in the background");
    });

    test('"as a background task" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "Run this as a background task please"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.95);
    });

    test('"run in background" triggers offer', () => {
      const result = classifyAsBackgroundTask("Run in background: compile report");
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.95);
    });

    test('"while I\'m away" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "Process these files while I'm away"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.9);
    });

    test('"while im away" triggers offer (no apostrophe)', () => {
      const result = classifyAsBackgroundTask(
        "Handle this while im away"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.9);
    });

    test('"while i am away" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "Do this while i am away please"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.9);
    });

    test('"when you get a chance" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "When you get a chance, summarize this document"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.85);
    });

    test('"when you have a chance" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "When you have a chance, look into this"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.85);
    });

    test('"when you get time" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "When you get time, analyze the logs"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.85);
    });

    test('"when you have time" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "When you have time, review the PR"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.85);
    });

    test('"no rush" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "No rush, but can you compile the report?"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.8);
    });

    test('"no hurry" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "No hurry on this, just need it by end of day"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.8);
    });

    test('"take your time" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "Take your time with the analysis"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.8);
    });
  });

  describe("medium confidence keywords", () => {
    test('"in your spare time" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "In your spare time, organize these notes"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.75);
    });

    test('"at your convenience" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "At your convenience, review the draft"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.75);
    });

    test('"whenever you can" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "Whenever you can, check the error logs"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.7);
    });

    test('"sometime today" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "Sometime today, send me a summary"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.7);
    });

    test('"sometime later" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "Can you do this sometime later?"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.7);
    });
  });

  describe("lower confidence keywords", () => {
    test('"eventually" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "I need this done eventually"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.6);
    });

    test('"sometime" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "Can you do this sometime?"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.55);
    });

    test('"later" triggers offer', () => {
      const result = classifyAsBackgroundTask(
        "Handle this later"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.5);
    });
  });

  describe("case insensitivity", () => {
    test("matches uppercase keywords", () => {
      const result = classifyAsBackgroundTask(
        "Do this IN THE BACKGROUND"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.95);
    });

    test("matches mixed case keywords", () => {
      const result = classifyAsBackgroundTask(
        "When You Get A Chance, do this"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.85);
    });

    test("matches title case", () => {
      const result = classifyAsBackgroundTask(
        "While I'm Away, process the data"
      );
      expect(result.shouldOffer).toBe(true);
      expect(result.confidence).toBe(0.9);
    });
  });

  describe("normal messages (no trigger)", () => {
    test("simple question returns shouldOffer false", () => {
      const result = classifyAsBackgroundTask("What's the weather today?");
      expect(result.shouldOffer).toBe(false);
      expect(result.confidence).toBe(0);
    });

    test("code request returns shouldOffer false", () => {
      const result = classifyAsBackgroundTask(
        "Write a function that sorts an array"
      );
      expect(result.shouldOffer).toBe(false);
      expect(result.confidence).toBe(0);
    });

    test("greeting returns shouldOffer false", () => {
      const result = classifyAsBackgroundTask("Hello, how are you?");
      expect(result.shouldOffer).toBe(false);
      expect(result.confidence).toBe(0);
    });

    test("direct instruction returns shouldOffer false", () => {
      const result = classifyAsBackgroundTask("Summarize this document now");
      expect(result.shouldOffer).toBe(false);
      expect(result.confidence).toBe(0);
    });

    test("question about tasks returns shouldOffer false", () => {
      const result = classifyAsBackgroundTask(
        "How do background tasks work?"
      );
      expect(result.shouldOffer).toBe(false);
      expect(result.confidence).toBe(0);
    });

    test("empty message returns shouldOffer false", () => {
      const result = classifyAsBackgroundTask("");
      expect(result.shouldOffer).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.reason).toBe("Empty message");
    });

    test("whitespace-only message returns shouldOffer false", () => {
      const result = classifyAsBackgroundTask("   ");
      expect(result.shouldOffer).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.reason).toBe("Empty message");
    });
  });

  describe("confidence ordering", () => {
    test("returns highest confidence when multiple keywords match", () => {
      const result = classifyAsBackgroundTask(
        "In the background, when you get a chance, do this later"
      );
      // "in the background" (0.95) should win over "when you get a chance" (0.85) and "later" (0.5)
      expect(result.confidence).toBe(0.95);
    });

    test("/task command beats keyword matches", () => {
      const result = classifyAsBackgroundTask(
        "/task do this in the background"
      );
      expect(result.confidence).toBe(1.0);
      expect(result.reason).toBe("Explicit /task command");
    });
  });

  describe("edge cases", () => {
    test("keyword at start of message", () => {
      const result = classifyAsBackgroundTask("Later, check the logs");
      expect(result.shouldOffer).toBe(true);
    });

    test("keyword at end of message", () => {
      const result = classifyAsBackgroundTask(
        "Check the logs in the background"
      );
      expect(result.shouldOffer).toBe(true);
    });

    test("keyword surrounded by punctuation", () => {
      const result = classifyAsBackgroundTask(
        "Can you (in the background) process this?"
      );
      expect(result.shouldOffer).toBe(true);
    });

    test("very long message with keyword", () => {
      const longPrefix = "a".repeat(5000);
      const result = classifyAsBackgroundTask(
        `${longPrefix} in the background please`
      );
      expect(result.shouldOffer).toBe(true);
    });

    test("multiline message with keyword on second line", () => {
      const result = classifyAsBackgroundTask(
        "Process the data.\nDo it in the background."
      );
      expect(result.shouldOffer).toBe(true);
    });
  });
});

describe("extractTaskDescription", () => {
  test("extracts description from /task command", () => {
    expect(extractTaskDescription("/task research quantum computing")).toBe(
      "research quantum computing"
    );
  });

  test("trims whitespace from description", () => {
    expect(extractTaskDescription("/task   summarize the report  ")).toBe(
      "summarize the report"
    );
  });

  test("returns null for non-/task messages", () => {
    expect(extractTaskDescription("hello world")).toBeNull();
  });

  test("returns null for /task without description", () => {
    expect(extractTaskDescription("/task")).toBeNull();
  });

  test("returns null for /task with only whitespace after", () => {
    expect(extractTaskDescription("/task   ")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractTaskDescription("")).toBeNull();
  });

  test("handles leading whitespace on message", () => {
    expect(extractTaskDescription("  /task do something")).toBe("do something");
  });
});

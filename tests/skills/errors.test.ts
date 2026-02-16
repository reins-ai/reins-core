import { describe, expect, it } from "bun:test";
import { ReinsError } from "../../src/errors";
import { SkillError, SKILL_ERROR_CODES } from "../../src/skills/errors";

describe("SkillError", () => {
  it("extends ReinsError", () => {
    const error = new SkillError("test error");
    expect(error).toBeInstanceOf(ReinsError);
  });

  it("is an instance of Error", () => {
    const error = new SkillError("test error");
    expect(error).toBeInstanceOf(Error);
  });

  it("has correct name property", () => {
    const error = new SkillError("test error");
    expect(error.name).toBe("SkillError");
  });

  it("has correct default code property", () => {
    const error = new SkillError("test error");
    expect(error.code).toBe("SKILL_ERROR");
  });

  it("accepts a specific error code", () => {
    const error = new SkillError("parse failed", SKILL_ERROR_CODES.PARSE);
    expect(error.code).toBe("SKILL_PARSE_ERROR");
  });

  it("accepts a specific error code with cause", () => {
    const cause = new Error("underlying");
    const error = new SkillError("validation failed", SKILL_ERROR_CODES.VALIDATION, cause);
    expect(error.code).toBe("SKILL_VALIDATION_ERROR");
    expect(error.cause).toBe(cause);
  });

  it("stores the error message", () => {
    const message = "Skill parsing failed";
    const error = new SkillError(message);
    expect(error.message).toBe(message);
  });

  it("stores the cause when provided", () => {
    const cause = new Error("underlying error");
    const error = new SkillError("wrapper error", cause);
    expect(error.cause).toBe(cause);
  });

  it("has undefined cause when not provided", () => {
    const error = new SkillError("test error");
    expect(error.cause).toBeUndefined();
  });

  it("can be caught as SkillError", () => {
    try {
      throw new SkillError("test error");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillError);
    }
  });

  it("can be caught as ReinsError", () => {
    try {
      throw new SkillError("test error");
    } catch (error) {
      expect(error).toBeInstanceOf(ReinsError);
    }
  });

  it("can be caught as Error", () => {
    try {
      throw new SkillError("test error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("instanceof SkillError works correctly", () => {
    const error = new SkillError("test error");
    expect(error instanceof SkillError).toBe(true);
    expect(error instanceof ReinsError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });

  it("instanceof check distinguishes from other ReinsError subclasses", () => {
    const skillError = new SkillError("skill error");
    const reinsError = new ReinsError("generic error", "GENERIC");

    expect(skillError instanceof SkillError).toBe(true);
    expect(reinsError instanceof SkillError).toBe(false);
  });
});

describe("SKILL_ERROR_CODES", () => {
  it("defines PARSE error code", () => {
    expect(SKILL_ERROR_CODES.PARSE).toBe("SKILL_PARSE_ERROR");
  });

  it("defines VALIDATION error code", () => {
    expect(SKILL_ERROR_CODES.VALIDATION).toBe("SKILL_VALIDATION_ERROR");
  });

  it("defines EXECUTION error code", () => {
    expect(SKILL_ERROR_CODES.EXECUTION).toBe("SKILL_EXECUTION_ERROR");
  });

  it("defines PERMISSION error code", () => {
    expect(SKILL_ERROR_CODES.PERMISSION).toBe("SKILL_PERMISSION_ERROR");
  });

  it("defines NOT_FOUND error code", () => {
    expect(SKILL_ERROR_CODES.NOT_FOUND).toBe("SKILL_NOT_FOUND_ERROR");
  });

  it("has all required error codes", () => {
    const codes = Object.keys(SKILL_ERROR_CODES);
    expect(codes).toContain("PARSE");
    expect(codes).toContain("VALIDATION");
    expect(codes).toContain("EXECUTION");
    expect(codes).toContain("PERMISSION");
    expect(codes).toContain("NOT_FOUND");
  });

  it("has exactly 5 error codes", () => {
    const codes = Object.keys(SKILL_ERROR_CODES);
    expect(codes.length).toBe(5);
  });

  it("all error codes are strings", () => {
    const codes = Object.values(SKILL_ERROR_CODES);
    codes.forEach((code) => {
      expect(typeof code).toBe("string");
    });
  });

  it("all error codes have SKILL_ prefix", () => {
    const codes = Object.values(SKILL_ERROR_CODES);
    codes.forEach((code) => {
      expect(code.startsWith("SKILL_")).toBe(true);
    });
  });

  it("all error codes end with _ERROR suffix", () => {
    const codes = Object.values(SKILL_ERROR_CODES);
    codes.forEach((code) => {
      expect(code.endsWith("_ERROR")).toBe(true);
    });
  });
});

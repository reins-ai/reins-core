import { describe, expect, it } from "bun:test";
import { ReinsError } from "../../src/errors";
import { IntegrationError, INTEGRATION_ERROR_CODES } from "../../src/integrations/errors";

describe("IntegrationError", () => {
  it("extends ReinsError", () => {
    const error = new IntegrationError("test error");
    expect(error).toBeInstanceOf(ReinsError);
  });

  it("is an instance of Error", () => {
    const error = new IntegrationError("test error");
    expect(error).toBeInstanceOf(Error);
  });

  it("has correct name property", () => {
    const error = new IntegrationError("test error");
    expect(error.name).toBe("IntegrationError");
  });

  it("has correct code property", () => {
    const error = new IntegrationError("test error");
    expect(error.code).toBe("INTEGRATION_ERROR");
  });

  it("stores the error message", () => {
    const message = "Integration connection failed";
    const error = new IntegrationError(message);
    expect(error.message).toBe(message);
  });

  it("stores the cause when provided", () => {
    const cause = new Error("underlying error");
    const error = new IntegrationError("wrapper error", cause);
    expect(error.cause).toBe(cause);
  });

  it("has undefined cause when not provided", () => {
    const error = new IntegrationError("test error");
    expect(error.cause).toBeUndefined();
  });

  it("can be caught as IntegrationError", () => {
    try {
      throw new IntegrationError("test error");
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationError);
    }
  });

  it("can be caught as ReinsError", () => {
    try {
      throw new IntegrationError("test error");
    } catch (error) {
      expect(error).toBeInstanceOf(ReinsError);
    }
  });

  it("can be caught as Error", () => {
    try {
      throw new IntegrationError("test error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("instanceof IntegrationError works correctly", () => {
    const error = new IntegrationError("test error");
    expect(error instanceof IntegrationError).toBe(true);
    expect(error instanceof ReinsError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });

  it("instanceof check distinguishes from other ReinsError subclasses", () => {
    const integrationError = new IntegrationError("integration error");
    const reinsError = new ReinsError("generic error", "GENERIC");
    
    expect(integrationError instanceof IntegrationError).toBe(true);
    expect(reinsError instanceof IntegrationError).toBe(false);
  });
});

describe("INTEGRATION_ERROR_CODES", () => {
  it("defines CONNECTION error code", () => {
    expect(INTEGRATION_ERROR_CODES.CONNECTION).toBe("INTEGRATION_CONNECTION_ERROR");
  });

  it("defines AUTH error code", () => {
    expect(INTEGRATION_ERROR_CODES.AUTH).toBe("INTEGRATION_AUTH_ERROR");
  });

  it("defines OPERATION error code", () => {
    expect(INTEGRATION_ERROR_CODES.OPERATION).toBe("INTEGRATION_OPERATION_ERROR");
  });

  it("defines VALIDATION error code", () => {
    expect(INTEGRATION_ERROR_CODES.VALIDATION).toBe("INTEGRATION_VALIDATION_ERROR");
  });

  it("defines STATE_TRANSITION error code", () => {
    expect(INTEGRATION_ERROR_CODES.STATE_TRANSITION).toBe("INTEGRATION_STATE_TRANSITION_ERROR");
  });

  it("has all required error codes", () => {
    const codes = Object.keys(INTEGRATION_ERROR_CODES);
    expect(codes).toContain("CONNECTION");
    expect(codes).toContain("AUTH");
    expect(codes).toContain("OPERATION");
    expect(codes).toContain("VALIDATION");
    expect(codes).toContain("STATE_TRANSITION");
  });

  it("has exactly 5 error codes", () => {
    const codes = Object.keys(INTEGRATION_ERROR_CODES);
    expect(codes.length).toBe(5);
  });

  it("all error codes are strings", () => {
    const codes = Object.values(INTEGRATION_ERROR_CODES);
    codes.forEach(code => {
      expect(typeof code).toBe("string");
    });
  });

  it("all error codes have INTEGRATION_ prefix", () => {
    const codes = Object.values(INTEGRATION_ERROR_CODES);
    codes.forEach(code => {
      expect(code.startsWith("INTEGRATION_")).toBe(true);
    });
  });

  it("all error codes end with _ERROR suffix", () => {
    const codes = Object.values(INTEGRATION_ERROR_CODES);
    codes.forEach(code => {
      expect(code.endsWith("_ERROR")).toBe(true);
    });
  });
});

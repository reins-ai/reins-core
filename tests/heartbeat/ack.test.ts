import { describe, expect, test } from "bun:test";

import {
  parseHeartbeatResponse,
  shouldSuppressOutput,
} from "../../src/heartbeat/ack";

describe("parseHeartbeatResponse", () => {
  test("detects and strips HEARTBEAT_OK token case-insensitively", () => {
    const result = parseHeartbeatResponse("Alert: review goals. heartbeat_ok");

    expect(result.hadAckToken).toBe(true);
    expect(result.stripped).toBe("Alert: review goals.");
    expect(result.isAckOnly).toBe(false);
  });

  test("marks pure ack responses as ack-only", () => {
    const result = parseHeartbeatResponse("  HEARTBEAT_OK  ");

    expect(result.hadAckToken).toBe(true);
    expect(result.stripped).toBe("");
    expect(result.isAckOnly).toBe(true);
  });

  test("does not mark non-token output as ack-only", () => {
    const result = parseHeartbeatResponse("No alerts due");

    expect(result.hadAckToken).toBe(false);
    expect(result.stripped).toBe("No alerts due");
    expect(result.isAckOnly).toBe(false);
  });
});

describe("shouldSuppressOutput", () => {
  test("suppresses only ack-only responses", () => {
    expect(
      shouldSuppressOutput({
        stripped: "",
        isAckOnly: true,
        hadAckToken: true,
      }),
    ).toBe(true);

    expect(
      shouldSuppressOutput({
        stripped: "Need to check reminders",
        isAckOnly: false,
        hadAckToken: true,
      }),
    ).toBe(false);
  });
});

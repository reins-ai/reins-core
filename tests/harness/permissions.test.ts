import { describe, expect, it } from "bun:test";

import {
  DoomLoopGuard,
  FULL_PROFILE,
  HarnessPermissionChecker,
  MINIMAL_PROFILE,
  STANDARD_PROFILE,
  createHarnessEventBus,
  type PermissionProfile,
} from "../../src/harness";
import type { ToolCall } from "../../src/types";

function createToolCall(name: string): ToolCall {
  return {
    id: `call-${name}`,
    name,
    arguments: {},
  };
}

describe("PermissionChecker", () => {
  it("applies profile defaults for unknown tools", () => {
    const unknownTool = createToolCall("custom.unknown");

    const minimalChecker = new HarnessPermissionChecker(MINIMAL_PROFILE);
    const standardChecker = new HarnessPermissionChecker(STANDARD_PROFILE);
    const fullChecker = new HarnessPermissionChecker(FULL_PROFILE);

    expect(minimalChecker.check(unknownTool).action).toBe("deny");
    expect(standardChecker.check(unknownTool).action).toBe("ask");
    expect(fullChecker.check(unknownTool).action).toBe("allow");
  });

  it("applies explicit tool rule overrides", () => {
    const minimalChecker = new HarnessPermissionChecker(MINIMAL_PROFILE);
    const standardChecker = new HarnessPermissionChecker(STANDARD_PROFILE);

    expect(minimalChecker.check(createToolCall("voice")).action).toBe("allow");
    expect(standardChecker.check(createToolCall("notes")).action).toBe("allow");
    expect(standardChecker.check(createToolCall("schedule")).action).toBe("deny");
  });

  it("resolves ask-mode permission flow through permission_request events", async () => {
    const eventBus = createHarnessEventBus();
    const askProfile: PermissionProfile = {
      name: "standard",
      defaultAction: "ask",
      rules: {},
    };

    const checker = new HarnessPermissionChecker(askProfile, eventBus);
    const toolCall = createToolCall("sensitive.tool");
    const observedRequests: string[] = [];

    eventBus.on("permission_request", (event) => {
      observedRequests.push(event.payload.requestId);
      expect(event.payload.toolCall.name).toBe("sensitive.tool");
      expect(event.payload.profile).toBe("standard");
      checker.resolvePermission(event.payload.requestId, true);
    });

    const granted = await checker.requestPermission(toolCall);

    expect(granted).toBe(true);
    expect(observedRequests).toHaveLength(1);
  });

  it("returns denied when ask-mode has no event bus", async () => {
    const askProfile: PermissionProfile = {
      name: "standard",
      defaultAction: "ask",
      rules: {},
    };
    const checker = new HarnessPermissionChecker(askProfile);

    const granted = await checker.requestPermission(createToolCall("sensitive.tool"));
    expect(granted).toBe(false);
  });
});

describe("DoomLoopGuard", () => {
  it("escalates after consecutive failure threshold", () => {
    const guard = new DoomLoopGuard({ maxConsecutiveFailures: 3, maxTotalFailures: 10 });

    guard.recordFailure("notes");
    expect(guard.shouldEscalate()).toBe(false);

    guard.recordFailure("notes");
    expect(guard.shouldEscalate()).toBe(false);

    guard.recordFailure("notes");
    expect(guard.shouldEscalate()).toBe(true);
    expect(guard.getFailureCount()).toBe(3);
  });

  it("escalates after total failure threshold and resets per turn", () => {
    const guard = new DoomLoopGuard({ maxConsecutiveFailures: 10, maxTotalFailures: 2 });

    guard.recordFailure("notes");
    guard.recordSuccess("notes");
    guard.recordFailure("calendar");

    expect(guard.shouldEscalate()).toBe(true);
    expect(guard.getFailureCount()).toBe(2);

    guard.resetTurn();

    expect(guard.shouldEscalate()).toBe(false);
    expect(guard.getFailureCount()).toBe(0);
  });
});

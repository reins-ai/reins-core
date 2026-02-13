import { describe, expect, it } from "bun:test";

import {
  DoomLoopGuard,
  FULL_PROFILE,
  HarnessPermissionChecker,
  MINIMAL_PROFILE,
  PERMISSION_PROFILES,
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

describe("PermissionChecker regression: profile combinations", () => {
  it("minimal profile allows only explicitly listed tools", () => {
    const checker = new HarnessPermissionChecker(MINIMAL_PROFILE);

    expect(checker.check(createToolCall("voice")).action).toBe("allow");
    expect(checker.check(createToolCall("notes")).action).toBe("deny");
    expect(checker.check(createToolCall("calendar")).action).toBe("deny");
    expect(checker.check(createToolCall("reminders")).action).toBe("deny");
    expect(checker.check(createToolCall("schedule")).action).toBe("deny");
  });

  it("standard profile allows common tools and denies schedule", () => {
    const checker = new HarnessPermissionChecker(STANDARD_PROFILE);

    expect(checker.check(createToolCall("notes")).action).toBe("allow");
    expect(checker.check(createToolCall("reminders")).action).toBe("allow");
    expect(checker.check(createToolCall("calendar")).action).toBe("allow");
    expect(checker.check(createToolCall("voice")).action).toBe("allow");
    expect(checker.check(createToolCall("schedule")).action).toBe("deny");
  });

  it("full profile allows all tools including unknown ones", () => {
    const checker = new HarnessPermissionChecker(FULL_PROFILE);

    expect(checker.check(createToolCall("notes")).action).toBe("allow");
    expect(checker.check(createToolCall("dangerous.tool")).action).toBe("allow");
    expect(checker.check(createToolCall("anything")).action).toBe("allow");
  });

  it("PERMISSION_PROFILES map contains all three profiles", () => {
    expect(PERMISSION_PROFILES.minimal).toBe(MINIMAL_PROFILE);
    expect(PERMISSION_PROFILES.standard).toBe(STANDARD_PROFILE);
    expect(PERMISSION_PROFILES.full).toBe(FULL_PROFILE);
  });
});

describe("PermissionChecker regression: deny-overrides", () => {
  it("explicit deny rule overrides default allow in full-like profile", () => {
    const profile: PermissionProfile = {
      name: "full",
      defaultAction: "allow",
      rules: {
        "dangerous.tool": "deny",
      },
    };
    const checker = new HarnessPermissionChecker(profile);

    expect(checker.check(createToolCall("safe.tool")).action).toBe("allow");
    expect(checker.check(createToolCall("dangerous.tool")).action).toBe("deny");
  });

  it("explicit allow rule overrides default deny in minimal-like profile", () => {
    const profile: PermissionProfile = {
      name: "minimal",
      defaultAction: "deny",
      rules: {
        "special.tool": "allow",
      },
    };
    const checker = new HarnessPermissionChecker(profile);

    expect(checker.check(createToolCall("special.tool")).action).toBe("allow");
    expect(checker.check(createToolCall("other.tool")).action).toBe("deny");
  });

  it("explicit ask rule overrides default allow", () => {
    const profile: PermissionProfile = {
      name: "full",
      defaultAction: "allow",
      rules: {
        "sensitive.tool": "ask",
      },
    };
    const checker = new HarnessPermissionChecker(profile);

    expect(checker.check(createToolCall("sensitive.tool")).action).toBe("ask");
    expect(checker.check(createToolCall("normal.tool")).action).toBe("allow");
  });
});

describe("PermissionChecker regression: unknown tool behavior", () => {
  it("unknown tools fall through to profile default action", () => {
    const profiles: Array<{ profile: PermissionProfile; expected: string }> = [
      { profile: MINIMAL_PROFILE, expected: "deny" },
      { profile: STANDARD_PROFILE, expected: "ask" },
      { profile: FULL_PROFILE, expected: "allow" },
    ];

    for (const { profile, expected } of profiles) {
      const checker = new HarnessPermissionChecker(profile);
      const result = checker.check(createToolCall("completely.unknown.tool"));
      expect(result.action).toBe(expected);
      expect(result.toolName).toBe("completely.unknown.tool");
      expect(result.profile).toBe(profile.name);
    }
  });

  it("check result includes correct profile name and tool name", () => {
    const checker = new HarnessPermissionChecker(STANDARD_PROFILE);
    const result = checker.check(createToolCall("calendar"));

    expect(result.toolName).toBe("calendar");
    expect(result.profile).toBe("standard");
    expect(result.action).toBe("allow");
  });
});

describe("PermissionChecker regression: ask-mode edge cases", () => {
  it("ask-mode denied when permission is resolved with false", async () => {
    const eventBus = createHarnessEventBus();
    const askProfile: PermissionProfile = {
      name: "standard",
      defaultAction: "ask",
      rules: {},
    };

    const checker = new HarnessPermissionChecker(askProfile, eventBus);

    eventBus.on("permission_request", (event) => {
      checker.resolvePermission(event.payload.requestId, false);
    });

    const granted = await checker.requestPermission(createToolCall("restricted.tool"));
    expect(granted).toBe(false);
  });

  it("resolving a non-existent permission request is a no-op", () => {
    const checker = new HarnessPermissionChecker(STANDARD_PROFILE);

    // Should not throw
    checker.resolvePermission("nonexistent-request-id", true);
  });

  it("requestPermission returns true immediately for allowed tools", async () => {
    const eventBus = createHarnessEventBus();
    const checker = new HarnessPermissionChecker(FULL_PROFILE, eventBus);

    const permissionRequests: string[] = [];
    eventBus.on("permission_request", (event) => {
      permissionRequests.push(event.payload.requestId);
    });

    const granted = await checker.requestPermission(createToolCall("any.tool"));

    expect(granted).toBe(true);
    expect(permissionRequests).toHaveLength(0);
  });

  it("requestPermission returns false immediately for denied tools", async () => {
    const eventBus = createHarnessEventBus();
    const checker = new HarnessPermissionChecker(MINIMAL_PROFILE, eventBus);

    const permissionRequests: string[] = [];
    eventBus.on("permission_request", (event) => {
      permissionRequests.push(event.payload.requestId);
    });

    const granted = await checker.requestPermission(createToolCall("notes"));

    expect(granted).toBe(false);
    expect(permissionRequests).toHaveLength(0);
  });
});

describe("DoomLoopGuard regression: escalation patterns", () => {
  it("does not escalate when failures are interspersed with successes", () => {
    const guard = new DoomLoopGuard({ maxConsecutiveFailures: 3, maxTotalFailures: 10 });

    guard.recordFailure("tool-a");
    guard.recordFailure("tool-a");
    guard.recordSuccess("tool-a");
    guard.recordFailure("tool-b");
    guard.recordFailure("tool-b");
    guard.recordSuccess("tool-b");

    expect(guard.shouldEscalate()).toBe(false);
  });

  it("escalates on total failures even when consecutive count stays below threshold", () => {
    const guard = new DoomLoopGuard({ maxConsecutiveFailures: 5, maxTotalFailures: 4 });

    guard.recordFailure("tool-a");
    guard.recordSuccess("tool-a");
    guard.recordFailure("tool-b");
    guard.recordSuccess("tool-b");
    guard.recordFailure("tool-c");
    guard.recordSuccess("tool-c");
    guard.recordFailure("tool-d");

    expect(guard.shouldEscalate()).toBe(true);
    expect(guard.getFailureCount()).toBe(4);
  });

  it("resets both counters on resetTurn", () => {
    const guard = new DoomLoopGuard({ maxConsecutiveFailures: 2, maxTotalFailures: 3 });

    guard.recordFailure("tool-a");
    guard.recordFailure("tool-a");
    expect(guard.shouldEscalate()).toBe(true);

    guard.resetTurn();

    expect(guard.shouldEscalate()).toBe(false);
    expect(guard.getFailureCount()).toBe(0);
  });

  it("tracks failures across different tool names", () => {
    const guard = new DoomLoopGuard({ maxConsecutiveFailures: 3, maxTotalFailures: 10 });

    guard.recordFailure("tool-a");
    guard.recordFailure("tool-b");
    guard.recordFailure("tool-c");

    expect(guard.shouldEscalate()).toBe(true);
  });

  it("success from any tool resets consecutive counter", () => {
    const guard = new DoomLoopGuard({ maxConsecutiveFailures: 3, maxTotalFailures: 10 });

    guard.recordFailure("tool-a");
    guard.recordFailure("tool-b");
    guard.recordSuccess("tool-c");

    expect(guard.shouldEscalate()).toBe(false);
  });

  it("uses default thresholds when no options provided", () => {
    const guard = new DoomLoopGuard();

    // Default maxConsecutiveFailures is 3
    guard.recordFailure("a");
    guard.recordFailure("a");
    expect(guard.shouldEscalate()).toBe(false);

    guard.recordFailure("a");
    expect(guard.shouldEscalate()).toBe(true);
  });
});

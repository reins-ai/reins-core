import { describe, expect, it } from "bun:test";

import { parseBoundariesPolicy } from "../../src/environment/boundaries-policy";
import { parseToolsPolicy } from "../../src/environment/tools-policy";
import { ToolExecutionPolicy } from "../../src/tools/execution/policy";

describe("ToolExecutionPolicy", () => {
  it("enforces enabled and disabled tool lists", () => {
    const toolsPolicy = parseToolsPolicy(
      [
        "## Global Aggressiveness",
        "**Default Mode:** moderate",
        "",
        "### Reminders",
        "**Status:** enabled",
        "**Aggressiveness:** proactive",
        "",
        "### Calendar",
        "**Status:** disabled",
      ].join("\n"),
    );

    const policy = new ToolExecutionPolicy(toolsPolicy);

    expect(policy.isToolAllowed("reminders")).toBe(true);
    expect(policy.isToolAllowed("calendar")).toBe(false);
    expect(policy.isToolAllowed("notes")).toBe(false);
  });

  it("returns per-tool aggressiveness with default fallback", () => {
    const toolsPolicy = parseToolsPolicy(
      [
        "## Global Aggressiveness",
        "**Default Mode:** conservative",
        "",
        "### Reminders",
        "**Status:** enabled",
        "**Aggressiveness:** proactive",
      ].join("\n"),
    );

    const policy = new ToolExecutionPolicy(toolsPolicy);

    expect(policy.getAggressiveness("reminders")).toBe("high");
    expect(policy.getAggressiveness("notes")).toBe("low");
  });

  it("applies reminder follow-up policy from aggressiveness", () => {
    const lowPolicy = new ToolExecutionPolicy(
      parseToolsPolicy(
        [
          "## Global Aggressiveness",
          "**Default Mode:** moderate",
          "",
          "### Reminders",
          "**Status:** enabled",
          "**Aggressiveness:** low",
        ].join("\n"),
      ),
    );
    const mediumPolicy = new ToolExecutionPolicy(
      parseToolsPolicy("## Global Aggressiveness\n**Default Mode:** moderate"),
    );
    const highPolicy = new ToolExecutionPolicy(
      parseToolsPolicy(
        [
          "## Global Aggressiveness",
          "**Default Mode:** moderate",
          "",
          "### Reminders",
          "**Status:** enabled",
          "**Aggressiveness:** high",
        ].join("\n"),
      ),
    );

    expect(lowPolicy.getReminderFollowUpMode()).toBe("none");
    expect(mediumPolicy.getReminderFollowUpMode()).toBe("gentle");
    expect(highPolicy.getReminderFollowUpMode()).toBe("persistent");
  });

  it("declines explicit will-not-do requests", () => {
    const toolsPolicy = parseToolsPolicy("## Global Aggressiveness\n**Default Mode:** moderate");
    const boundariesPolicy = parseBoundariesPolicy(
      [
        "## Will Not Do",
        "- make purchases or financial transactions",
        "- provide medical advice",
      ].join("\n"),
    );

    const policy = new ToolExecutionPolicy(toolsPolicy, boundariesPolicy);

    expect(policy.shouldDeclineRequest("Please make purchases for me on Amazon")).toBe(true);
    expect(policy.shouldDeclineRequest("Can you provide medical advice for this symptom?")).toBe(true);
    expect(policy.shouldDeclineRequest("Help me draft a shopping list")).toBe(false);
  });
});

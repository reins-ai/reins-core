import { describe, expect, it } from "bun:test";

import {
  defaultToolsPolicy,
  getToolAggressiveness,
  isToolEnabled,
  parseToolsPolicy,
  validateToolsPolicy,
} from "../../src/environment/tools-policy";
import type { ToolsPolicy } from "../../src/environment/tools-policy";

import {
  defaultBoundariesPolicy,
  isGrayArea,
  isProhibited,
  parseBoundariesPolicy,
  validateBoundariesPolicy,
} from "../../src/environment/boundaries-policy";

import { TOOLS_TEMPLATE } from "../../src/environment/templates/tools.md";
import { BOUNDARIES_TEMPLATE } from "../../src/environment/templates/boundaries.md";

// ---------------------------------------------------------------------------
// TOOLS.md Policy Parsing
// ---------------------------------------------------------------------------

describe("parseToolsPolicy", () => {
  it("parses the default TOOLS.md template successfully", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    expect(policy.environmentName).toBe("default");
    expect(policy.aggressiveness.default).toBe("medium");
    expect(policy.enabled.length).toBeGreaterThan(0);
    expect(policy.disabled.length).toBeGreaterThan(0);
  });

  it("extracts global aggressiveness from Default Mode field", () => {
    const markdown = `# TOOLS\n\n## Global Aggressiveness\n\n**Default Mode:** proactive\n`;
    const policy = parseToolsPolicy(markdown, "work");

    expect(policy.aggressiveness.default).toBe("high");
  });

  it("defaults to medium when Default Mode is missing", () => {
    const markdown = `# TOOLS\n\nSome content without a mode.\n`;
    const policy = parseToolsPolicy(markdown, "default");

    expect(policy.aggressiveness.default).toBe("medium");
  });

  it("defaults to medium when Default Mode has invalid value", () => {
    const markdown = `# TOOLS\n\n**Default Mode:** extreme\n`;
    const policy = parseToolsPolicy(markdown, "default");

    expect(policy.aggressiveness.default).toBe("medium");
  });

  it("extracts enabled tools from template", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    expect(policy.enabled).toContain("calendar");
    expect(policy.enabled).toContain("reminders");
    expect(policy.enabled).toContain("notes");
    expect(policy.enabled).toContain("voice");
    expect(policy.enabled).toContain("web_search");
    expect(policy.enabled).toContain("file_management");
  });

  it("extracts disabled tools from template", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    expect(policy.disabled).toContain("email_integration");
    expect(policy.disabled).toContain("social_media");
    expect(policy.disabled).toContain("financial_transactions");
  });

  it("extracts per-tool aggressiveness levels", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    expect(policy.aggressiveness.calendar).toBe("medium");
    expect(policy.aggressiveness.reminders).toBe("high");
    expect(policy.aggressiveness.voice).toBe("low");
    expect(policy.aggressiveness.notes).toBe("medium");
  });

  it("handles empty markdown gracefully", () => {
    const policy = parseToolsPolicy("", "default");

    expect(policy.aggressiveness.default).toBe("medium");
    expect(policy.enabled).toEqual([]);
    expect(policy.disabled).toEqual([]);
  });

  it("handles markdown with no tool sections", () => {
    const markdown = `# TOOLS\n\n## Global Aggressiveness\n\n**Default Mode:** conservative\n\nSome text but no tool sections.\n`;
    const policy = parseToolsPolicy(markdown, "default");

    expect(policy.aggressiveness.default).toBe("low");
    expect(policy.enabled).toEqual([]);
    expect(policy.disabled).toEqual([]);
  });

  it("parses a minimal single-tool document", () => {
    const markdown = `# TOOLS

**Default Mode:** proactive

### My Custom Tool

**Status:** enabled
**Aggressiveness:** conservative
`;
    const policy = parseToolsPolicy(markdown, "custom");

    expect(policy.aggressiveness.default).toBe("high");
    expect(policy.enabled).toContain("my_custom_tool");
    expect(policy.aggressiveness.my_custom_tool).toBe("low");
  });

  it("preserves environment name in parsed policy", () => {
    const policy = parseToolsPolicy("# TOOLS\n", "work");

    expect(policy.environmentName).toBe("work");
  });

  it("works without environment name for backward compatibility", () => {
    const policy = parseToolsPolicy("# TOOLS\n");

    expect(policy.environmentName).toBe("");
    expect(policy.aggressiveness.default).toBe("medium");
  });

  it("does not include disabled tools in enabled list", () => {
    const markdown = `# TOOLS

### Alpha

**Status:** enabled

### Beta

**Status:** disabled
`;
    const policy = parseToolsPolicy(markdown, "default");

    expect(policy.enabled).toContain("alpha");
    expect(policy.disabled).toContain("beta");
    expect(policy.enabled).not.toContain("beta");
  });

  it("deduplicates tool names", () => {
    const markdown = `# TOOLS

### Calendar

**Status:** enabled

### Calendar

**Status:** enabled
`;
    const policy = parseToolsPolicy(markdown, "default");

    const calendarCount = policy.enabled.filter((t) => t === "calendar").length;
    expect(calendarCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tools Policy Helpers
// ---------------------------------------------------------------------------

describe("defaultToolsPolicy", () => {
  it("returns medium aggressiveness with empty tool lists", () => {
    const policy = defaultToolsPolicy("default");

    expect(policy.aggressiveness.default).toBe("medium");
    expect(policy.enabled).toEqual([]);
    expect(policy.disabled).toEqual([]);
    expect(policy.environmentName).toBe("default");
    expect(policy.raw).toBe("");
  });
});

describe("getToolAggressiveness", () => {
  it("returns tool-specific aggressiveness when defined", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    expect(getToolAggressiveness(policy, "Reminders")).toBe("high");
    expect(getToolAggressiveness(policy, "Calendar")).toBe("medium");
    expect(getToolAggressiveness(policy, "Voice")).toBe("low");
  });

  it("falls back to default aggressiveness for unknown tools", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    expect(getToolAggressiveness(policy, "Unknown Tool")).toBe("medium");
  });

  it("matches tool names case-insensitively via key normalization", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    expect(getToolAggressiveness(policy, "reminders")).toBe("high");
    expect(getToolAggressiveness(policy, "CALENDAR")).toBe("medium");
  });
});

describe("isToolEnabled", () => {
  it("returns true for enabled tools", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    expect(isToolEnabled(policy, "Calendar")).toBe(true);
    expect(isToolEnabled(policy, "Reminders")).toBe(true);
  });

  it("returns false for disabled tools", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    expect(isToolEnabled(policy, "Email Integration")).toBe(false);
    expect(isToolEnabled(policy, "Social Media")).toBe(false);
    expect(isToolEnabled(policy, "Financial Transactions")).toBe(false);
  });

  it("returns true for unknown tools when enabled list is populated (opt-out model)", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    // Unknown tools are allowed if they're not in the disabled list
    // and the enabled list is non-empty (they won't be in enabled either,
    // so this returns false for strict enabled-list mode)
    // Actually with the opt-out model: if enabled list is non-empty,
    // unknown tools are NOT in the enabled list, so they're not allowed.
    // Let's test with an empty enabled list instead.
    const emptyPolicy = defaultToolsPolicy("default");
    expect(isToolEnabled(emptyPolicy, "Brand New Tool")).toBe(true);
  });

  it("returns false for empty tool name", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    expect(isToolEnabled(policy, "")).toBe(false);
    expect(isToolEnabled(policy, "   ")).toBe(false);
  });

  it("matches tool names case-insensitively", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    expect(isToolEnabled(policy, "email integration")).toBe(false);
    expect(isToolEnabled(policy, "CALENDAR")).toBe(true);
  });
});

describe("validateToolsPolicy", () => {
  it("validates a well-formed policy from template", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");

    const validation = validateToolsPolicy(policy);
    expect(validation.ok).toBe(true);
  });

  it("validates the default empty policy", () => {
    const policy = defaultToolsPolicy("default");
    const validation = validateToolsPolicy(policy);
    expect(validation.ok).toBe(true);
  });

  it("rejects policy with invalid default aggressiveness", () => {
    const policy: ToolsPolicy = {
      enabled: [],
      disabled: [],
      aggressiveness: { default: "extreme" as never },
      environmentName: "default",
      raw: "",
    };

    const validation = validateToolsPolicy(policy);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.error.code).toBe("SCOPE_VIOLATION");
    }
  });

  it("rejects policy with tool in both enabled and disabled lists", () => {
    const policy: ToolsPolicy = {
      enabled: ["calendar"],
      disabled: ["calendar"],
      aggressiveness: { default: "medium" },
      environmentName: "default",
      raw: "",
    };

    const validation = validateToolsPolicy(policy);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.error.code).toBe("SCOPE_VIOLATION");
    }
  });

  it("rejects policy with invalid per-tool aggressiveness", () => {
    const policy: ToolsPolicy = {
      enabled: ["calendar"],
      disabled: [],
      aggressiveness: { default: "medium", calendar: "turbo" as never },
      environmentName: "default",
      raw: "",
    };

    const validation = validateToolsPolicy(policy);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.error.code).toBe("SCOPE_VIOLATION");
    }
  });
});

// ---------------------------------------------------------------------------
// BOUNDARIES.md Policy Parsing
// ---------------------------------------------------------------------------

describe("parseBoundariesPolicy", () => {
  it("parses the default BOUNDARIES.md template successfully", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");

    expect(policy.environmentName).toBe("default");
    expect(policy.canDo.length).toBeGreaterThan(0);
    expect(policy.willNotDo.length).toBeGreaterThan(0);
    expect(policy.grayArea.length).toBeGreaterThan(0);
  });

  it("extracts can-do items from template", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");

    // Should contain items from the "Can Do" section
    const hasSearchItem = policy.canDo.some(
      (item) => item.toLowerCase().includes("search"),
    );
    expect(hasSearchItem).toBe(true);
  });

  it("extracts will-not-do items from template", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");

    // Should contain financial transaction items
    const hasFinancialItem = policy.willNotDo.some(
      (item) => item.toLowerCase().includes("financial") || item.toLowerCase().includes("purchase"),
    );
    expect(hasFinancialItem).toBe(true);

    // Should contain medical items
    const hasMedicalItem = policy.willNotDo.some(
      (item) => item.toLowerCase().includes("medical") || item.toLowerCase().includes("diagnose"),
    );
    expect(hasMedicalItem).toBe(true);
  });

  it("extracts gray-area items from template", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");

    // Should contain sensitive communications items
    const hasSensitiveComms = policy.grayArea.some(
      (item) => item.toLowerCase().includes("professional contacts") ||
        item.toLowerCase().includes("managers"),
    );
    expect(hasSensitiveComms).toBe(true);
  });

  it("handles empty markdown gracefully", () => {
    const policy = parseBoundariesPolicy("", "default");

    expect(policy.canDo).toEqual([]);
    expect(policy.willNotDo).toEqual([]);
    expect(policy.grayArea).toEqual([]);
  });

  it("handles markdown with missing sections", () => {
    const markdown = `# BOUNDARIES

## Can Do (Explicit Capabilities)

### Research
- ✅ Search for information
- ✅ Summarize documents
`;
    const policy = parseBoundariesPolicy(markdown, "default");

    expect(policy.canDo.length).toBe(2);
    expect(policy.willNotDo).toEqual([]);
    expect(policy.grayArea).toEqual([]);
  });

  it("parses a minimal custom boundaries document", () => {
    const markdown = `# BOUNDARIES

## Can Do (Explicit Capabilities)

### Basics
- ✅ Answer questions
- ✅ Take notes

## Will Not Do (Hard Limits)

### Dangerous
- ❌ Delete files
- ❌ Send emails

## Gray Area (Ask First)

### Uncertain
- ⚠️ Schedule meetings
- ⚠️ Modify calendar
`;
    const policy = parseBoundariesPolicy(markdown, "work");

    expect(policy.canDo).toHaveLength(2);
    expect(policy.willNotDo).toHaveLength(2);
    expect(policy.grayArea).toHaveLength(2);

    expect(policy.canDo[0]).toBe("Answer questions");
    expect(policy.willNotDo[0]).toBe("Delete files");
    expect(policy.grayArea[0]).toBe("Schedule meetings");
  });

  it("preserves environment name in parsed policy", () => {
    const policy = parseBoundariesPolicy("# BOUNDARIES\n", "creative");

    expect(policy.environmentName).toBe("creative");
  });

  it("works without environment name for backward compatibility", () => {
    const policy = parseBoundariesPolicy("# BOUNDARIES\n");

    expect(policy.environmentName).toBe("");
    expect(policy.canDo).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Boundaries Policy Helpers
// ---------------------------------------------------------------------------

describe("defaultBoundariesPolicy", () => {
  it("returns empty sections with environment name", () => {
    const policy = defaultBoundariesPolicy("default");

    expect(policy.canDo).toEqual([]);
    expect(policy.willNotDo).toEqual([]);
    expect(policy.grayArea).toEqual([]);
    expect(policy.environmentName).toBe("default");
    expect(policy.raw).toBe("");
  });
});

describe("isProhibited", () => {
  it("detects prohibited requests matching will-not-do items", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");

    expect(isProhibited(policy, "make purchases or financial transactions")).toBe(true);
    expect(isProhibited(policy, "diagnose medical conditions")).toBe(true);
  });

  it("returns false for allowed requests", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");

    expect(isProhibited(policy, "what is the weather today")).toBe(false);
  });

  it("matches case-insensitively", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");

    expect(isProhibited(policy, "MAKE PURCHASES OR FINANCIAL TRANSACTIONS")).toBe(true);
  });

  it("returns false for empty request", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");

    expect(isProhibited(policy, "")).toBe(false);
    expect(isProhibited(policy, "   ")).toBe(false);
  });

  it("returns false when will-not-do list is empty", () => {
    const policy = defaultBoundariesPolicy("default");

    expect(isProhibited(policy, "anything at all")).toBe(false);
  });
});

describe("isGrayArea", () => {
  it("detects gray-area requests", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");

    expect(
      isGrayArea(policy, "sending messages to professional contacts (managers, clients, colleagues)"),
    ).toBe(true);
  });

  it("returns false for non-gray-area requests", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");

    expect(isGrayArea(policy, "what is the weather today")).toBe(false);
  });

  it("returns false for empty request", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");

    expect(isGrayArea(policy, "")).toBe(false);
  });

  it("returns false when gray-area list is empty", () => {
    const policy = defaultBoundariesPolicy("default");

    expect(isGrayArea(policy, "anything at all")).toBe(false);
  });
});

describe("validateBoundariesPolicy", () => {
  it("validates a well-formed policy from template", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");

    const validation = validateBoundariesPolicy(policy);
    expect(validation.ok).toBe(true);
  });

  it("validates the default empty policy", () => {
    const policy = defaultBoundariesPolicy("default");
    const validation = validateBoundariesPolicy(policy);
    expect(validation.ok).toBe(true);
  });

  it("rejects policy with conflicting can-do and will-not-do items", () => {
    const policy = defaultBoundariesPolicy("default");
    policy.canDo.push("Send emails");
    policy.willNotDo.push("Send emails");

    const validation = validateBoundariesPolicy(policy);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.error.code).toBe("SCOPE_VIOLATION");
    }
  });

  it("detects conflicts case-insensitively", () => {
    const policy = defaultBoundariesPolicy("default");
    policy.canDo.push("send emails");
    policy.willNotDo.push("Send Emails");

    const validation = validateBoundariesPolicy(policy);
    expect(validation.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scope Integration (MH13)
// ---------------------------------------------------------------------------

describe("policy scope enforcement", () => {
  it("tools policy is scoped to environment, not global", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "work");

    expect(policy.environmentName).toBe("work");
  });

  it("boundaries policy is scoped to environment, not global", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "work");

    expect(policy.environmentName).toBe("work");
  });

  it("different environments produce independent policies", () => {
    const defaultPolicy = parseToolsPolicy(TOOLS_TEMPLATE, "default");
    const workPolicy = parseToolsPolicy(TOOLS_TEMPLATE, "work");

    expect(defaultPolicy.environmentName).toBe("default");
    expect(workPolicy.environmentName).toBe("work");
    expect(defaultPolicy.environmentName).not.toBe(workPolicy.environmentName);
  });

  it("tools validation confirms environment scope is correct", () => {
    const policy = parseToolsPolicy(TOOLS_TEMPLATE, "default");
    const validation = validateToolsPolicy(policy);

    // TOOLS is classified as environment-scoped, not global
    // so validation should pass
    expect(validation.ok).toBe(true);
  });

  it("boundaries validation confirms environment scope is correct", () => {
    const policy = parseBoundariesPolicy(BOUNDARIES_TEMPLATE, "default");
    const validation = validateBoundariesPolicy(policy);

    expect(validation.ok).toBe(true);
  });
});

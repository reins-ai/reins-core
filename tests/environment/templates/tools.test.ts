import { describe, expect, it } from "bun:test";

import {
  TOOLS_TEMPLATE,
  STRUCTURED_EXTRACTION_EXAMPLES,
} from "../../../src/environment/templates/tools.md";
import { getTemplate } from "../../../src/environment/templates";

describe("STRUCTURED_EXTRACTION_EXAMPLES", () => {
  it("is a non-empty string", () => {
    expect(typeof STRUCTURED_EXTRACTION_EXAMPLES).toBe("string");
    expect(STRUCTURED_EXTRACTION_EXAMPLES.length).toBeGreaterThan(0);
  });

  it("contains the extract-to-table pattern", () => {
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("### Extract to Table");
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("search_documents");
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("Markdown table");
  });

  it("contains the find-all-mentions pattern", () => {
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("### Find All Mentions");
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("ACME Corp");
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("source document");
  });

  it("contains the compare-documents pattern", () => {
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("### Compare Documents");
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("side-by-side comparison");
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("contract-a.pdf");
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("contract-b.pdf");
  });

  it("shows user request patterns for each example", () => {
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain(
      '**User:** "Extract all dates and amounts from my invoices"',
    );
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain(
      "**User:** \"Find every mention of 'ACME Corp' in my contracts\"",
    );
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain(
      '**User:** "Compare the payment terms in contract A vs contract B"',
    );
  });

  it("shows tool call syntax for each example", () => {
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain(
      'search_documents({ query: "invoice date amount total", top_k: 10 })',
    );
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain(
      'search_documents({ query: "ACME Corp", top_k: 20 })',
    );
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain(
      'search_documents({ query: "payment terms", source: "contract-a.pdf" })',
    );
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain(
      'search_documents({ query: "payment terms", source: "contract-b.pdf" })',
    );
  });

  it("shows structured output format for each example", () => {
    // Extract to table: Markdown table with headers
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("| Date | Invoice # | Amount | Source |");

    // Find all mentions: grouped by source with section references
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("contracts/service-agreement.pdf");
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("Section 2.1");

    // Compare documents: comparison table
    expect(STRUCTURED_EXTRACTION_EXAMPLES).toContain("| Aspect | Contract A | Contract B |");
  });
});

describe("TOOLS_TEMPLATE", () => {
  it("includes the structured extraction examples section", () => {
    expect(TOOLS_TEMPLATE).toContain("## Structured Extraction with Documents");
    expect(TOOLS_TEMPLATE).toContain("### Extract to Table");
    expect(TOOLS_TEMPLATE).toContain("### Find All Mentions");
    expect(TOOLS_TEMPLATE).toContain("### Compare Documents");
  });

  it("preserves the original tools content", () => {
    expect(TOOLS_TEMPLATE).toContain("# TOOLS");
    expect(TOOLS_TEMPLATE).toContain("## Tool Behavior Philosophy");
    expect(TOOLS_TEMPLATE).toContain("## Global Aggressiveness");
    expect(TOOLS_TEMPLATE).toContain("## Tool-Specific Settings");
    expect(TOOLS_TEMPLATE).toContain("## Tool Usage Patterns");
  });

  it("places extraction examples after the original content", () => {
    const notesIndex = TOOLS_TEMPLATE.indexOf("## Notes");
    const extractionIndex = TOOLS_TEMPLATE.indexOf("## Structured Extraction with Documents");

    expect(notesIndex).toBeGreaterThan(-1);
    expect(extractionIndex).toBeGreaterThan(-1);
    expect(extractionIndex).toBeGreaterThan(notesIndex);
  });
});

describe("TOOLS_TEMPLATE memory section", () => {
  it("contains the Memory section", () => {
    expect(TOOLS_TEMPLATE).toContain("### Memory");
    expect(TOOLS_TEMPLATE).toContain("**Status:** enabled");
  });

  it("contains all 5 memory actions", () => {
    expect(TOOLS_TEMPLATE).toContain('action: "remember"');
    expect(TOOLS_TEMPLATE).toContain('action: "recall"');
    expect(TOOLS_TEMPLATE).toContain('action: "update"');
    expect(TOOLS_TEMPLATE).toContain('action: "delete"');
    expect(TOOLS_TEMPLATE).toContain('action: "list"');
  });

  it("contains natural language examples for each action", () => {
    expect(TOOLS_TEMPLATE).toContain("**Natural Language → Action Mapping:**");
    expect(TOOLS_TEMPLATE).toContain('"Remember that..."');
    expect(TOOLS_TEMPLATE).toContain('"Recall my preferences for X"');
    expect(TOOLS_TEMPLATE).toContain('"Update my X to Y"');
    expect(TOOLS_TEMPLATE).toContain('"Forget that I X"');
    expect(TOOLS_TEMPLATE).toContain('"What have you remembered about me?"');
  });

  it("contains proactive remembering guidance", () => {
    expect(TOOLS_TEMPLATE).toContain("**When to Remember Proactively:**");
    expect(TOOLS_TEMPLATE).toContain("User states a preference explicitly");
    expect(TOOLS_TEMPLATE).toContain("User shares an important personal fact");
  });

  it("contains memory type descriptions", () => {
    expect(TOOLS_TEMPLATE).toContain("**Memory Types to Use:**");
    expect(TOOLS_TEMPLATE).toContain("`fact`");
    expect(TOOLS_TEMPLATE).toContain("`preference`");
    expect(TOOLS_TEMPLATE).toContain("`decision`");
    expect(TOOLS_TEMPLATE).toContain("`episode`");
    expect(TOOLS_TEMPLATE).toContain("`skill`");
    expect(TOOLS_TEMPLATE).toContain("`entity`");
  });

  it("places memory section before disabled tools", () => {
    const memoryIndex = TOOLS_TEMPLATE.indexOf("### Memory");
    const disabledIndex = TOOLS_TEMPLATE.indexOf("## Disabled Tools");

    expect(memoryIndex).toBeGreaterThan(-1);
    expect(disabledIndex).toBeGreaterThan(-1);
    expect(memoryIndex).toBeLessThan(disabledIndex);
  });
});

describe("getTemplate for TOOLS.md", () => {
  it("returns the full tools template including extraction examples", () => {
    const template = getTemplate("TOOLS.md");

    expect(template).toBe(TOOLS_TEMPLATE);
    expect(template).toContain("## Structured Extraction with Documents");
    expect(template).toContain("### Extract to Table");
    expect(template).toContain("### Find All Mentions");
    expect(template).toContain("### Compare Documents");
  });
});

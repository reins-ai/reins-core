import { describe, expect, it } from "bun:test";

import {
  KnowledgeService,
  parseKnowledgeDocument,
} from "../../src/environment/knowledge";

const SAMPLE_KNOWLEDGE = `# KNOWLEDGE

<!-- Structured reference facts -->

## How This Works

Your assistant knows this knowledge base exists.

---

## People

### Sarah Chen
**Relationship:** Manager
**Contact:** sarah.chen@company.com, +1-555-0123
**Preferences:**
- Prefers email for non-urgent topics
- Available for 1:1s on Thursdays

**Notes:**
- Appreciates proactive communication

---

### Alex Rodriguez
**Relationship:** Colleague (Frontend Lead)
**Contact:** alex.r@company.com, Slack: @alex
**Preferences:**
- Prefers Slack for quick questions

---

## Places

### Home Office
**Address:** 123 Main St
**Type:** Primary workspace

**Notes:**
- Preferred location for deep work

---

### Downtown Coffee Lab
**Address:** 456 Main St, Downtown
**Type:** Alternate workspace

---

## Health

### Allergies
- **Peanuts**: Severe (carry EpiPen)
- **Shellfish**: Moderate (avoid)

### Medications
- **Daily Vitamin D**: 2000 IU, taken with breakfast

---

## Preferences

### Dietary
**Restrictions:**
- No peanuts (allergy)
- Vegetarian-friendly options preferred

**Favorites:**
- Cuisine: Italian, Japanese

---

### Travel
**Preferences:**
- Window seat on flights

---

## Custom Sections

<!-- Add your own -->

## Usage Notes

- Keep information current
`;

describe("parseKnowledgeDocument", () => {
  it("parses sections from well-structured markdown", () => {
    const doc = parseKnowledgeDocument(SAMPLE_KNOWLEDGE);

    expect(doc.sections).toEqual(["People", "Places", "Health", "Preferences"]);
  });

  it("extracts sub-entries with correct section assignment", () => {
    const doc = parseKnowledgeDocument(SAMPLE_KNOWLEDGE);

    const peopleEntries = doc.entries.filter((e) => e.section === "People");
    expect(peopleEntries).toHaveLength(2);
    expect(peopleEntries[0].key).toBe("Sarah Chen");
    expect(peopleEntries[1].key).toBe("Alex Rodriguez");
  });

  it("captures entry value without the heading line", () => {
    const doc = parseKnowledgeDocument(SAMPLE_KNOWLEDGE);

    const sarah = doc.entries.find((e) => e.key === "Sarah Chen");
    expect(sarah).toBeDefined();
    expect(sarah!.value).not.toContain("### Sarah Chen");
    expect(sarah!.value).toContain("**Relationship:** Manager");
    expect(sarah!.value).toContain("sarah.chen@company.com");
  });

  it("includes heading in raw but not in value", () => {
    const doc = parseKnowledgeDocument(SAMPLE_KNOWLEDGE);

    const sarah = doc.entries.find((e) => e.key === "Sarah Chen");
    expect(sarah).toBeDefined();
    expect(sarah!.raw).toContain("### Sarah Chen");
    expect(sarah!.value).not.toContain("### Sarah Chen");
  });

  it("skips meta sections (How This Works, Custom Sections, Usage Notes)", () => {
    const doc = parseKnowledgeDocument(SAMPLE_KNOWLEDGE);

    expect(doc.sections).not.toContain("How This Works");
    expect(doc.sections).not.toContain("Custom Sections");
    expect(doc.sections).not.toContain("Usage Notes");
    expect(doc.entries.find((e) => e.section === "How This Works")).toBeUndefined();
  });

  it("returns empty document for empty content", () => {
    const doc = parseKnowledgeDocument("");

    expect(doc.sections).toEqual([]);
    expect(doc.entries).toEqual([]);
  });

  it("returns empty document for whitespace-only content", () => {
    const doc = parseKnowledgeDocument("   \n\n  \n  ");

    expect(doc.sections).toEqual([]);
    expect(doc.entries).toEqual([]);
  });

  it("handles section with no sub-entries as a single entry", () => {
    const content = `## Notes

Some general notes here.
More notes on the next line.
`;
    const doc = parseKnowledgeDocument(content);

    expect(doc.sections).toEqual(["Notes"]);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].key).toBe("Notes");
    expect(doc.entries[0].value).toContain("Some general notes here.");
    expect(doc.entries[0].value).toContain("More notes on the next line.");
  });

  it("handles document with only a title and no sections", () => {
    const content = `# KNOWLEDGE

Just a title, no sections.
`;
    const doc = parseKnowledgeDocument(content);

    expect(doc.sections).toEqual([]);
    expect(doc.entries).toEqual([]);
  });
});

describe("KnowledgeService", () => {
  describe("listSections", () => {
    it("returns all section names", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);

      expect(service.listSections()).toEqual([
        "People",
        "Places",
        "Health",
        "Preferences",
      ]);
    });

    it("returns empty array for empty document", () => {
      const service = new KnowledgeService("");

      expect(service.listSections()).toEqual([]);
    });

    it("returns a copy that does not mutate internal state", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);
      const sections = service.listSections();
      sections.push("Injected");

      expect(service.listSections()).not.toContain("Injected");
    });
  });

  describe("getSection", () => {
    it("returns all entries in a section by exact name", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);
      const people = service.getSection("People");

      expect(people).toHaveLength(2);
      expect(people[0].key).toBe("Sarah Chen");
      expect(people[1].key).toBe("Alex Rodriguez");
    });

    it("matches section name case-insensitively", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);

      expect(service.getSection("people")).toHaveLength(2);
      expect(service.getSection("PEOPLE")).toHaveLength(2);
      expect(service.getSection("PeOpLe")).toHaveLength(2);
    });

    it("returns empty array for non-existent section", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);

      expect(service.getSection("Nonexistent")).toEqual([]);
    });

    it("returns empty array for empty document", () => {
      const service = new KnowledgeService("");

      expect(service.getSection("People")).toEqual([]);
    });
  });

  describe("query", () => {
    it("finds entries by section name", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);
      const results = service.query("People");

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((r) => r.section === "People")).toBe(true);
    });

    it("finds entries by sub-entry key", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);
      const results = service.query("Sarah Chen");

      expect(results).toHaveLength(1);
      expect(results[0].key).toBe("Sarah Chen");
      expect(results[0].section).toBe("People");
    });

    it("finds entries by content keyword", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);
      const results = service.query("EpiPen");

      expect(results).toHaveLength(1);
      expect(results[0].section).toBe("Health");
      expect(results[0].key).toBe("Allergies");
    });

    it("performs case-insensitive matching", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);

      const lower = service.query("epipen");
      const upper = service.query("EPIPEN");
      const mixed = service.query("EpiPen");

      expect(lower).toHaveLength(1);
      expect(upper).toHaveLength(1);
      expect(mixed).toHaveLength(1);
    });

    it("returns empty array when no matches found", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);

      expect(service.query("xyznonexistent")).toEqual([]);
    });

    it("returns empty array for empty document", () => {
      const service = new KnowledgeService("");

      expect(service.query("anything")).toEqual([]);
    });

    it("matches partial keywords in content", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);
      const results = service.query("Slack");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.key === "Alex Rodriguez")).toBe(true);
    });

    it("matches across multiple sections when keyword appears in several", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);
      // "peanuts" appears in Health (Allergies) and Preferences (Dietary)
      const results = service.query("peanuts");

      expect(results.length).toBeGreaterThanOrEqual(2);
      const sections = new Set(results.map((r) => r.section));
      expect(sections.has("Health")).toBe(true);
      expect(sections.has("Preferences")).toBe(true);
    });
  });

  describe("entryCount", () => {
    it("returns total number of parsed entries", () => {
      const service = new KnowledgeService(SAMPLE_KNOWLEDGE);

      // People: Sarah Chen, Alex Rodriguez
      // Places: Home Office, Downtown Coffee Lab
      // Health: Allergies, Medications
      // Preferences: Dietary, Travel
      expect(service.entryCount).toBe(8);
    });

    it("returns 0 for empty document", () => {
      const service = new KnowledgeService("");

      expect(service.entryCount).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("handles document with horizontal rules between entries", () => {
      const content = `## People

### Alice
**Role:** Engineer

---

### Bob
**Role:** Designer

---
`;
      const service = new KnowledgeService(content);
      const people = service.getSection("People");

      expect(people).toHaveLength(2);
      expect(people[0].key).toBe("Alice");
      expect(people[1].key).toBe("Bob");
    });

    it("handles entries with empty content", () => {
      const content = `## People

### Empty Person
`;
      const doc = parseKnowledgeDocument(content);

      expect(doc.entries).toHaveLength(1);
      expect(doc.entries[0].key).toBe("Empty Person");
      expect(doc.entries[0].value).toBe("");
    });

    it("handles multiple sections with mixed sub-entry and section-level content", () => {
      const content = `## Quick Notes

Remember to check email daily.
Follow up on project status.

## People

### Jane
**Role:** PM
`;
      const service = new KnowledgeService(content);

      const notes = service.getSection("Quick Notes");
      expect(notes).toHaveLength(1);
      expect(notes[0].key).toBe("Quick Notes");
      expect(notes[0].value).toContain("Remember to check email daily.");

      const people = service.getSection("People");
      expect(people).toHaveLength(1);
      expect(people[0].key).toBe("Jane");
    });

    it("handles document with only H1 title", () => {
      const service = new KnowledgeService("# KNOWLEDGE");

      expect(service.listSections()).toEqual([]);
      expect(service.entryCount).toBe(0);
    });

    it("handles consecutive sections with no content", () => {
      const content = `## Section A

## Section B

### Entry B1
Some content
`;
      const service = new KnowledgeService(content);

      expect(service.listSections()).toEqual(["Section A", "Section B"]);
      expect(service.getSection("Section A")).toEqual([]);
      expect(service.getSection("Section B")).toHaveLength(1);
    });
  });
});

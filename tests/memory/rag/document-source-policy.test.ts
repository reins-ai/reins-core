import { describe, expect, it } from "bun:test";

import {
  DEFAULT_SOURCE_POLICY,
  matchesPolicy,
  type DocumentSourcePolicy,
} from "../../../src/memory/rag/document-source-policy";

describe("document-source-policy security", () => {
  const sourceRoot = "/docs";

  it("rejects parent-relative traversal paths", () => {
    expect(matchesPolicy("../secret.md", DEFAULT_SOURCE_POLICY, sourceRoot)).toBe(false);
    expect(matchesPolicy("../../etc/passwd", DEFAULT_SOURCE_POLICY, sourceRoot)).toBe(false);
  });

  it("rejects absolute paths outside source root", () => {
    expect(matchesPolicy("/etc/passwd", DEFAULT_SOURCE_POLICY, sourceRoot)).toBe(false);
  });

  it("accepts valid in-root markdown paths", () => {
    expect(matchesPolicy("notes/readme.md", DEFAULT_SOURCE_POLICY, sourceRoot)).toBe(true);
    expect(matchesPolicy("/docs/notes/readme.md", DEFAULT_SOURCE_POLICY, sourceRoot)).toBe(true);
  });

  it("still applies include and exclude rules after containment checks", () => {
    const policy: DocumentSourcePolicy = {
      ...DEFAULT_SOURCE_POLICY,
      includePaths: ["**/*.md", "**/*.txt"],
      excludePaths: ["private/**/*.md"],
    };

    expect(matchesPolicy("notes/info.txt", policy, sourceRoot)).toBe(true);
    expect(matchesPolicy("private/secret.md", policy, sourceRoot)).toBe(false);
  });
});

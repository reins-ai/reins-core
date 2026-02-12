import { describe, expect, it } from "bun:test";

import { validateManifest } from "../../src/plugins/manifest";

function createValidManifest() {
  return {
    name: "sample-plugin",
    version: "1.2.3",
    description: "A test plugin",
    author: "Reins Team",
    permissions: ["read_notes", "write_notes"],
    entryPoint: "index.ts",
  };
}

describe("validateManifest", () => {
  it("accepts a valid manifest", () => {
    const result = validateManifest(createValidManifest());

    expect(result.valid).toBe(true);
  });

  it("fails when required fields are missing", () => {
    const missingFields = [
      "name",
      "version",
      "description",
      "author",
      "permissions",
      "entryPoint",
    ] as const;

    for (const field of missingFields) {
      const manifest = createValidManifest() as Record<string, unknown>;
      manifest[field] = undefined;

      const result = validateManifest(manifest);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((error) => error.includes(field))).toBe(true);
      }
    }
  });

  it("rejects invalid plugin names", () => {
    const invalidNames = ["invalid name", "invalid_name", "invalid@name"];

    for (const name of invalidNames) {
      const result = validateManifest({
        ...createValidManifest(),
        name,
      });

      expect(result.valid).toBe(false);
    }
  });

  it("rejects invalid semver versions", () => {
    const result = validateManifest({
      ...createValidManifest(),
      version: "v1",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((error) => error.includes("version"))).toBe(true);
    }
  });

  it("rejects unknown permission values", () => {
    const result = validateManifest({
      ...createValidManifest(),
      permissions: ["read_notes", "unknown_permission"],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((error) => error.includes("permissions"))).toBe(true);
    }
  });

  it("rejects invalid entry point extensions", () => {
    const result = validateManifest({
      ...createValidManifest(),
      entryPoint: "index.json",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((error) => error.includes("entryPoint"))).toBe(true);
    }
  });

  it("accepts optional metadata fields", () => {
    const result = validateManifest({
      ...createValidManifest(),
      dependencies: {
        "some-dep": "^1.0.0",
      },
      homepage: "https://example.com",
      repository: "https://github.com/reins-ai/plugin",
      license: "MIT",
      minReinsVersion: "0.1.0",
    });

    expect(result.valid).toBe(true);
  });

  it("accepts an empty permissions array", () => {
    const result = validateManifest({
      ...createValidManifest(),
      permissions: [],
    });

    expect(result.valid).toBe(true);
  });
});

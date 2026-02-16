import { describe, expect, it } from "bun:test";

import {
  isValidKebabCase,
  isValidSemver,
  validateIntegrationManifest,
} from "../../src/integrations/manifest";

function createValidManifest() {
  return {
    id: "obsidian-notes",
    name: "Obsidian Notes",
    description: "Connect to your Obsidian vault",
    version: "1.0.0",
    author: "Reins Team",
    category: "productivity",
    auth: {
      type: "local_path",
      pathLabel: "Vault directory",
      mustExist: true,
    },
    permissions: ["read_notes", "write_notes"],
    platforms: ["daemon"],
    operations: [
      {
        name: "search-notes",
        description: "Search notes by content and title",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// isValidSemver
// ---------------------------------------------------------------------------

describe("isValidSemver", () => {
  it("accepts standard semver versions", () => {
    expect(isValidSemver("1.0.0")).toBe(true);
    expect(isValidSemver("0.1.0")).toBe(true);
    expect(isValidSemver("12.34.56")).toBe(true);
  });

  it("accepts semver with pre-release identifiers", () => {
    expect(isValidSemver("1.0.0-alpha")).toBe(true);
    expect(isValidSemver("1.0.0-alpha.1")).toBe(true);
    expect(isValidSemver("1.0.0-0.3.7")).toBe(true);
  });

  it("accepts semver with build metadata", () => {
    expect(isValidSemver("1.0.0+build.1")).toBe(true);
    expect(isValidSemver("1.0.0-alpha+001")).toBe(true);
  });

  it("rejects invalid semver strings", () => {
    expect(isValidSemver("v1.0.0")).toBe(false);
    expect(isValidSemver("1.0")).toBe(false);
    expect(isValidSemver("1")).toBe(false);
    expect(isValidSemver("")).toBe(false);
    expect(isValidSemver("not-a-version")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidKebabCase
// ---------------------------------------------------------------------------

describe("isValidKebabCase", () => {
  it("accepts valid kebab-case strings", () => {
    expect(isValidKebabCase("obsidian")).toBe(true);
    expect(isValidKebabCase("obsidian-notes")).toBe(true);
    expect(isValidKebabCase("my-cool-integration")).toBe(true);
    expect(isValidKebabCase("a1-b2-c3")).toBe(true);
  });

  it("rejects invalid kebab-case strings", () => {
    expect(isValidKebabCase("Obsidian")).toBe(false);
    expect(isValidKebabCase("obsidian_notes")).toBe(false);
    expect(isValidKebabCase("obsidian notes")).toBe(false);
    expect(isValidKebabCase("obsidian--notes")).toBe(false);
    expect(isValidKebabCase("-obsidian")).toBe(false);
    expect(isValidKebabCase("obsidian-")).toBe(false);
    expect(isValidKebabCase("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateIntegrationManifest — valid manifests
// ---------------------------------------------------------------------------

describe("validateIntegrationManifest", () => {
  it("accepts a valid manifest", () => {
    const result = validateIntegrationManifest(createValidManifest());

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.id).toBe("obsidian-notes");
      expect(result.value.name).toBe("Obsidian Notes");
      expect(result.value.version).toBe("1.0.0");
      expect(result.value.operations).toHaveLength(1);
    }
  });

  it("accepts a manifest with oauth2 auth type", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      id: "adapter-alpha",
      auth: {
        type: "oauth2",
        scopes: ["alpha.readonly", "alpha.send"],
        authorizationUrl: "https://auth.example.com/oauth2/authorize",
        tokenUrl: "https://auth.example.com/oauth2/token",
        pkce: true,
      },
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.auth.type).toBe("oauth2");
      if (result.value.auth.type === "oauth2") {
        expect(result.value.auth.scopes).toEqual(["alpha.readonly", "alpha.send"]);
        expect(result.value.auth.pkce).toBe(true);
      }
    }
  });

  it("accepts a manifest with api_key auth type", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      id: "some-api",
      auth: { type: "api_key", headerName: "X-API-Key" },
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.auth.type).toBe("api_key");
    }
  });

  it("accepts a manifest with multiple platforms", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      platforms: ["daemon", "tui", "desktop"],
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.platforms).toEqual(["daemon", "tui", "desktop"]);
    }
  });

  it("accepts a manifest with multiple operations", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      operations: [
        {
          name: "search-notes",
          description: "Search notes",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
            },
          },
        },
        {
          name: "read-note",
          description: "Read a note",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Note path" },
            },
          },
        },
      ],
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.operations).toHaveLength(2);
    }
  });

  it("accepts a manifest with empty permissions array", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      permissions: [],
    });

    expect(result.valid).toBe(true);
  });

  it("trims whitespace from string fields", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      id: "  obsidian-notes  ",
      name: "  Obsidian Notes  ",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.id).toBe("obsidian-notes");
      expect(result.value.name).toBe("Obsidian Notes");
    }
  });

  it("accepts parameters as array and converts to schema", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      operations: [
        {
          name: "search-notes",
          description: "Search notes",
          parameters: [
            {
              name: "query",
              type: "string",
              description: "Search query",
              required: true,
            },
            {
              name: "limit",
              type: "number",
              description: "Max results",
            },
          ],
        },
      ],
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      const params = result.value.operations[0].parameters;
      expect(params.type).toBe("object");
      expect(params.properties?.query?.type).toBe("string");
      expect(params.properties?.limit?.type).toBe("number");
      expect(params.required).toEqual(["query"]);
    }
  });

  // ---------------------------------------------------------------------------
  // Non-object input
  // ---------------------------------------------------------------------------

  it("rejects non-object input", () => {
    const result = validateIntegrationManifest("not an object");

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain("Manifest must be an object");
    }
  });

  it("rejects null input", () => {
    const result = validateIntegrationManifest(null);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain("Manifest must be an object");
    }
  });

  it("rejects array input", () => {
    const result = validateIntegrationManifest([]);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain("Manifest must be an object");
    }
  });

  // ---------------------------------------------------------------------------
  // Missing required fields
  // ---------------------------------------------------------------------------

  it("reports all missing required string fields", () => {
    const result = validateIntegrationManifest({});

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("id"))).toBe(true);
      expect(result.errors.some((e) => e.includes("name"))).toBe(true);
      expect(result.errors.some((e) => e.includes("description"))).toBe(true);
      expect(result.errors.some((e) => e.includes("version"))).toBe(true);
      expect(result.errors.some((e) => e.includes("author"))).toBe(true);
      expect(result.errors.some((e) => e.includes("category"))).toBe(true);
    }
  });

  it("reports missing auth field", () => {
    const manifest = createValidManifest() as Record<string, unknown>;
    delete manifest.auth;

    const result = validateIntegrationManifest(manifest);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("auth"))).toBe(true);
    }
  });

  it("reports missing operations field", () => {
    const manifest = createValidManifest() as Record<string, unknown>;
    delete manifest.operations;

    const result = validateIntegrationManifest(manifest);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("operations"))).toBe(true);
    }
  });

  it("reports missing platforms field", () => {
    const manifest = createValidManifest() as Record<string, unknown>;
    delete manifest.platforms;

    const result = validateIntegrationManifest(manifest);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("platforms"))).toBe(true);
    }
  });

  it("reports missing permissions field", () => {
    const manifest = createValidManifest() as Record<string, unknown>;
    delete manifest.permissions;

    const result = validateIntegrationManifest(manifest);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("permissions"))).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Empty required string fields
  // ---------------------------------------------------------------------------

  it("rejects empty string for required fields", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      id: "",
      name: "",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("id") && e.includes("empty"))).toBe(true);
      expect(result.errors.some((e) => e.includes("name") && e.includes("empty"))).toBe(true);
    }
  });

  it("rejects whitespace-only string for required fields", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      id: "   ",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("id") && e.includes("empty"))).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // ID validation (kebab-case)
  // ---------------------------------------------------------------------------

  it("rejects non-kebab-case id", () => {
    const invalidIds = [
      "ObsidianNotes",
      "obsidian_notes",
      "obsidian notes",
      "OBSIDIAN",
      "obsidian--notes",
      "-obsidian",
    ];

    for (const id of invalidIds) {
      const result = validateIntegrationManifest({
        ...createValidManifest(),
        id,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes("id") && e.includes("kebab-case"))).toBe(
          true,
        );
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Version validation (semver)
  // ---------------------------------------------------------------------------

  it("rejects invalid semver version", () => {
    const invalidVersions = ["v1.0.0", "1.0", "1", "latest", ""];

    for (const version of invalidVersions) {
      const result = validateIntegrationManifest({
        ...createValidManifest(),
        version,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some((e) => e.includes("version")),
        ).toBe(true);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Category validation
  // ---------------------------------------------------------------------------

  it("rejects invalid category", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      category: "invalid-category",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("category") && e.includes("must be one of"))).toBe(
        true,
      );
    }
  });

  it("accepts all valid categories", () => {
    const categories = [
      "productivity",
      "communication",
      "media",
      "developer",
      "files",
      "knowledge",
      "automation",
      "utilities",
      "other",
    ];

    for (const category of categories) {
      const result = validateIntegrationManifest({
        ...createValidManifest(),
        category,
      });

      expect(result.valid).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Auth validation
  // ---------------------------------------------------------------------------

  it("rejects invalid auth type", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      auth: { type: "basic_auth" },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("auth.type") && e.includes("must be one of"))).toBe(
        true,
      );
    }
  });

  it("rejects auth without type", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      auth: { scopes: ["read"] },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("auth.type"))).toBe(true);
    }
  });

  it("rejects non-object auth", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      auth: "oauth2",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("auth") && e.includes("object"))).toBe(true);
    }
  });

  it("rejects non-array auth scopes for oauth2", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      auth: { type: "oauth2", scopes: "alpha.readonly" },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("auth.scopes"))).toBe(true);
    }
  });

  it("rejects non-string values in auth scopes", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      auth: { type: "oauth2", scopes: [123] },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("auth.scopes") && e.includes("strings"))).toBe(
        true,
      );
    }
  });

  it("rejects non-boolean pkce for oauth2", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      auth: { type: "oauth2", scopes: [], pkce: "yes" },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("auth.pkce") && e.includes("boolean"))).toBe(
        true,
      );
    }
  });

  it("rejects non-boolean mustExist for local_path", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      auth: { type: "local_path", mustExist: "yes" },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("auth.mustExist") && e.includes("boolean"))).toBe(
        true,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Platform validation
  // ---------------------------------------------------------------------------

  it("rejects invalid platform values", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      platforms: ["daemon", "android"],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("platforms") && e.includes("android"))).toBe(
        true,
      );
    }
  });

  it("rejects empty platforms array", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      platforms: [],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("platforms") && e.includes("at least one"))).toBe(
        true,
      );
    }
  });

  it("rejects non-string values in platforms", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      platforms: [123],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("platforms") && e.includes("invalid"))).toBe(
        true,
      );
    }
  });

  it("accepts all valid platform values", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      platforms: ["daemon", "tui", "desktop", "mobile", "api"],
    });

    expect(result.valid).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Operations validation
  // ---------------------------------------------------------------------------

  it("rejects empty operations array", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      operations: [],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) => e.includes("operations") && e.includes("at least one")),
      ).toBe(true);
    }
  });

  it("rejects non-array operations", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      operations: "search",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("operations") && e.includes("array"))).toBe(
        true,
      );
    }
  });

  it("rejects operation without required fields", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      operations: [{ parameters: {} }],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("operations[0]") && e.includes("name"))).toBe(
        true,
      );
      expect(
        result.errors.some((e) => e.includes("operations[0]") && e.includes("description")),
      ).toBe(true);
    }
  });

  it("rejects operation with non-kebab-case name", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      operations: [
        {
          name: "searchNotes",
          description: "Search notes",
          parameters: {},
        },
      ],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) => e.includes("operations[0]") && e.includes("kebab-case")),
      ).toBe(true);
    }
  });

  it("rejects operation with non-object entry", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      operations: ["search-notes"],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("operations[0]") && e.includes("object"))).toBe(
        true,
      );
    }
  });

  it("rejects operation with missing parameters", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      operations: [
        {
          name: "search-notes",
          description: "Search notes",
        },
      ],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) => e.includes("parameters")),
      ).toBe(true);
    }
  });

  it("accepts operation with empty object parameters", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      operations: [
        {
          name: "get-status",
          description: "Get current status",
          parameters: {},
        },
      ],
    });

    expect(result.valid).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Array-style parameter validation
  // ---------------------------------------------------------------------------

  it("rejects array parameter without required fields", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      operations: [
        {
          name: "search-notes",
          description: "Search notes",
          parameters: [{}],
        },
      ],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) => e.includes("parameters[0]") && e.includes("name")),
      ).toBe(true);
      expect(
        result.errors.some((e) => e.includes("parameters[0]") && e.includes("type")),
      ).toBe(true);
      expect(
        result.errors.some((e) => e.includes("parameters[0]") && e.includes("description")),
      ).toBe(true);
    }
  });

  it("rejects array parameter with non-boolean required field", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      operations: [
        {
          name: "search-notes",
          description: "Search notes",
          parameters: [
            {
              name: "query",
              type: "string",
              description: "Search query",
              required: "yes",
            },
          ],
        },
      ],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("required") && e.includes("boolean"))).toBe(
        true,
      );
    }
  });

  it("rejects non-object entry in array parameters", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      operations: [
        {
          name: "search-notes",
          description: "Search notes",
          parameters: ["query"],
        },
      ],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) => e.includes("parameters[0]") && e.includes("object")),
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Permissions validation
  // ---------------------------------------------------------------------------

  it("rejects non-string values in permissions", () => {
    const result = validateIntegrationManifest({
      ...createValidManifest(),
      permissions: [123, true],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("permissions") && e.includes("non-string"))).toBe(
        true,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Multiple errors accumulated
  // ---------------------------------------------------------------------------

  it("accumulates multiple errors in a single validation", () => {
    const result = validateIntegrationManifest({
      id: "INVALID",
      name: "",
      version: "bad",
      auth: "not-an-object",
      operations: [],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(3);
    }
  });
});

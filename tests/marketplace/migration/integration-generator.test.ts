import { describe, expect, it } from "bun:test";

import { generateIntegrationMd } from "../../../src/marketplace/migration/integration-generator";

describe("generateIntegrationMd", () => {
  it("generates brew install instructions", () => {
    const output = generateIntegrationMd({
      install: {
        kind: "brew",
        package: "jq",
      },
    });

    expect(output).not.toBeNull();
    expect(output).toContain("brew install jq");
  });

  it("generates npm install instructions", () => {
    const output = generateIntegrationMd({
      install: {
        kind: "npm",
        package: "openclaw-utils",
      },
    });

    expect(output).not.toBeNull();
    expect(output).toContain("npm install openclaw-utils");
  });

  it("generates go install instructions", () => {
    const output = generateIntegrationMd({
      install: {
        kind: "go",
        package: "github.com/example/tool/cmd/tool@latest",
      },
    });

    expect(output).not.toBeNull();
    expect(output).toContain("go install github.com/example/tool/cmd/tool@latest");
  });

  it("generates uv/python install instructions", () => {
    const output = generateIntegrationMd({
      install: {
        kind: "python",
        package: "openclaw-helper",
      },
    });

    expect(output).not.toBeNull();
    expect(output).toContain("uv pip install openclaw-helper");
  });

  it("includes environment variables section", () => {
    const output = generateIntegrationMd({
      requires: {
        env: ["OPENAI_API_KEY", "GITHUB_TOKEN"],
      },
    });

    expect(output).not.toBeNull();
    expect(output).toContain("Environment variables");
    expect(output).toContain("OPENAI_API_KEY");
    expect(output).toContain("GITHUB_TOKEN");
  });

  it("includes configuration section", () => {
    const output = generateIntegrationMd({
      config: {
        endpoint: "https://api.example.com",
        retries: 3,
      },
    });

    expect(output).not.toBeNull();
    expect(output).toContain("## Configuration");
    expect(output).toContain("endpoint: https://api.example.com");
    expect(output).toContain("retries: 3");
  });

  it("returns null when no config or requirements exist", () => {
    const output = generateIntegrationMd({});
    expect(output).toBeNull();
  });
});

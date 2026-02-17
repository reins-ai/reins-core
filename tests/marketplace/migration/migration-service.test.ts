import { describe, expect, it } from "bun:test";

import {
  MigrationService,
  type ChatFn,
} from "../../../src/marketplace/migration/migration-service";

function createOpenClawSkill(overrides?: { metadataBlock?: string }): string {
  return `---
name: calendar-sync
description: Keep calendars in sync
version: 1.0.0
author: openclaw
metadata:
  openclaw:
    requires:
      env:
        - OPENAI_API_KEY
      bins:
        - node
    config:
      endpoint: https://api.example.com
${overrides?.metadataBlock ?? ""}---

# Calendar Sync

Sync calendars safely.
`;
}

function createService(chatFn: ChatFn): MigrationService {
  return new MigrationService({ chatFn });
}

describe("MigrationService", () => {
  it("returns LLM conversion output when response is valid", async () => {
    const chatFn: ChatFn = async () => {
      return `<skill_md>
---
name: converted-calendar-sync
description: Converted
---

# Converted
</skill_md>
<integration_md>
# INTEGRATION.md

Use this integration.
</integration_md>`;
    };

    const service = createService(chatFn);
    const result = await service.convert(createOpenClawSkill());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.report.usedLlm).toBe(true);
    expect(result.value.skillMd).toContain("name: converted-calendar-sync");
    expect(result.value.integrationMd).toContain("Use this integration.");
  });

  it("falls back to deterministic mapper when chat function throws", async () => {
    const chatFn: ChatFn = async () => {
      throw new Error("provider unavailable");
    };

    const service = createService(chatFn);
    const result = await service.convert(createOpenClawSkill());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.report.usedLlm).toBe(false);
    expect(result.value.skillMd).toContain("trustLevel: community");
    expect(result.value.report.warnings[0]).toContain("LLM call failed");
  });

  it("falls back to deterministic mapper on invalid LLM response", async () => {
    const chatFn: ChatFn = async () => "invalid payload without tagged sections";

    const service = createService(chatFn);
    const result = await service.convert(createOpenClawSkill());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.report.usedLlm).toBe(false);
    expect(result.value.skillMd).toContain("name: calendar-sync");
    expect(result.value.report.warnings[0]).toContain("LLM response was invalid");
  });

  it("deterministically generates integration markdown when LLM omits it", async () => {
    const chatFn: ChatFn = async () => {
      return `<skill_md>
---
name: llm-skill
description: Converted by llm
---

# LLM Skill
</skill_md>
<integration_md>
null
</integration_md>`;
    };

    const service = createService(chatFn);
    const result = await service.convert(createOpenClawSkill());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.report.usedLlm).toBe(true);
    expect(result.value.integrationMd).not.toBeNull();
    expect(result.value.integrationMd).toContain("OPENAI_API_KEY");
    expect(result.value.integrationMd).toContain("endpoint: https://api.example.com");
    expect(result.value.report.warnings[0]).toContain("generated deterministically");
  });

  it("supports alias metadata shapes through deterministic fallback", async () => {
    const chatFn: ChatFn = async () => {
      throw new Error("timeout");
    };
    const service = createService(chatFn);

    const result = await service.convert(`---
name: alias-skill
metadata:
  clawdbot:
    requires:
      bins:
        - go
    install:
      kind: go
      package: github.com/acme/tool/cmd/tool@latest
---

Alias body.
`);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.report.usedLlm).toBe(false);
    expect(result.value.skillMd).toContain("requiredTools:");
    expect(result.value.integrationMd).toContain("go install github.com/acme/tool/cmd/tool@latest");
  });
});

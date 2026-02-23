import { join } from "node:path";

import type { Agent, AgentIdentityFiles } from "./types";

export interface IdentityFileManagerOptions {
  // No required options — workspacePath comes from the Agent
}

const SOUL_TEMPLATE = `# {name} — Soul Document

**Role:** {role}
**Created:** {createdAt}

## Core Identity

You are {name}, an AI agent serving as {role}. You have opinions, make decisions, and figure
things out. You're not a passive responder — you're a participant. When something is unclear,
you investigate before asking. When something is wrong, you say so.

## Values

- **Genuine helpfulness** — skip the affirmations, just help. "Great question!" wastes everyone's time.
- **Resourcefulness** — try to figure it out first. Search, reason, attempt. Then ask if you're
  truly stuck. Come back with answers, not questions.
- **Directness** — say what you mean. If you disagree, say so. If you're uncertain, say that too.
- **Careful with external, bold with internal** — be deliberate before sending emails or making
  public changes. Be confident reading, organizing, and learning.
- **Honest about limits** — don't bluff. If you don't know, say so and go find out.

## Communication Style

Direct and clear. No filler. No hedging for its own sake.

Figure things out before asking. If you need information, look for it. If you need to reason
through something, do it. Ask when you're genuinely stuck — not as a first move.

Come back with answers, not questions. When you go off to investigate, return with something
useful: a finding, a recommendation, a concrete next step.

**Memory:** write things down. Use MEMORY.md at \`{workspacePath}/MEMORY.md\` for facts,
decisions, and context that should persist. Use daily notes for session-specific observations.
Mental notes evaporate — written ones don't.

This document lives at \`{workspacePath}/SOUL.md\`. Read it at the start of each session.
It's a reminder of who you are, not a rulebook.
`;

const MEMORY_TEMPLATE = `# {name} — Memory

**Agent:** {name}
**Role:** {role}
**Initialized:** {createdAt}

## Recent Context

_No recent context recorded yet._

## Important Facts

_No facts recorded yet._

## Ongoing Tasks

_No active tasks._
`;

const IDENTITY_TEMPLATE = `# {name} — Identity Reference

**Name:** {name}
**Role:** {role}
**Agent ID:** {id}
**Created:** {createdAt}

## Capabilities

Defined by assigned skills and model configuration.

## Workspace

\`{workspacePath}\`
`;

function renderTemplate(
  template: string,
  agent: Agent,
): string {
  return template
    .replace(/\{name\}/g, agent.name)
    .replace(/\{role\}/g, agent.role)
    .replace(/\{id\}/g, agent.id)
    .replace(/\{createdAt\}/g, agent.metadata.createdAt)
    .replace(/\{workspacePath\}/g, agent.workspacePath);
}

export class IdentityFileManager {
  constructor(_options?: IdentityFileManagerOptions) {
    // Reserved for future configuration
  }

  async generateIdentityFiles(agent: Agent): Promise<AgentIdentityFiles> {
    const soulPath = join(agent.workspacePath, "SOUL.md");
    const memoryPath = join(agent.workspacePath, "MEMORY.md");
    const identityPath = join(agent.workspacePath, "IDENTITY.md");

    await Bun.write(soulPath, renderTemplate(SOUL_TEMPLATE, agent));
    await Bun.write(memoryPath, renderTemplate(MEMORY_TEMPLATE, agent));
    await Bun.write(identityPath, renderTemplate(IDENTITY_TEMPLATE, agent));

    return {
      soul: soulPath,
      memory: memoryPath,
      identity: identityPath,
      custom: {},
    };
  }

  async readIdentityFile(
    workspacePath: string,
    fileName: string,
  ): Promise<string | null> {
    const filePath = join(workspacePath, fileName);
    const file = Bun.file(filePath);

    if (!(await file.exists())) {
      return null;
    }

    return file.text();
  }

  async writeIdentityFile(
    workspacePath: string,
    fileName: string,
    content: string,
  ): Promise<string> {
    const filePath = join(workspacePath, fileName);
    await Bun.write(filePath, content);
    return filePath;
  }
}

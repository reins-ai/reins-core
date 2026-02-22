import { join } from "node:path";

import type { Agent, AgentIdentityFiles } from "./types";

export interface IdentityFileManagerOptions {
  // No required options — workspacePath comes from the Agent
}

const SOUL_TEMPLATE = `# {name} — Soul Document

**Role:** {role}
**Created:** {createdAt}

## Core Identity

You are {name}, a specialized AI assistant serving as {role}.

## Values

- Excellence in your domain
- Clear and honest communication
- Proactive problem-solving

## Communication Style

Professional, thoughtful, and precise.
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

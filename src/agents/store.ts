import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { err, ok, type Result } from "../result";
import { AgentError } from "./errors";
import type { Agent } from "./types";

const DEFAULT_FILENAME = "agents.json";

interface AgentsFile {
  agents: Agent[];
}

export interface AgentStoreOptions {
  filePath?: string;
}

export class AgentStore {
  private readonly filePath: string;

  constructor(options?: AgentStoreOptions) {
    this.filePath = options?.filePath ?? join(homedir(), ".reins", DEFAULT_FILENAME);
  }

  async create(agent: Agent): Promise<Result<Agent, AgentError>> {
    const agents = await this.readAll();

    const existing = agents.find((a) => a.id === agent.id);
    if (existing) {
      return err(
        new AgentError(`Agent with id "${agent.id}" already exists`),
      );
    }

    agents.push(agent);
    await this.writeAll(agents);

    return ok(agent);
  }

  async get(id: string): Promise<Result<Agent | null, AgentError>> {
    const agents = await this.readAll();
    const agent = agents.find((a) => a.id === id) ?? null;
    return ok(agent);
  }

  async update(
    id: string,
    updates: Partial<Omit<Agent, "id" | "metadata">>,
  ): Promise<Result<Agent, AgentError>> {
    const agents = await this.readAll();
    const index = agents.findIndex((a) => a.id === id);

    if (index === -1) {
      return err(
        new AgentError(`Agent with id "${id}" not found`),
      );
    }

    const existing = agents[index];
    const updated: Agent = {
      ...existing,
      ...updates,
      id: existing.id,
      metadata: {
        ...existing.metadata,
        updatedAt: new Date().toISOString(),
      },
    };

    agents[index] = updated;
    await this.writeAll(agents);

    return ok(updated);
  }

  async delete(id: string): Promise<Result<boolean, AgentError>> {
    const agents = await this.readAll();
    const index = agents.findIndex((a) => a.id === id);

    if (index === -1) {
      return ok(false);
    }

    agents.splice(index, 1);
    await this.writeAll(agents);

    return ok(true);
  }

  async list(): Promise<Result<Agent[], AgentError>> {
    const agents = await this.readAll();

    const sorted = agents.slice().sort((a, b) =>
      a.metadata.createdAt.localeCompare(b.metadata.createdAt),
    );

    return ok(sorted);
  }

  private async readAll(): Promise<Agent[]> {
    const file = Bun.file(this.filePath);

    if (!(await file.exists())) {
      return [];
    }

    try {
      const raw: unknown = await file.json();
      return this.normalizeFile(raw);
    } catch {
      throw new AgentError(`Unable to parse agents file: ${this.filePath}`);
    }
  }

  private normalizeFile(raw: unknown): Agent[] {
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("agents" in raw) ||
      !Array.isArray((raw as Record<string, unknown>).agents)
    ) {
      return [];
    }

    return (raw as AgentsFile).agents;
  }

  private async writeAll(agents: Agent[]): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const data: AgentsFile = { agents };
      await Bun.write(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
    } catch (error) {
      throw new AgentError(
        `Unable to write agents file: ${this.filePath}`,
        error instanceof Error ? error : undefined,
      );
    }
  }
}

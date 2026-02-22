import type { IdentityFileManager } from "../agents/identity";
import type { AgentStore } from "../agents/store";
import type { Agent, AgentIdentityFiles, ModelOverride } from "../agents/types";

export interface AgentRouteHandler {
  handle(
    url: URL,
    method: string,
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response | null>;
}

export interface AgentRouteHandlerOptions {
  agentStore: AgentStore;
  /** When provided, generates SOUL.md / MEMORY.md / IDENTITY.md for newly created agents that have no identity files. */
  identityFileManager?: IdentityFileManager;
}

type AgentUpdate = Partial<Omit<Agent, "id" | "metadata">>;

class BadRequestError extends Error {}

function withJsonHeaders(headers: Record<string, string>): Headers {
  return new Headers({
    ...headers,
    "Content-Type": "application/json",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) {
    throw new BadRequestError("Request body is required");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequestError("Invalid JSON in request body");
  }
}

function parseAgentId(pathname: string): string | null {
  if (!pathname.startsWith("/api/agents/")) {
    return null;
  }

  const id = pathname.slice("/api/agents/".length);
  if (id.length === 0 || id.includes("/")) {
    return null;
  }

  return decodeURIComponent(id);
}

function ensureString(
  value: unknown,
  fieldName: string,
  options: { required?: boolean } = {},
): string | undefined {
  if (typeof value === "undefined" || value === null) {
    if (options.required) {
      throw new BadRequestError(`${fieldName} is required`);
    }
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestError(`${fieldName} must be a non-empty string`);
  }

  return value;
}

function parseModelOverride(value: unknown): ModelOverride | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new BadRequestError("modelOverride must be an object");
  }

  const provider = ensureString(value.provider, "modelOverride.provider", {
    required: true,
  });
  const model = ensureString(value.model, "modelOverride.model", { required: true });
  const temperature = value.temperature;
  const maxTokens = value.maxTokens;

  if (typeof temperature !== "undefined" && typeof temperature !== "number") {
    throw new BadRequestError("modelOverride.temperature must be a number");
  }

  if (typeof maxTokens !== "undefined" && typeof maxTokens !== "number") {
    throw new BadRequestError("modelOverride.maxTokens must be a number");
  }

  return {
    provider: provider!,
    model: model!,
    temperature,
    maxTokens,
  };
}

function parseSkills(value: unknown): string[] | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new BadRequestError("skills must be an array of strings");
  }

  return value;
}

function parseIdentityFiles(value: unknown): AgentIdentityFiles | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new BadRequestError("identityFiles must be an object");
  }

  const soul = ensureString(value.soul, "identityFiles.soul");
  const memory = ensureString(value.memory, "identityFiles.memory");
  const identity = ensureString(value.identity, "identityFiles.identity");
  const customValue = value.custom;

  if (!isRecord(customValue)) {
    throw new BadRequestError("identityFiles.custom must be an object");
  }

  const custom: Record<string, string> = {};
  for (const [key, customPath] of Object.entries(customValue)) {
    if (typeof customPath !== "string" || customPath.trim().length === 0) {
      throw new BadRequestError(`identityFiles.custom.${key} must be a non-empty string`);
    }
    custom[key] = customPath;
  }

  return {
    soul,
    memory,
    identity,
    custom,
  };
}

function validateCreateRequest(body: unknown): Agent {
  if (!isRecord(body)) {
    throw new BadRequestError("Request body must be an object");
  }

  const id = ensureString(body.id, "id", { required: true });
  const name = ensureString(body.name, "name", { required: true });
  const workspacePath = ensureString(body.workspacePath, "workspacePath", {
    required: true,
  });
  const role = ensureString(body.role, "role") ?? "assistant";
  const skills = parseSkills(body.skills) ?? [];
  const modelOverride = parseModelOverride(body.modelOverride);
  const identityFiles = parseIdentityFiles(body.identityFiles) ?? { custom: {} };

  const now = new Date().toISOString();

  const agent: Agent = {
    id: id!,
    name: name!,
    role,
    workspacePath: workspacePath!,
    skills,
    identityFiles,
    metadata: {
      createdAt: now,
      updatedAt: now,
    },
  };

  if (typeof modelOverride !== "undefined") {
    agent.modelOverride = modelOverride;
  }

  if (typeof body.personality !== "undefined") {
    agent.personality = body.personality as Agent["personality"];
  }

  return agent;
}

function validateUpdateRequest(body: unknown): AgentUpdate {
  if (!isRecord(body)) {
    throw new BadRequestError("Request body must be an object");
  }

  const updates: AgentUpdate = {};

  if (typeof body.name !== "undefined") {
    updates.name = ensureString(body.name, "name", { required: true })!;
  }

  if (typeof body.role !== "undefined") {
    updates.role = ensureString(body.role, "role", { required: true })!;
  }

  if (typeof body.workspacePath !== "undefined") {
    updates.workspacePath = ensureString(body.workspacePath, "workspacePath", {
      required: true,
    })!;
  }

  if (typeof body.skills !== "undefined") {
    updates.skills = parseSkills(body.skills)!;
  }

  if (typeof body.identityFiles !== "undefined") {
    updates.identityFiles = parseIdentityFiles(body.identityFiles)!;
  }

  if (typeof body.modelOverride !== "undefined") {
    updates.modelOverride = parseModelOverride(body.modelOverride);
  }

  if (typeof body.personality !== "undefined") {
    updates.personality = body.personality as Agent["personality"];
  }

  if (Object.keys(updates).length === 0) {
    throw new BadRequestError("Request body must include at least one updatable field");
  }

  return updates;
}

export function createAgentRouteHandler(options: AgentRouteHandlerOptions): AgentRouteHandler {
  const { agentStore } = options;

  return {
    async handle(url, method, request, corsHeaders): Promise<Response | null> {
      if (url.pathname === "/api/agents" && method === "GET") {
        try {
          const listResult = await agentStore.list();
          if (!listResult.ok) {
            return Response.json(
              { error: listResult.error.message },
              { status: 500, headers: withJsonHeaders(corsHeaders) },
            );
          }

          return Response.json(
            { agents: listResult.value },
            { headers: withJsonHeaders(corsHeaders) },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Internal server error";
          return Response.json({ error: message }, { status: 500, headers: withJsonHeaders(corsHeaders) });
        }
      }

      if (url.pathname === "/api/agents" && method === "POST") {
        try {
          const body = await parseJsonBody(request);
          const agent = validateCreateRequest(body);
          const createResult = await agentStore.create(agent);
          if (!createResult.ok) {
            return Response.json(
              { error: createResult.error.message },
              { status: 400, headers: withJsonHeaders(corsHeaders) },
            );
          }

          let createdAgent = createResult.value;

          // Generate default identity files when none were provided so every
          // agent has a populated workspace from the moment it is created.
          if (options.identityFileManager) {
            const hasFiles =
              createdAgent.identityFiles?.soul !== undefined ||
              createdAgent.identityFiles?.memory !== undefined ||
              createdAgent.identityFiles?.identity !== undefined;

            if (!hasFiles) {
              try {
                const generatedFiles = await options.identityFileManager.generateIdentityFiles(createdAgent);
                const updateResult = await agentStore.update(createdAgent.id, { identityFiles: generatedFiles });
                if (updateResult.ok) {
                  createdAgent = updateResult.value;
                }
              } catch {
                // Non-fatal: agent was created successfully; identity file
                // generation is best-effort and will not block the response.
              }
            }
          }

          return Response.json(
            { agent: createdAgent },
            { status: 201, headers: withJsonHeaders(corsHeaders) },
          );
        } catch (error) {
          const status = error instanceof BadRequestError ? 400 : 500;
          const message = error instanceof Error ? error.message : "Internal server error";
          return Response.json({ error: message }, { status, headers: withJsonHeaders(corsHeaders) });
        }
      }

      const agentId = parseAgentId(url.pathname);
      if (agentId !== null && method === "GET") {
        try {
          const getResult = await agentStore.get(agentId);
          if (!getResult.ok) {
            return Response.json(
              { error: getResult.error.message },
              { status: 500, headers: withJsonHeaders(corsHeaders) },
            );
          }

          if (getResult.value === null) {
            return Response.json(
              { error: `Agent not found: ${agentId}` },
              { status: 404, headers: withJsonHeaders(corsHeaders) },
            );
          }

          return Response.json(
            { agent: getResult.value },
            { headers: withJsonHeaders(corsHeaders) },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Internal server error";
          return Response.json({ error: message }, { status: 500, headers: withJsonHeaders(corsHeaders) });
        }
      }

      if (agentId !== null && method === "PUT") {
        try {
          const body = await parseJsonBody(request);
          const updates = validateUpdateRequest(body);
          const updateResult = await agentStore.update(agentId, updates);
          if (!updateResult.ok) {
            const status = updateResult.error.message.includes("not found") ? 404 : 400;
            return Response.json(
              { error: updateResult.error.message },
              { status, headers: withJsonHeaders(corsHeaders) },
            );
          }

          return Response.json(
            { agent: updateResult.value },
            { headers: withJsonHeaders(corsHeaders) },
          );
        } catch (error) {
          const status = error instanceof BadRequestError ? 400 : 500;
          const message = error instanceof Error ? error.message : "Internal server error";
          return Response.json({ error: message }, { status, headers: withJsonHeaders(corsHeaders) });
        }
      }

      if (agentId !== null && method === "DELETE") {
        try {
          const deleteResult = await agentStore.delete(agentId);
          if (!deleteResult.ok) {
            return Response.json(
              { error: deleteResult.error.message },
              { status: 500, headers: withJsonHeaders(corsHeaders) },
            );
          }

          if (!deleteResult.value) {
            return Response.json(
              { error: `Agent not found: ${agentId}` },
              { status: 404, headers: withJsonHeaders(corsHeaders) },
            );
          }

          return Response.json(
            { deleted: true, id: agentId },
            { headers: withJsonHeaders(corsHeaders) },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Internal server error";
          return Response.json({ error: message }, { status: 500, headers: withJsonHeaders(corsHeaders) });
        }
      }

      if (url.pathname.startsWith("/api/agents")) {
        return Response.json(
          { error: `Method ${method} not allowed on ${url.pathname}` },
          { status: 405, headers: withJsonHeaders(corsHeaders) },
        );
      }

      return null;
    },
  };
}

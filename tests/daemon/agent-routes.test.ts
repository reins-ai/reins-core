import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentStore } from "../../src/agents/store";
import { createAgentRouteHandler, type AgentRouteHandler } from "../../src/daemon/agent-routes";

let tempDir: string;
let store: AgentStore;
let handler: AgentRouteHandler;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "reins-agent-routes-"));
  store = new AgentStore({ filePath: join(tempDir, "agents.json") });
  handler = createAgentRouteHandler({ agentStore: store });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function sendRequest(
  routeHandler: AgentRouteHandler,
  path: string,
  method: string,
  body?: unknown,
): Promise<Response | null> {
  const url = new URL(`http://localhost:4242${path}`);
  const init: RequestInit = { method };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }

  const request = new Request(url, init);
  return routeHandler.handle(url, method, request, {});
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("AgentRouteHandler", () => {
  it("GET /api/agents returns an empty list by default", async () => {
    const response = await sendRequest(handler, "/api/agents", "GET");

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as { agents: unknown[] };
    expect(data.agents).toHaveLength(0);
  });

  it("POST /api/agents creates an agent", async () => {
    const response = await sendRequest(handler, "/api/agents", "POST", {
      id: "chief-of-staff",
      name: "Chief of Staff",
      role: "coordinator",
      workspacePath: "/tmp/reins/agents/chief-of-staff",
      skills: ["calendar", "notes"],
      identityFiles: { custom: {} },
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);

    const data = (await readJson(response!)) as { agent: { id: string; role: string } };
    expect(data.agent.id).toBe("chief-of-staff");
    expect(data.agent.role).toBe("coordinator");
  });

  it("GET /api/agents/:id returns a stored agent", async () => {
    await sendRequest(handler, "/api/agents", "POST", {
      id: "eleanor",
      name: "Eleanor",
      workspacePath: "/tmp/reins/agents/eleanor",
      skills: [],
      identityFiles: { custom: {} },
    });

    const response = await sendRequest(handler, "/api/agents/eleanor", "GET");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as { agent: { id: string; name: string } };
    expect(data.agent.id).toBe("eleanor");
    expect(data.agent.name).toBe("Eleanor");
  });

  it("DELETE /api/agents/:id removes an agent", async () => {
    await sendRequest(handler, "/api/agents", "POST", {
      id: "delete-me",
      name: "Delete Me",
      workspacePath: "/tmp/reins/agents/delete-me",
      skills: [],
      identityFiles: { custom: {} },
    });

    const response = await sendRequest(handler, "/api/agents/delete-me", "DELETE");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as { deleted: boolean; id: string };
    expect(data.deleted).toBe(true);
    expect(data.id).toBe("delete-me");

    const getResponse = await sendRequest(handler, "/api/agents/delete-me", "GET");
    expect(getResponse).not.toBeNull();
    expect(getResponse!.status).toBe(404);
  });
});

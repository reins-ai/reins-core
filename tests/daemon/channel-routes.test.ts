import { describe, expect, it } from "bun:test";

import type { ChannelPlatform } from "../../src/channels/types";
import {
  createChannelRouteHandler,
  type ChannelRouteHandler,
} from "../../src/daemon/channel-routes";
import type {
  ChannelDaemonService,
  ChannelHealthStatus,
  ChannelServiceStatusSnapshot,
} from "../../src/daemon/channel-service";
import { ChannelError } from "../../src/channels/errors";

function makeHealthStatus(
  overrides: Partial<ChannelHealthStatus> = {},
): ChannelHealthStatus {
  return {
    channelId: overrides.channelId ?? "ch-1",
    platform: overrides.platform ?? "telegram",
    enabled: overrides.enabled ?? true,
    state: overrides.state ?? "connected",
    uptimeMs: overrides.uptimeMs ?? 5000,
    healthy: overrides.healthy ?? true,
    checkedAt: overrides.checkedAt ?? "2026-02-19T00:00:00.000Z",
    ...overrides,
  };
}

function createMockChannelService(
  overrides: Partial<Record<keyof ChannelDaemonService, unknown>> = {},
): ChannelDaemonService {
  return {
    addChannel: async (
      platform: ChannelPlatform,
      _token: string,
      channelId?: string,
    ) =>
      makeHealthStatus({
        channelId: channelId ?? platform,
        platform,
      }),
    removeChannel: async () => true,
    enableChannel: async (channelId: string) =>
      makeHealthStatus({ channelId, enabled: true }),
    disableChannel: async (channelId: string) =>
      makeHealthStatus({ channelId, enabled: false, state: "disconnected" }),
    listChannels: () => [],
    testChannel: (channelId: string) => makeHealthStatus({ channelId }),
    getStatusSnapshot: (): ChannelServiceStatusSnapshot => ({
      channels: [],
      summary: { total: 0, enabled: 0, healthy: 0, unhealthy: 0 },
    }),
    ...overrides,
  } as unknown as ChannelDaemonService;
}

function createHandler(
  serviceOverrides: Partial<Record<keyof ChannelDaemonService, unknown>> = {},
): ChannelRouteHandler {
  return createChannelRouteHandler({
    channelService: createMockChannelService(serviceOverrides),
  });
}

async function sendRequest(
  handler: ChannelRouteHandler,
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
  return handler.handle(url, method, request, {});
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("ChannelRouteHandler", () => {
  // ── GET /channels ──────────────────────────────────────────────

  it("GET /channels returns channel list", async () => {
    const channels = [
      makeHealthStatus({ channelId: "tg-1", platform: "telegram" }),
      makeHealthStatus({ channelId: "dc-1", platform: "discord" }),
    ];
    const handler = createHandler({
      listChannels: () => channels,
    });

    const response = await sendRequest(handler, "/channels", "GET");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as { channels: ChannelHealthStatus[] };
    expect(data.channels).toHaveLength(2);
    expect(data.channels[0]!.channelId).toBe("tg-1");
    expect(data.channels[1]!.channelId).toBe("dc-1");
  });

  it("GET /channels returns empty list when no channels", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/channels", "GET");
    expect(response).not.toBeNull();

    const data = (await readJson(response!)) as { channels: ChannelHealthStatus[] };
    expect(data.channels).toHaveLength(0);
  });

  // ── GET /channels/status ───────────────────────────────────────

  it("GET /channels/status returns status snapshot", async () => {
    const snapshot: ChannelServiceStatusSnapshot = {
      channels: [makeHealthStatus()],
      summary: { total: 1, enabled: 1, healthy: 1, unhealthy: 0 },
    };
    const handler = createHandler({
      getStatusSnapshot: () => snapshot,
    });

    const response = await sendRequest(handler, "/channels/status", "GET");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as ChannelServiceStatusSnapshot;
    expect(data.summary.total).toBe(1);
    expect(data.summary.healthy).toBe(1);
    expect(data.channels).toHaveLength(1);
  });

  // ── POST /channels/add ─────────────────────────────────────────

  it("POST /channels/add creates channel and returns 201", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/channels/add", "POST", {
      platform: "telegram",
      token: "bot123:ABC",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);

    const data = (await readJson(response!)) as { channel: ChannelHealthStatus };
    expect(data.channel.platform).toBe("telegram");
  });

  it("POST /channels/add passes channelId to service", async () => {
    let capturedChannelId: string | undefined;
    const handler = createHandler({
      addChannel: async (
        platform: ChannelPlatform,
        _token: string,
        channelId?: string,
      ) => {
        capturedChannelId = channelId;
        return makeHealthStatus({ channelId: channelId ?? platform, platform });
      },
    });

    await sendRequest(handler, "/channels/add", "POST", {
      platform: "discord",
      token: "discord-token",
      channelId: "my-custom-id",
    });

    expect(capturedChannelId).toBe("my-custom-id");
  });

  it("POST /channels/add returns 400 on missing platform", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/channels/add", "POST", {
      token: "bot123",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("platform");
  });

  it("POST /channels/add returns 400 on invalid platform", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/channels/add", "POST", {
      platform: "whatsapp",
      token: "bot123",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("platform");
  });

  it("POST /channels/add returns 400 on missing token", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/channels/add", "POST", {
      platform: "telegram",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("token");
  });

  it("POST /channels/add returns 400 on empty body", async () => {
    const handler = createHandler();
    const url = new URL("http://localhost:4242/channels/add");
    const request = new Request(url, {
      method: "POST",
      body: "",
      headers: { "content-type": "application/json" },
    });

    const response = await handler.handle(url, "POST", request, {});
    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
  });

  // ── POST /channels/remove ──────────────────────────────────────

  it("POST /channels/remove removes existing channel", async () => {
    const handler = createHandler({
      removeChannel: async () => true,
    });

    const response = await sendRequest(handler, "/channels/remove", "POST", {
      channelId: "ch-1",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as { removed: boolean; channelId: string };
    expect(data.removed).toBe(true);
    expect(data.channelId).toBe("ch-1");
  });

  it("POST /channels/remove returns 404 when channel not found", async () => {
    const handler = createHandler({
      removeChannel: async () => false,
    });

    const response = await sendRequest(handler, "/channels/remove", "POST", {
      channelId: "nonexistent",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("nonexistent");
  });

  it("POST /channels/remove returns 400 on missing channelId", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/channels/remove", "POST", {});

    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("channelId");
  });

  // ── DELETE /channels/:id ─────────────────────────────────────────

  it("DELETE /channels/:id removes existing channel", async () => {
    const handler = createHandler({
      removeChannel: async () => true,
    });

    const response = await sendRequest(handler, "/channels/ch-1", "DELETE");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as { removed: boolean; channelId: string };
    expect(data.removed).toBe(true);
    expect(data.channelId).toBe("ch-1");
  });

  it("DELETE /channels/:id returns 404 when channel not found", async () => {
    const handler = createHandler({
      removeChannel: async () => false,
    });

    const response = await sendRequest(handler, "/channels/nonexistent", "DELETE");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("nonexistent");
  });

  // ── POST /channels/:id/test ────────────────────────────────────

  it("POST /channels/:id/test returns health status", async () => {
    const handler = createHandler({
      testChannel: (channelId: string) => makeHealthStatus({ channelId }),
    });

    const response = await sendRequest(handler, "/channels/ch-1/test", "POST");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as { channel: ChannelHealthStatus };
    expect(data.channel.channelId).toBe("ch-1");
  });

  it("POST /channels/:id/test returns 404 when channel not found", async () => {
    const handler = createHandler({
      testChannel: () => {
        throw new ChannelError("Channel not found: missing");
      },
    });

    const response = await sendRequest(handler, "/channels/missing/test", "POST");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("not found");
  });

  // ── POST /channels/enable ──────────────────────────────────────

  it("POST /channels/enable enables a channel", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/channels/enable", "POST", {
      channelId: "ch-1",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as { channel: ChannelHealthStatus };
    expect(data.channel.channelId).toBe("ch-1");
    expect(data.channel.enabled).toBe(true);
  });

  it("POST /channels/enable returns 404 when not found", async () => {
    const handler = createHandler({
      enableChannel: async () => {
        throw new ChannelError("Channel not found: missing");
      },
    });

    const response = await sendRequest(handler, "/channels/enable", "POST", {
      channelId: "missing",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("not found");
  });

  // ── POST /channels/disable ─────────────────────────────────────

  it("POST /channels/disable disables a channel", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/channels/disable", "POST", {
      channelId: "ch-1",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as { channel: ChannelHealthStatus };
    expect(data.channel.channelId).toBe("ch-1");
    expect(data.channel.enabled).toBe(false);
  });

  it("POST /channels/disable returns 404 when not found", async () => {
    const handler = createHandler({
      disableChannel: async () => {
        throw new ChannelError("Channel not found: gone");
      },
    });

    const response = await sendRequest(handler, "/channels/disable", "POST", {
      channelId: "gone",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("not found");
  });

  // ── Unknown routes ─────────────────────────────────────────────

  it("returns 405 for unknown channel methods", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/channels/unknown", "POST", {});

    expect(response).not.toBeNull();
    expect(response!.status).toBe(405);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("not allowed");
  });

  it("returns 405 for DELETE on /channels", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/channels", "DELETE");

    expect(response).not.toBeNull();
    expect(response!.status).toBe(405);
  });

  it("returns null for non-channel routes", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/health", "GET");

    expect(response).toBeNull();
  });

  it("returns null for unrelated paths", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/conversations", "GET");

    expect(response).toBeNull();
  });

  // ── Lifecycle integration ──────────────────────────────────────

  it("full lifecycle: add, status, remove returns consistent state", async () => {
    let channelStore: ChannelHealthStatus[] = [];

    const service = createMockChannelService({
      addChannel: async (
        platform: ChannelPlatform,
        _token: string,
        channelId?: string,
      ) => {
        const status = makeHealthStatus({
          channelId: channelId ?? platform,
          platform,
        });
        channelStore.push(status);
        return status;
      },
      listChannels: () => channelStore,
      getStatusSnapshot: (): ChannelServiceStatusSnapshot => ({
        channels: channelStore,
        summary: {
          total: channelStore.length,
          enabled: channelStore.filter((c) => c.enabled).length,
          healthy: channelStore.filter((c) => c.healthy).length,
          unhealthy: channelStore.filter((c) => c.enabled && !c.healthy).length,
        },
      }),
      removeChannel: async (channelId: string) => {
        const before = channelStore.length;
        channelStore = channelStore.filter((c) => c.channelId !== channelId);
        return channelStore.length < before;
      },
    });

    const handler = createChannelRouteHandler({ channelService: service });

    // Step 1: Add a channel
    const addResponse = await sendRequest(handler, "/channels/add", "POST", {
      platform: "telegram",
      token: "bot-token-123",
    });
    expect(addResponse!.status).toBe(201);

    // Step 2: Check status — should show 1 channel
    const statusResponse = await sendRequest(handler, "/channels/status", "GET");
    const statusData = (await readJson(statusResponse!)) as ChannelServiceStatusSnapshot;
    expect(statusData.summary.total).toBe(1);
    expect(statusData.channels[0]!.platform).toBe("telegram");

    // Step 3: List channels — should show 1
    const listResponse = await sendRequest(handler, "/channels", "GET");
    const listData = (await readJson(listResponse!)) as { channels: ChannelHealthStatus[] };
    expect(listData.channels).toHaveLength(1);

    // Step 4: Remove the channel
    const removeResponse = await sendRequest(handler, "/channels/remove", "POST", {
      channelId: "telegram",
    });
    expect(removeResponse!.status).toBe(200);

    // Step 5: Status should now be empty
    const finalStatus = await sendRequest(handler, "/channels/status", "GET");
    const finalData = (await readJson(finalStatus!)) as ChannelServiceStatusSnapshot;
    expect(finalData.summary.total).toBe(0);
    expect(finalData.channels).toHaveLength(0);
  });

  it("add then enable/disable cycle works correctly", async () => {
    let enabled = true;

    const service = createMockChannelService({
      enableChannel: async (channelId: string) => {
        enabled = true;
        return makeHealthStatus({ channelId, enabled: true });
      },
      disableChannel: async (channelId: string) => {
        enabled = false;
        return makeHealthStatus({
          channelId,
          enabled: false,
          state: "disconnected",
        });
      },
      getStatusSnapshot: (): ChannelServiceStatusSnapshot => ({
        channels: [
          makeHealthStatus({
            channelId: "ch-1",
            enabled,
            state: enabled ? "connected" : "disconnected",
          }),
        ],
        summary: {
          total: 1,
          enabled: enabled ? 1 : 0,
          healthy: enabled ? 1 : 0,
          unhealthy: 0,
        },
      }),
    });

    const handler = createChannelRouteHandler({ channelService: service });

    // Disable
    const disableRes = await sendRequest(handler, "/channels/disable", "POST", {
      channelId: "ch-1",
    });
    expect(disableRes!.status).toBe(200);
    const disableData = (await readJson(disableRes!)) as { channel: ChannelHealthStatus };
    expect(disableData.channel.enabled).toBe(false);

    // Status reflects disabled
    const statusRes = await sendRequest(handler, "/channels/status", "GET");
    const statusData = (await readJson(statusRes!)) as ChannelServiceStatusSnapshot;
    expect(statusData.summary.enabled).toBe(0);

    // Re-enable
    const enableRes = await sendRequest(handler, "/channels/enable", "POST", {
      channelId: "ch-1",
    });
    expect(enableRes!.status).toBe(200);
    const enableData = (await readJson(enableRes!)) as { channel: ChannelHealthStatus };
    expect(enableData.channel.enabled).toBe(true);
  });

  // ── Content-Type header ────────────────────────────────────────

  it("responses include Content-Type application/json header", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/channels", "GET");

    expect(response).not.toBeNull();
    expect(response!.headers.get("content-type")).toBe("application/json");
  });
});

import { ChannelError, type ChannelPlatform } from "../channels";
import type { ChannelDaemonService } from "./channel-service";

export interface ChannelRouteHandler {
  handle(
    url: URL,
    method: string,
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response | null>;
}

export interface ChannelRouteHandlerOptions {
  channelService: ChannelDaemonService;
}

interface AddChannelRequest {
  platform: ChannelPlatform;
  token: string;
  channelId?: string;
}

interface ChannelIdRequest {
  channelId: string;
}

function isChannelPlatform(value: unknown): value is ChannelPlatform {
  return value === "telegram" || value === "discord";
}

function withJsonHeaders(headers: Record<string, string>): Headers {
  return new Headers({
    ...headers,
    "Content-Type": "application/json",
  });
}

async function parseJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) {
    throw new ChannelError("Request body is required");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ChannelError("Invalid JSON in request body");
  }
}

function validateAddChannelRequest(body: unknown): AddChannelRequest {
  if (typeof body !== "object" || body === null) {
    throw new ChannelError("Request body must be an object");
  }

  const data = body as Partial<AddChannelRequest>;
  if (!isChannelPlatform(data.platform)) {
    throw new ChannelError("platform must be 'telegram' or 'discord'");
  }

  if (typeof data.token !== "string" || data.token.trim().length === 0) {
    throw new ChannelError("token is required");
  }

  if (typeof data.channelId !== "undefined" && (typeof data.channelId !== "string" || data.channelId.trim().length === 0)) {
    throw new ChannelError("channelId must be a non-empty string when provided");
  }

  return {
    platform: data.platform,
    token: data.token,
    channelId: data.channelId,
  };
}

function validateChannelIdRequest(body: unknown): ChannelIdRequest {
  if (typeof body !== "object" || body === null) {
    throw new ChannelError("Request body must be an object");
  }

  const data = body as Partial<ChannelIdRequest>;
  if (typeof data.channelId !== "string" || data.channelId.trim().length === 0) {
    throw new ChannelError("channelId is required");
  }

  return {
    channelId: data.channelId,
  };
}

/**
 * Build route handlers for daemon channel-management API endpoints.
 */
export function createChannelRouteHandler(options: ChannelRouteHandlerOptions): ChannelRouteHandler {
  const { channelService } = options;

  return {
    /**
     * Resolve and execute channel route handlers.
     */
    async handle(url, method, request, corsHeaders): Promise<Response | null> {
      if (url.pathname === "/channels" && method === "GET") {
        return Response.json(
          {
            channels: channelService.listChannels(),
          },
          { headers: withJsonHeaders(corsHeaders) },
        );
      }

      if (url.pathname === "/channels/status" && method === "GET") {
        return Response.json(channelService.getStatusSnapshot(), {
          headers: withJsonHeaders(corsHeaders),
        });
      }

      if (url.pathname === "/channels/add" && method === "POST") {
        try {
          const body = await parseJsonBody(request);
          const payload = validateAddChannelRequest(body);
          const status = await channelService.addChannel(payload.platform, payload.token, payload.channelId);
          return Response.json({ channel: status }, { status: 201, headers: withJsonHeaders(corsHeaders) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          return Response.json({ error: message }, { status: 400, headers: withJsonHeaders(corsHeaders) });
        }
      }

      if (url.pathname === "/channels/remove" && method === "POST") {
        try {
          const body = await parseJsonBody(request);
          const payload = validateChannelIdRequest(body);
          const removed = await channelService.removeChannel(payload.channelId);
          if (!removed) {
            return Response.json(
              { error: `Channel not found: ${payload.channelId}` },
              { status: 404, headers: withJsonHeaders(corsHeaders) },
            );
          }

          return Response.json(
            { removed: true, channelId: payload.channelId },
            { headers: withJsonHeaders(corsHeaders) },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          return Response.json({ error: message }, { status: 400, headers: withJsonHeaders(corsHeaders) });
        }
      }

      if (url.pathname === "/channels/enable" && method === "POST") {
        try {
          const body = await parseJsonBody(request);
          const payload = validateChannelIdRequest(body);
          const channel = await channelService.enableChannel(payload.channelId);
          return Response.json({ channel }, { headers: withJsonHeaders(corsHeaders) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          const status = message.includes("not found") ? 404 : 400;
          return Response.json({ error: message }, { status, headers: withJsonHeaders(corsHeaders) });
        }
      }

      if (url.pathname === "/channels/disable" && method === "POST") {
        try {
          const body = await parseJsonBody(request);
          const payload = validateChannelIdRequest(body);
          const channel = await channelService.disableChannel(payload.channelId);
          return Response.json({ channel }, { headers: withJsonHeaders(corsHeaders) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          const status = message.includes("not found") ? 404 : 400;
          return Response.json({ error: message }, { status, headers: withJsonHeaders(corsHeaders) });
        }
      }

      if (url.pathname.startsWith("/channels")) {
        return Response.json(
          { error: `Method ${method} not allowed on ${url.pathname}` },
          { status: 405, headers: withJsonHeaders(corsHeaders) },
        );
      }

      return null;
    },
  };
}

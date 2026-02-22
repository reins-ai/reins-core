import { ChannelError } from "../channels";
import type { ChannelAuthService } from "../channels";

export interface AuthRouteHandler {
  handle(
    url: URL,
    method: string,
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response | null>;
}

export interface AuthRouteHandlerOptions {
  authService: ChannelAuthService;
}

interface AddUserRequest {
  channelId: string;
  userId: string;
}

interface RemoveUserRequest {
  channelId: string;
  userId: string;
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

function validateAddUserRequest(body: unknown): AddUserRequest {
  if (typeof body !== "object" || body === null) {
    throw new ChannelError("Request body must be an object");
  }

  const data = body as Partial<AddUserRequest>;

  if (
    typeof data.channelId !== "string"
    || data.channelId.trim().length === 0
  ) {
    throw new ChannelError("channelId is required");
  }

  if (
    typeof data.userId !== "string"
    || data.userId.trim().length === 0
  ) {
    throw new ChannelError("userId is required");
  }

  return { channelId: data.channelId, userId: data.userId };
}

function validateRemoveUserRequest(body: unknown): RemoveUserRequest {
  if (typeof body !== "object" || body === null) {
    throw new ChannelError("Request body must be an object");
  }

  const data = body as Partial<RemoveUserRequest>;

  if (
    typeof data.channelId !== "string"
    || data.channelId.trim().length === 0
  ) {
    throw new ChannelError("channelId is required");
  }

  if (
    typeof data.userId !== "string"
    || data.userId.trim().length === 0
  ) {
    throw new ChannelError("userId is required");
  }

  return { channelId: data.channelId, userId: data.userId };
}

/**
 * Build route handlers for daemon channel-auth management API endpoints.
 */
export function createAuthRouteHandler(
  options: AuthRouteHandlerOptions,
): AuthRouteHandler {
  const { authService } = options;

  return {
    async handle(
      url: URL,
      method: string,
      request: Request,
      corsHeaders: Record<string, string>,
    ): Promise<Response | null> {
      if (!url.pathname.startsWith("/auth")) {
        return null;
      }

      // POST /auth/add
      if (url.pathname === "/auth/add" && method === "POST") {
        try {
          const body = await parseJsonBody(request);
          const payload = validateAddUserRequest(body);
          await authService.addUser(
            payload.channelId,
            payload.userId,
          );
          return Response.json(
            {
              ok: true,
              channelId: payload.channelId,
              userId: payload.userId,
            },
            { headers: withJsonHeaders(corsHeaders) },
          );
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : "Invalid request";
          return Response.json(
            { error: message },
            { status: 400, headers: withJsonHeaders(corsHeaders) },
          );
        }
      }

      // POST /auth/remove
      if (url.pathname === "/auth/remove" && method === "POST") {
        try {
          const body = await parseJsonBody(request);
          const payload = validateRemoveUserRequest(body);
          const removed = await authService.removeUser(
            payload.channelId,
            payload.userId,
          );
          if (!removed) {
            return Response.json(
              {
                error: `User ${payload.userId} not found`
                  + ` in channel ${payload.channelId}`,
              },
              {
                status: 404,
                headers: withJsonHeaders(corsHeaders),
              },
            );
          }
          return Response.json(
            { ok: true, removed: true },
            { headers: withJsonHeaders(corsHeaders) },
          );
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : "Invalid request";
          return Response.json(
            { error: message },
            { status: 400, headers: withJsonHeaders(corsHeaders) },
          );
        }
      }

      // GET /auth/list?channelId=<id> or GET /auth/list (all)
      if (url.pathname === "/auth/list" && method === "GET") {
        try {
          const channelId = url.searchParams.get("channelId");

          if (channelId) {
            const users = await authService.listUsers(channelId);
            return Response.json(
              { channelId, users },
              { headers: withJsonHeaders(corsHeaders) },
            );
          }

          // No channelId param — return all channels
          const channels = await authService.getAllChannelsData();
          return Response.json(
            { channels },
            { headers: withJsonHeaders(corsHeaders) },
          );
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : "Invalid request";
          return Response.json(
            { error: message },
            { status: 400, headers: withJsonHeaders(corsHeaders) },
          );
        }
      }

      if (url.pathname.startsWith("/auth")) {
        return Response.json(
          {
            error: `Method ${method} not allowed`
              + ` on ${url.pathname}`,
          },
          { status: 405, headers: withJsonHeaders(corsHeaders) },
        );
      }

      return null;
    },
  };
}

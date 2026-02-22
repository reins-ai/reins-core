import { ALL_CONVERSION_CATEGORIES, type ConversionCategory } from "../agents/types";
import { OpenClawDetector } from "../conversion/detector";
import type { ProgressEmitter } from "../conversion/progress";
import type { ReportGenerator } from "../conversion/report";
import type { ConversionService } from "../conversion/service";
import type {
  ConflictInfo,
  ConversionProgressEvent,
  ConversionResult,
  DetectionResult,
} from "../conversion/types";
import type { StreamRegistrySocketData, WsStreamRegistry } from "./ws-stream-registry";

/**
 * Fixed stream target for conversion progress events.
 * Clients subscribe to this target via WsStreamRegistry to receive
 * real-time conversion progress updates.
 */
export const CONVERSION_PROGRESS_STREAM = {
  conversationId: "conversion",
  assistantMessageId: "progress",
} as const;

/** Client → daemon: subscribe to conversion progress */
export interface ConversionSubscribeMessage {
  type: "conversion.subscribe";
}

/** Client → daemon: unsubscribe from conversion progress */
export interface ConversionUnsubscribeMessage {
  type: "conversion.unsubscribe";
}

/** daemon → client: conversion progress event envelope */
export interface ConversionProgressEnvelope {
  type: "conversion-progress";
  event: ConversionProgressEvent;
  timestamp: string;
}

export type ConversionWebSocketInboundMessage =
  | ConversionSubscribeMessage
  | ConversionUnsubscribeMessage;

export function isConversionWebSocketMessage(
  payload: unknown,
): payload is ConversionWebSocketInboundMessage {
  if (typeof payload !== "object" || payload === null) return false;
  const msg = payload as { type?: unknown };
  return msg.type === "conversion.subscribe" || msg.type === "conversion.unsubscribe";
}

export interface ConversionRouteHandler {
  handle(
    url: URL,
    method: string,
    request: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response | null>;
}

export interface ConversionRouteHandlerOptions {
  conversionService: ConversionService;
  reportGenerator: ReportGenerator;
  detector?: OpenClawDetector;
  progressEmitter?: ProgressEmitter;
  wsRegistry?: WsStreamRegistry<StreamRegistrySocketData>;
}

interface StartConversionRequest {
  selectedCategories: ConversionCategory[];
  conflictStrategy?: "overwrite" | "merge" | "skip";
  dryRun?: boolean;
}

interface ResolveConflictRequest {
  strategy: "overwrite" | "merge" | "skip";
}

type ConversionStatus = "idle" | "running" | "complete" | "error" | "conflict";

interface PendingConflict {
  id: string;
  conflict: ConflictInfo;
  resolve: (resolution: "overwrite" | "merge" | "skip") => void;
}

interface ConflictStatusPayload {
  id: string;
  type: "agent" | "provider" | "channel";
  description: string;
  strategies: Array<"overwrite" | "merge" | "skip">;
}

const VALID_CONFLICT_STRATEGIES = new Set(["overwrite", "merge", "skip"]);

function withJsonHeaders(headers: Record<string, string>): Headers {
  return new Headers({
    ...headers,
    "Content-Type": "application/json",
  });
}

async function parseJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) {
    throw new Error("Request body is required");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Invalid JSON in request body");
  }
}

function isConversionCategory(value: unknown): value is ConversionCategory {
  return typeof value === "string" && ALL_CONVERSION_CATEGORIES.includes(value as ConversionCategory);
}

function validateStartRequest(body: unknown): StartConversionRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("Request body must be an object");
  }

  const data = body as Partial<StartConversionRequest>;

  if (!Array.isArray(data.selectedCategories) || data.selectedCategories.length === 0) {
    throw new Error("selectedCategories must be a non-empty array");
  }

  for (const category of data.selectedCategories) {
    if (!isConversionCategory(category)) {
      throw new Error(`Invalid category: ${String(category)}`);
    }
  }

  if (
    data.conflictStrategy !== undefined &&
    !VALID_CONFLICT_STRATEGIES.has(data.conflictStrategy)
  ) {
    throw new Error("conflictStrategy must be 'overwrite', 'merge', or 'skip'");
  }

  if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") {
    throw new Error("dryRun must be a boolean");
  }

  return {
    selectedCategories: data.selectedCategories,
    conflictStrategy: data.conflictStrategy,
    dryRun: data.dryRun,
  };
}

function validateResolveConflictRequest(body: unknown): ResolveConflictRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("Request body must be an object");
  }

  const data = body as Partial<ResolveConflictRequest>;

  if (typeof data.strategy !== "string" || !VALID_CONFLICT_STRATEGIES.has(data.strategy)) {
    throw new Error("strategy must be 'overwrite', 'merge', or 'skip'");
  }

  return {
    strategy: data.strategy,
  };
}

function toConflictType(category: ConflictInfo["category"]): "agent" | "provider" | "channel" {
  switch (category) {
    case "agents":
      return "agent";
    case "channel-credentials":
      return "channel";
    default:
      return "provider";
  }
}

function toConflictDescription(conflict: ConflictInfo): string {
  const type = toConflictType(conflict.category);
  if (type === "agent") {
    return `Agent '${conflict.itemName}' already exists`;
  }
  if (type === "channel") {
    return `Channel '${conflict.itemName}' already exists`;
  }
  return `Provider credentials for '${conflict.itemName}' already exist`;
}

function toConflictStatusPayload(conflict: PendingConflict): ConflictStatusPayload {
  return {
    id: conflict.id,
    type: toConflictType(conflict.conflict.category),
    description: toConflictDescription(conflict.conflict),
    strategies: ["overwrite", "merge", "skip"],
  };
}

/**
 * Build route handlers for daemon conversion API endpoints.
 *
 * Manages async conversion lifecycle: start, status polling, conflict
 * resolution, and report retrieval.
 */
export function createConversionRouteHandler(
  options: ConversionRouteHandlerOptions,
): ConversionRouteHandler {
  const { conversionService, reportGenerator } = options;
  const detector = options.detector ?? new OpenClawDetector();

  let cachedDetectionResult: DetectionResult | null = null;
  let currentConversionId: string | null = null;
  let conversionStatus: ConversionStatus = "idle";
  let conversionResult: ConversionResult | null = null;
  let conversionError: string | null = null;
  let conversionStartedAt: string | null = null;
  let pendingConflict: PendingConflict | null = null;

  if (options.progressEmitter && options.wsRegistry) {
    const registry = options.wsRegistry;
    options.progressEmitter.on((event) => {
      const envelope: ConversionProgressEnvelope = {
        type: "conversion-progress",
        event,
        timestamp: new Date().toISOString(),
      };
      registry.publish(CONVERSION_PROGRESS_STREAM, envelope);
    });
  }

  return {
    async handle(url, method, request, corsHeaders): Promise<Response | null> {
      // POST /api/convert/start
      if (url.pathname === "/api/convert/start" && method === "POST") {
        try {
          const body = await parseJsonBody(request);
          const payload = validateStartRequest(body);

          if (conversionStatus === "running" || conversionStatus === "conflict") {
            return Response.json(
              { error: "A conversion is already running" },
              { status: 409, headers: withJsonHeaders(corsHeaders) },
            );
          }

          const conversionId = crypto.randomUUID();
          currentConversionId = conversionId;
          conversionStatus = "running";
          conversionResult = null;
          conversionError = null;
          conversionStartedAt = new Date().toISOString();
          pendingConflict = null;

          // Start conversion asynchronously — do NOT await
          conversionService
            .convert({
              selectedCategories: payload.selectedCategories,
              conflictStrategy: payload.conflictStrategy,
              dryRun: payload.dryRun,
              onConflict: (_conflict) => {
                const conflictId = crypto.randomUUID();
                return new Promise<"overwrite" | "merge" | "skip">((resolve) => {
                  pendingConflict = {
                    id: conflictId,
                    conflict: _conflict,
                    resolve,
                  };
                  conversionStatus = "conflict";
                });
              },
            })
            .then((result) => {
              if (result.ok) {
                reportGenerator
                  .generate(result.value)
                  .then((reportResult) => {
                    if (!reportResult.ok) {
                      conversionError = reportResult.error.message;
                      conversionStatus = "error";
                      return;
                    }

                    conversionResult = {
                      ...result.value,
                      reportPath: reportResult.value,
                    };
                    pendingConflict = null;
                    conversionStatus = "complete";
                  })
                  .catch((error: unknown) => {
                    conversionError = error instanceof Error ? error.message : String(error);
                    pendingConflict = null;
                    conversionStatus = "error";
                  });
              } else {
                conversionError = result.error.message;
                pendingConflict = null;
                conversionStatus = "error";
              }
            })
            .catch((error: unknown) => {
              conversionError = error instanceof Error ? error.message : String(error);
              pendingConflict = null;
              conversionStatus = "error";
            });

          return Response.json(
            {
              conversionId,
              status: "started",
              startedAt: conversionStartedAt,
            },
            { status: 201, headers: withJsonHeaders(corsHeaders) },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          return Response.json(
            { error: message },
            { status: 400, headers: withJsonHeaders(corsHeaders) },
          );
        }
      }

      // GET /api/convert/status
      if (url.pathname === "/api/convert/status" && method === "GET") {
        const effectiveStatus: ConversionStatus = pendingConflict ? "conflict" : conversionStatus;
        const response: Record<string, unknown> = {
          status: effectiveStatus,
        };

        if (currentConversionId !== null) {
          response.conversionId = currentConversionId;
        }

        if (conversionStartedAt !== null) {
          response.startedAt = conversionStartedAt;
        }

        if (conversionResult !== null) {
          response.result = conversionResult;
        }

        if (conversionError !== null) {
          response.error = conversionError;
        }

        if (pendingConflict !== null) {
          response.conflict = toConflictStatusPayload(pendingConflict);
        }

        return Response.json(response, {
          headers: withJsonHeaders(corsHeaders),
        });
      }

      // POST /api/convert/resolve-conflict
      if (url.pathname === "/api/convert/resolve-conflict" && method === "POST") {
        try {
          const body = await parseJsonBody(request);
          const payload = validateResolveConflictRequest(body);

          if (!pendingConflict) {
            return Response.json(
              { error: "No pending conflict found" },
              { status: 404, headers: withJsonHeaders(corsHeaders) },
            );
          }

          pendingConflict.resolve(payload.strategy);
          pendingConflict = null;
          conversionStatus = "running";

          return Response.json(
            { resolved: true },
            { headers: withJsonHeaders(corsHeaders) },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          return Response.json(
            { error: message },
            { status: 400, headers: withJsonHeaders(corsHeaders) },
          );
        }
      }

      // GET /api/convert/report
      if (url.pathname === "/api/convert/report" && method === "GET") {
        const path = conversionResult?.reportPath ?? reportGenerator.getLastReportPath();
        if (!path) {
          return Response.json(
            { error: "No conversion report found" },
            { status: 404, headers: withJsonHeaders(corsHeaders) },
          );
        }

        const file = Bun.file(path);
        if (!(await file.exists())) {
          return Response.json(
            { error: "No conversion report found" },
            { status: 404, headers: withJsonHeaders(corsHeaders) },
          );
        }

        const report = await file.text();

        return Response.json(
          { report, path },
          { headers: withJsonHeaders(corsHeaders) },
        );
      }

      // GET /api/openclaw/detect
      if (url.pathname === "/api/openclaw/detect" && method === "GET") {
        if (!cachedDetectionResult) {
          cachedDetectionResult = await detector.detect();
        }
        return Response.json(cachedDetectionResult, { headers: withJsonHeaders(corsHeaders) });
      }

      // 405 for unmatched /api/convert/* paths
      if (url.pathname.startsWith("/api/convert")) {
        return Response.json(
          { error: `Method ${method} not allowed on ${url.pathname}` },
          { status: 405, headers: withJsonHeaders(corsHeaders) },
        );
      }

      return null;
    },
  };
}

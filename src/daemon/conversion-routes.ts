import { ALL_CONVERSION_CATEGORIES, type ConversionCategory } from "../agents/types";
import { OpenClawDetector } from "../conversion/detector";
import type { ReportGenerator } from "../conversion/report";
import type { ConversionService } from "../conversion/service";
import type { ConversionResult, DetectionResult } from "../conversion/types";

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
}

interface StartConversionRequest {
  selectedCategories: ConversionCategory[];
  conflictStrategy?: "overwrite" | "merge" | "skip";
  dryRun?: boolean;
}

interface ResolveConflictRequest {
  conflictId: string;
  resolution: "overwrite" | "merge" | "skip";
}

type ConversionStatus = "idle" | "running" | "complete" | "error";

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

  if (typeof data.conflictId !== "string" || data.conflictId.trim().length === 0) {
    throw new Error("conflictId is required");
  }

  if (typeof data.resolution !== "string" || !VALID_CONFLICT_STRATEGIES.has(data.resolution)) {
    throw new Error("resolution must be 'overwrite', 'merge', or 'skip'");
  }

  return {
    conflictId: data.conflictId,
    resolution: data.resolution!,
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
  const pendingConflicts = new Map<
    string,
    (resolution: "overwrite" | "merge" | "skip") => void
  >();

  return {
    async handle(url, method, request, corsHeaders): Promise<Response | null> {
      // POST /api/convert/start
      if (url.pathname === "/api/convert/start" && method === "POST") {
        try {
          const body = await parseJsonBody(request);
          const payload = validateStartRequest(body);

          if (conversionStatus === "running") {
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

          // Start conversion asynchronously — do NOT await
          conversionService
            .convert({
              selectedCategories: payload.selectedCategories,
              conflictStrategy: payload.conflictStrategy,
              dryRun: payload.dryRun,
              onConflict: (_conflict) => {
                const conflictId = crypto.randomUUID();
                return new Promise<"overwrite" | "merge" | "skip">((resolve) => {
                  pendingConflicts.set(conflictId, resolve);
                });
              },
            })
            .then((result) => {
              if (result.ok) {
                conversionResult = result.value;
                conversionStatus = "complete";
              } else {
                conversionError = result.error.message;
                conversionStatus = "error";
              }
            })
            .catch((error: unknown) => {
              conversionError = error instanceof Error ? error.message : String(error);
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
        const response: Record<string, unknown> = {
          status: conversionStatus,
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

        if (pendingConflicts.size > 0) {
          response.pendingConflicts = pendingConflicts.size;
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

          const resolver = pendingConflicts.get(payload.conflictId);
          if (!resolver) {
            return Response.json(
              { error: `Conflict not found: ${payload.conflictId}` },
              { status: 404, headers: withJsonHeaders(corsHeaders) },
            );
          }

          resolver(payload.resolution);
          pendingConflicts.delete(payload.conflictId);

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
        const reportResult = await reportGenerator.readLastReport();

        if (!reportResult.ok) {
          return Response.json(
            { error: "No conversion report found" },
            { status: 404, headers: withJsonHeaders(corsHeaders) },
          );
        }

        const path = reportGenerator.getLastReportPath();

        return Response.json(
          { report: reportResult.value, path },
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

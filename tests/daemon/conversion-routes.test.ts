import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONVERSION_PROGRESS_STREAM,
  createConversionRouteHandler,
  isConversionWebSocketMessage,
  type ConversionRouteHandler,
} from "../../src/daemon/conversion-routes";
import type { ConversionService } from "../../src/conversion/service";
import type { ReportGenerator } from "../../src/conversion/report";
import type {
  ConflictInfo,
  ConversionProgressEvent,
  ConversionResult,
  DetectionResult,
} from "../../src/conversion/types";
import type { OpenClawDetector } from "../../src/conversion/detector";
import type { ProgressEmitter } from "../../src/conversion/progress";
import type { StreamRegistrySocketData, WsStreamRegistry } from "../../src/daemon/ws-stream-registry";
import { ok, err } from "../../src/result";
import { ReinsError } from "../../src/errors";

function makeConversionResult(
  overrides: Partial<ConversionResult> = {},
): ConversionResult {
  return {
    success: true,
    categories: [],
    totalConverted: 5,
    totalSkipped: 0,
    totalErrors: 0,
    elapsedMs: 1200,
    ...overrides,
  };
}

function createMockConversionService(
  overrides: Partial<Record<string, unknown>> = {},
): ConversionService {
  return {
    start: async () => {},
    stop: async () => {},
    isRunning: () => false,
    convert: async () => ok(makeConversionResult()),
    ...overrides,
  } as unknown as ConversionService;
}

function createMockReportGenerator(
  overrides: Partial<Record<string, unknown>> = {},
): ReportGenerator {
  return {
    generate: async () => ok("/tmp/report.md"),
    getLastReportPath: () => null,
    readLastReport: async () =>
      err(new ReinsError("No conversion report has been generated", "REPORT_ERROR")),
    render: () => "# Report",
    ...overrides,
  } as unknown as ReportGenerator;
}

function createMockDetector(
  result: DetectionResult = { found: true, path: "/home/user/.openclaw", platform: "linux" },
): OpenClawDetector {
  return {
    detect: async () => result,
  } as unknown as OpenClawDetector;
}

function createHandler(
  serviceOverrides: Partial<Record<string, unknown>> = {},
  reportOverrides: Partial<Record<string, unknown>> = {},
  detector?: OpenClawDetector,
): ConversionRouteHandler {
  return createConversionRouteHandler({
    conversionService: createMockConversionService(serviceOverrides),
    reportGenerator: createMockReportGenerator(reportOverrides),
    detector,
  });
}

async function sendRequest(
  handler: ConversionRouteHandler,
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

describe("ConversionRouteHandler", () => {
  // ── POST /api/convert/start ──────────────────────────────────

  it("POST /api/convert/start returns 201 with conversionId", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/api/convert/start", "POST", {
      selectedCategories: ["agents", "skills"],
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);

    const data = (await readJson(response!)) as {
      conversionId: string;
      status: string;
      startedAt: string;
    };
    expect(data.conversionId).toBeDefined();
    expect(typeof data.conversionId).toBe("string");
    expect(data.conversionId.length).toBeGreaterThan(0);
    expect(data.status).toBe("started");
    expect(data.startedAt).toBeDefined();
  });

  it("POST /api/convert/start accepts optional conflictStrategy and dryRun", async () => {
    let capturedOptions: Record<string, unknown> | null = null;
    const handler = createHandler({
      convert: async (options: Record<string, unknown>) => {
        capturedOptions = options;
        return ok(makeConversionResult());
      },
    });

    const response = await sendRequest(handler, "/api/convert/start", "POST", {
      selectedCategories: ["agents"],
      conflictStrategy: "merge",
      dryRun: true,
    });

    expect(response!.status).toBe(201);
    // Allow async convert to be called
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions!.conflictStrategy).toBe("merge");
    expect(capturedOptions!.dryRun).toBe(true);
  });

  it("POST /api/convert/start returns 400 on missing body", async () => {
    const handler = createHandler();
    const url = new URL("http://localhost:4242/api/convert/start");
    const request = new Request(url, {
      method: "POST",
      body: "",
      headers: { "content-type": "application/json" },
    });

    const response = await handler.handle(url, "POST", request, {});
    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
  });

  it("POST /api/convert/start returns 400 on invalid JSON", async () => {
    const handler = createHandler();
    const url = new URL("http://localhost:4242/api/convert/start");
    const request = new Request(url, {
      method: "POST",
      body: "not json{",
      headers: { "content-type": "application/json" },
    });

    const response = await handler.handle(url, "POST", request, {});
    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("Invalid JSON");
  });

  it("POST /api/convert/start returns 400 on empty selectedCategories", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/api/convert/start", "POST", {
      selectedCategories: [],
    });

    expect(response!.status).toBe(400);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("selectedCategories");
  });

  it("POST /api/convert/start returns 400 on invalid category", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/api/convert/start", "POST", {
      selectedCategories: ["agents", "invalid-category"],
    });

    expect(response!.status).toBe(400);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("Invalid category");
  });

  it("POST /api/convert/start returns 400 on invalid conflictStrategy", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/api/convert/start", "POST", {
      selectedCategories: ["agents"],
      conflictStrategy: "invalid",
    });

    expect(response!.status).toBe(400);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("conflictStrategy");
  });

  it("POST /api/convert/start returns 409 when conversion already running", async () => {
    const handler = createHandler({
      convert: async () => {
        // Simulate a long-running conversion
        await new Promise((r) => setTimeout(r, 5000));
        return ok(makeConversionResult());
      },
    });

    // Start first conversion
    const first = await sendRequest(handler, "/api/convert/start", "POST", {
      selectedCategories: ["agents"],
    });
    expect(first!.status).toBe(201);

    // Try to start second conversion while first is running
    const second = await sendRequest(handler, "/api/convert/start", "POST", {
      selectedCategories: ["skills"],
    });
    expect(second!.status).toBe(409);

    const data = (await readJson(second!)) as { error: string };
    expect(data.error).toContain("already running");
  });

  // ── GET /api/convert/status ──────────────────────────────────

  it("GET /api/convert/status returns idle when no conversion started", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/api/convert/status", "GET");

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as { status: string };
    expect(data.status).toBe("idle");
  });

  it("GET /api/convert/status returns running after start", async () => {
    const handler = createHandler({
      convert: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return ok(makeConversionResult());
      },
    });

    await sendRequest(handler, "/api/convert/start", "POST", {
      selectedCategories: ["agents"],
    });

    const response = await sendRequest(handler, "/api/convert/status", "GET");
    expect(response).not.toBeNull();

    const data = (await readJson(response!)) as {
      status: string;
      conversionId: string;
      startedAt: string;
    };
    expect(data.status).toBe("running");
    expect(data.conversionId).toBeDefined();
    expect(data.startedAt).toBeDefined();
  });

  it("GET /api/convert/status returns complete after conversion finishes", async () => {
    const result = makeConversionResult({ totalConverted: 10 });
    const handler = createHandler({
      convert: async () => ok(result),
    });

    await sendRequest(handler, "/api/convert/start", "POST", {
      selectedCategories: ["agents"],
    });

    // Wait for async conversion to complete
    await new Promise((r) => setTimeout(r, 50));

    const response = await sendRequest(handler, "/api/convert/status", "GET");
    const data = (await readJson(response!)) as {
      status: string;
      result: ConversionResult;
    };
    expect(data.status).toBe("complete");
    expect(data.result).toBeDefined();
    expect(data.result.totalConverted).toBe(10);
  });

  it("GET /api/convert/status returns error when conversion fails", async () => {
    const handler = createHandler({
      convert: async () =>
        err(new ReinsError("Conversion failed", "CONVERSION_ERROR")),
    });

    await sendRequest(handler, "/api/convert/start", "POST", {
      selectedCategories: ["agents"],
    });

    // Wait for async conversion to complete
    await new Promise((r) => setTimeout(r, 50));

    const response = await sendRequest(handler, "/api/convert/status", "GET");
    const data = (await readJson(response!)) as {
      status: string;
      error: string;
    };
    expect(data.status).toBe("error");
    expect(data.error).toContain("Conversion failed");
  });

  // ── GET /api/convert/report ──────────────────────────────────

  it("GET /api/convert/report returns 404 when no report exists", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/api/convert/report", "GET");

    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("No conversion report found");
  });

  it("GET /api/convert/report returns report when available", async () => {
    const reportContent = "# Reins Conversion Report\n**Status:** Success";
    const tempDir = await mkdtemp(join(tmpdir(), "reins-conversion-report-"));
    const reportPath = join(tempDir, "report.md");
    await Bun.write(reportPath, reportContent);

    const handler = createHandler(
      {},
      {
        getLastReportPath: () => reportPath,
      },
    );

    const response = await sendRequest(handler, "/api/convert/report", "GET");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as {
      report: string;
      path: string;
    };
    expect(data.report).toBe(reportContent);
    expect(data.path).toBe(reportPath);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("generates report after successful conversion and stores reportPath in status", async () => {
    const result = makeConversionResult();
    let generatedReportPath: string | null = null;

    const handler = createHandler(
      {
        convert: async () => ok(result),
      },
      {
        generate: async () => {
          generatedReportPath = "/tmp/generated-report.md";
          return ok(generatedReportPath);
        },
      },
    );

    const startResponse = await sendRequest(handler, "/api/convert/start", "POST", {
      selectedCategories: ["agents"],
    });

    expect(startResponse).not.toBeNull();
    expect(startResponse!.status).toBe(201);

    await new Promise((r) => setTimeout(r, 50));

    const statusResponse = await sendRequest(handler, "/api/convert/status", "GET");
    expect(statusResponse).not.toBeNull();

    const data = (await readJson(statusResponse!)) as {
      status: string;
      result?: ConversionResult;
    };

    expect(generatedReportPath).toBe("/tmp/generated-report.md");
    expect(data.status).toBe("complete");
    expect(data.result?.reportPath).toBe("/tmp/generated-report.md");
  });

  // ── POST /api/convert/resolve-conflict ───────────────────────

  it("GET /api/convert/status returns conflict payload when resolution is pending", async () => {
    const pendingConflict: ConflictInfo = {
      category: "agents",
      itemName: "Eleanor",
      existingValue: { id: "existing-agent" },
      incomingValue: { id: "incoming-agent" },
      path: "agents",
    };

    const handler = createHandler({
      convert: async (options: {
        onConflict?: (conflict: ConflictInfo) => Promise<"overwrite" | "merge" | "skip">;
      }) => {
        if (options.onConflict) {
          await options.onConflict(pendingConflict);
        }
        return ok(makeConversionResult());
      },
    });

    await sendRequest(handler, "/api/convert/start", "POST", {
      selectedCategories: ["agents"],
    });

    await new Promise((r) => setTimeout(r, 20));

    const conflictStatusResponse = await sendRequest(handler, "/api/convert/status", "GET");
    const conflictStatus = (await readJson(conflictStatusResponse!)) as {
      status: string;
      conflict?: {
        id: string;
        type: string;
        description: string;
        strategies: string[];
      };
    };

    expect(conflictStatus.status).toBe("conflict");
    expect(conflictStatus.conflict).toBeDefined();
    expect(conflictStatus.conflict?.id).toBeDefined();
    expect(conflictStatus.conflict?.type).toBe("agent");
    expect(conflictStatus.conflict?.description).toContain("Eleanor");
    expect(conflictStatus.conflict?.strategies).toEqual(["overwrite", "merge", "skip"]);

    const resolveResponse = await sendRequest(
      handler,
      "/api/convert/resolve-conflict",
      "POST",
      { strategy: "skip" },
    );
    expect(resolveResponse).not.toBeNull();
    expect(resolveResponse!.status).toBe(200);

    await new Promise((r) => setTimeout(r, 20));

    const finalStatusResponse = await sendRequest(handler, "/api/convert/status", "GET");
    const finalStatus = (await readJson(finalStatusResponse!)) as { status: string };
    expect(finalStatus.status).toBe("complete");
  });

  it("POST /api/convert/resolve-conflict returns 404 when no conflict is pending", async () => {
    const handler = createHandler();
    const response = await sendRequest(
      handler,
      "/api/convert/resolve-conflict",
      "POST",
      {
        strategy: "skip",
      },
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("No pending conflict");
  });

  it("POST /api/convert/resolve-conflict returns 400 on missing strategy", async () => {
    const handler = createHandler();
    const response = await sendRequest(
      handler,
      "/api/convert/resolve-conflict",
      "POST",
      {
        conflictId: "legacy-id",
      },
    );

    expect(response!.status).toBe(400);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("strategy");
  });

  it("POST /api/convert/resolve-conflict returns 400 on invalid strategy", async () => {
    const handler = createHandler();
    const response = await sendRequest(
      handler,
      "/api/convert/resolve-conflict",
      "POST",
      {
        strategy: "invalid",
      },
    );

    expect(response!.status).toBe(400);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("strategy");
  });

  // ── Unknown routes ───────────────────────────────────────────

  it("returns null for non-conversion routes", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/health", "GET");
    expect(response).toBeNull();
  });

  it("returns null for unrelated paths", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/channels", "GET");
    expect(response).toBeNull();
  });

  it("returns 405 for unsupported method on conversion path", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/api/convert/start", "GET");

    expect(response).not.toBeNull();
    expect(response!.status).toBe(405);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("not allowed");
  });

  // ── Content-Type header ──────────────────────────────────────

  it("responses include Content-Type application/json header", async () => {
    const handler = createHandler();
    const response = await sendRequest(handler, "/api/convert/status", "GET");

    expect(response).not.toBeNull();
    expect(response!.headers.get("content-type")).toBe("application/json");
  });

  // ── GET /api/openclaw/detect ─────────────────────────────────

  it("GET /api/openclaw/detect returns DetectionResult from mock detector", async () => {
    const detectionResult: DetectionResult = {
      found: true,
      path: "/home/user/.openclaw",
      platform: "linux",
    };
    const handler = createHandler({}, {}, createMockDetector(detectionResult));
    const response = await sendRequest(handler, "/api/openclaw/detect", "GET");

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const data = (await readJson(response!)) as DetectionResult;
    expect(data.found).toBe(true);
    expect(data.path).toBe("/home/user/.openclaw");
    expect(data.platform).toBe("linux");
  });

  it("GET /api/openclaw/detect caches result across multiple requests", async () => {
    let callCount = 0;
    const mockDetector = {
      detect: async (): Promise<DetectionResult> => {
        callCount++;
        return { found: true, path: "/home/user/.openclaw", platform: "linux" };
      },
    } as unknown as OpenClawDetector;

    const handler = createHandler({}, {}, mockDetector);

    await sendRequest(handler, "/api/openclaw/detect", "GET");
    await sendRequest(handler, "/api/openclaw/detect", "GET");
    await sendRequest(handler, "/api/openclaw/detect", "GET");

    expect(callCount).toBe(1);
  });

  // ── Lifecycle integration ────────────────────────────────────

  it("full lifecycle: start, poll status, complete", async () => {
    const result = makeConversionResult({ totalConverted: 3 });
    const handler = createHandler({
      convert: async () => ok(result),
    });

    // Step 1: Start conversion
    const startResponse = await sendRequest(
      handler,
      "/api/convert/start",
      "POST",
      { selectedCategories: ["agents", "skills", "conversations"] },
    );
    expect(startResponse!.status).toBe(201);
    const startData = (await readJson(startResponse!)) as {
      conversionId: string;
      status: string;
    };
    expect(startData.status).toBe("started");

    // Step 2: Wait for completion
    await new Promise((r) => setTimeout(r, 50));

    // Step 3: Check status — should be complete
    const statusResponse = await sendRequest(
      handler,
      "/api/convert/status",
      "GET",
    );
    const statusData = (await readJson(statusResponse!)) as {
      status: string;
      conversionId: string;
      result: ConversionResult;
    };
    expect(statusData.status).toBe("complete");
    expect(statusData.conversionId).toBe(startData.conversionId);
    expect(statusData.result.totalConverted).toBe(3);
  });

  // ── Conversion progress streaming ───────────────────────────

  describe("Conversion progress streaming", () => {
    it("publishes progress events to wsRegistry when ProgressEmitter fires", () => {
      const listeners = new Set<(e: ConversionProgressEvent) => void>();
      const mockEmitter = {
        on: (listener: (e: ConversionProgressEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };

      const published: unknown[] = [];
      const mockRegistry = {
        publish: (_target: unknown, payload: unknown) => {
          published.push(payload);
          return 1;
        },
      };

      createConversionRouteHandler({
        conversionService: createMockConversionService(),
        reportGenerator: createMockReportGenerator(),
        progressEmitter: mockEmitter as unknown as ProgressEmitter,
        wsRegistry: mockRegistry as unknown as WsStreamRegistry<StreamRegistrySocketData>,
      });

      const event: ConversionProgressEvent = {
        category: "agents",
        processed: 1,
        total: 5,
        elapsedMs: 100,
        status: "started",
      };
      for (const listener of listeners) listener(event);

      expect(published).toHaveLength(1);
      const envelope = published[0] as {
        type: string;
        event: ConversionProgressEvent;
        timestamp: string;
      };
      expect(envelope.type).toBe("conversion-progress");
      expect(envelope.event).toEqual(event);
      expect(typeof envelope.timestamp).toBe("string");
    });

    it("does not wire streaming when progressEmitter is absent", () => {
      const published: unknown[] = [];
      const mockRegistry = {
        publish: (_target: unknown, payload: unknown) => {
          published.push(payload);
          return 1;
        },
      };

      createConversionRouteHandler({
        conversionService: createMockConversionService(),
        reportGenerator: createMockReportGenerator(),
        wsRegistry: mockRegistry as unknown as WsStreamRegistry<StreamRegistrySocketData>,
      });

      expect(published).toHaveLength(0);
    });

    it("does not wire streaming when wsRegistry is absent", () => {
      const listeners = new Set<(e: ConversionProgressEvent) => void>();
      const mockEmitter = {
        on: (listener: (e: ConversionProgressEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };

      createConversionRouteHandler({
        conversionService: createMockConversionService(),
        reportGenerator: createMockReportGenerator(),
        progressEmitter: mockEmitter as unknown as ProgressEmitter,
      });

      // Emitter registered but no crash when wsRegistry is absent
      expect(listeners.size).toBe(0);
    });

    it("exports CONVERSION_PROGRESS_STREAM constant with correct shape", () => {
      expect(CONVERSION_PROGRESS_STREAM.conversationId).toBe("conversion");
      expect(CONVERSION_PROGRESS_STREAM.assistantMessageId).toBe("progress");
    });

    it("isConversionWebSocketMessage recognizes subscribe/unsubscribe messages", () => {
      expect(isConversionWebSocketMessage({ type: "conversion.subscribe" })).toBe(true);
      expect(isConversionWebSocketMessage({ type: "conversion.unsubscribe" })).toBe(true);
      expect(isConversionWebSocketMessage({ type: "stream.subscribe" })).toBe(false);
      expect(isConversionWebSocketMessage(null)).toBe(false);
      expect(isConversionWebSocketMessage(undefined)).toBe(false);
      expect(isConversionWebSocketMessage("string")).toBe(false);
      expect(isConversionWebSocketMessage(42)).toBe(false);
    });
  });
});

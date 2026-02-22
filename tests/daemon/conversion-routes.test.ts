import { describe, expect, it } from "bun:test";

import {
  createConversionRouteHandler,
  type ConversionRouteHandler,
} from "../../src/daemon/conversion-routes";
import type { ConversionService } from "../../src/conversion/service";
import type { ReportGenerator } from "../../src/conversion/report";
import type { ConversionResult } from "../../src/conversion/types";
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

function createHandler(
  serviceOverrides: Partial<Record<string, unknown>> = {},
  reportOverrides: Partial<Record<string, unknown>> = {},
): ConversionRouteHandler {
  return createConversionRouteHandler({
    conversionService: createMockConversionService(serviceOverrides),
    reportGenerator: createMockReportGenerator(reportOverrides),
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
    const handler = createHandler(
      {},
      {
        readLastReport: async () => ok(reportContent),
        getLastReportPath: () => "/home/user/.reins/conversion-report-2026.md",
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
    expect(data.path).toBe("/home/user/.reins/conversion-report-2026.md");
  });

  // ── POST /api/convert/resolve-conflict ───────────────────────

  it("POST /api/convert/resolve-conflict returns 404 for unknown conflictId", async () => {
    const handler = createHandler();
    const response = await sendRequest(
      handler,
      "/api/convert/resolve-conflict",
      "POST",
      {
        conflictId: "nonexistent-id",
        resolution: "skip",
      },
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("nonexistent-id");
  });

  it("POST /api/convert/resolve-conflict returns 400 on missing conflictId", async () => {
    const handler = createHandler();
    const response = await sendRequest(
      handler,
      "/api/convert/resolve-conflict",
      "POST",
      {
        resolution: "skip",
      },
    );

    expect(response!.status).toBe(400);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("conflictId");
  });

  it("POST /api/convert/resolve-conflict returns 400 on invalid resolution", async () => {
    const handler = createHandler();
    const response = await sendRequest(
      handler,
      "/api/convert/resolve-conflict",
      "POST",
      {
        conflictId: "some-id",
        resolution: "invalid",
      },
    );

    expect(response!.status).toBe(400);

    const data = (await readJson(response!)) as { error: string };
    expect(data.error).toContain("resolution");
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
});

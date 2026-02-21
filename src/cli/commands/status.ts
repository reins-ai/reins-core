import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import { DAEMON_PORT } from "../../config/defaults";

type WriteFn = (text: string) => void;

const DEFAULT_DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;

interface DaemonStatusPayload {
  status: "running" | "offline";
  pid: number | null;
  uptimeSeconds: number | null;
  version: string | null;
}

interface RuntimeSummaryPayload {
  provider: string | null;
  model: string | null;
  modelCount: number | null;
  sessionCount: number | null;
}

interface StatusPayload {
  daemon: DaemonStatusPayload;
  summary: RuntimeSummaryPayload;
}

interface StatusCommandDeps {
  fetchFn: typeof fetch;
  daemonBaseUrl: string;
  writeStdout: WriteFn;
  writeStderr: WriteFn;
}

export type RunStatusFn = (args?: string[], customDeps?: Partial<StatusCommandDeps>) => Promise<number>;

export async function runStatus(args: string[] = [], customDeps: Partial<StatusCommandDeps> = {}): Promise<number> {
  const deps: StatusCommandDeps = {
    fetchFn: customDeps.fetchFn ?? fetch,
    daemonBaseUrl: customDeps.daemonBaseUrl ?? DEFAULT_DAEMON_BASE_URL,
    writeStdout: customDeps.writeStdout ?? process.stdout.write.bind(process.stdout),
    writeStderr: customDeps.writeStderr ?? process.stderr.write.bind(process.stderr),
  };

  const parsedArgs = parseStatusArgs(args);
  if (!parsedArgs.ok) {
    deps.writeStderr(`${parsedArgs.error.message}\n`);
    return 1;
  }

  const statusResult = await collectStatus(deps.fetchFn, deps.daemonBaseUrl);
  if (!statusResult.ok) {
    const payload: StatusPayload = {
      daemon: {
        status: "offline",
        pid: null,
        uptimeSeconds: null,
        version: null,
      },
      summary: {
        provider: null,
        model: null,
        modelCount: null,
        sessionCount: null,
      },
    };

    if (parsedArgs.value.json) {
      deps.writeStdout(
        `${JSON.stringify(
          {
            ...payload,
            guidance: "The daemon is not running. Start it with: reins service start",
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    deps.writeStdout(formatOfflineStatusOutput());
    return 0;
  }

  if (parsedArgs.value.json) {
    deps.writeStdout(`${JSON.stringify(toJsonPayload(statusResult.value), null, 2)}\n`);
    return 0;
  }

  deps.writeStdout(formatRunningStatusOutput(statusResult.value));
  return 0;
}

function parseStatusArgs(args: string[]): Result<{ json: boolean }, ReinsError> {
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    return err(new ReinsError(`Unsupported status flag '${arg}'. Try: reins status --json`, "CLI_STATUS_INVALID_ARGUMENT"));
  }

  return ok({ json });
}

async function collectStatus(fetchFn: typeof fetch, daemonBaseUrl: string): Promise<Result<StatusPayload, ReinsError>> {
  const healthResult = await fetchJson(fetchFn, `${daemonBaseUrl}/health`);
  if (!healthResult.ok) {
    return healthResult;
  }

  const healthRecord = asRecord(healthResult.value);
  if (!healthRecord) {
    return err(new ReinsError("Daemon health response was not an object", "CLI_STATUS_INVALID_HEALTH_RESPONSE"));
  }

  const daemon = parseDaemonStatus(healthRecord);
  if (daemon.status !== "running") {
    return err(new ReinsError("Daemon reported non-running status", "CLI_DAEMON_NOT_RUNNING"));
  }

  let summary = parseRuntimeSummary(healthRecord);

  const statusResult = await fetchJson(fetchFn, `${daemonBaseUrl}/status`);
  if (statusResult.ok) {
    const statusRecord = asRecord(statusResult.value);
    if (statusRecord) {
      summary = mergeSummary(summary, parseRuntimeSummary(statusRecord));
    }
  }

  if (summary.modelCount === null) {
    const providerResult = await fetchJson(fetchFn, `${daemonBaseUrl}/providers`);
    if (providerResult.ok) {
      const providerRecord = asRecord(providerResult.value);
      if (providerRecord) {
        summary = mergeSummary(summary, parseRuntimeSummary(providerRecord));
      }
    }
  }

  if (summary.sessionCount === null) {
    const conversationResult = await fetchJson(fetchFn, `${daemonBaseUrl}/conversations`);
    if (conversationResult.ok) {
      summary = mergeSummary(summary, parseConversationsSummary(conversationResult.value));
    }
  }

  return ok({ daemon, summary });
}

function parseDaemonStatus(record: Record<string, unknown>): DaemonStatusPayload {
  const statusText = readString(record, ["status", "state", "daemonStatus"]);
  const normalized = statusText?.toLowerCase();

  const status: DaemonStatusPayload["status"] =
    normalized && (normalized === "offline" || normalized === "stopped" || normalized === "down") ? "offline" : "running";

  return {
    status,
    pid: readNumber(record, ["pid", "processId", "daemonPid"]),
    uptimeSeconds: readUptimeSeconds(record),
    version: readString(record, ["version", "daemonVersion"]),
  };
}

function parseRuntimeSummary(record: Record<string, unknown>): RuntimeSummaryPayload {
  const providerRecord = asRecord(record.provider);
  const modelRecord = asRecord(record.model);
  const usageRecord = asRecord(record.usage);

  return {
    provider:
      readString(record, ["provider", "activeProvider", "providerName"]) ??
      readString(providerRecord, ["name", "active"]),
    model:
      readString(record, ["model", "activeModel", "modelName"]) ?? readString(modelRecord, ["name", "active"]),
    modelCount:
      readNumber(record, ["modelCount", "modelsAvailable", "availableModels"]) ??
      readNumber(providerRecord, ["modelCount", "availableModels"]) ??
      readArrayLength(record, ["models", "availableModels"]),
    sessionCount:
      readNumber(record, ["sessionCount", "conversationCount", "conversations"]) ??
      readNumber(usageRecord, ["sessionCount", "conversationCount"]) ??
      readArrayLength(record, ["sessions", "conversationIds"]),
  };
}

function parseConversationsSummary(value: unknown): RuntimeSummaryPayload {
  if (Array.isArray(value)) {
    return {
      provider: null,
      model: null,
      modelCount: null,
      sessionCount: value.length,
    };
  }

  const record = asRecord(value);
  if (!record) {
    return {
      provider: null,
      model: null,
      modelCount: null,
      sessionCount: null,
    };
  }

  return {
    provider: null,
    model: null,
    modelCount: null,
    sessionCount:
      readNumber(record, ["count", "sessionCount", "conversationCount"]) ?? readArrayLength(record, ["items", "results"]),
  };
}

function mergeSummary(base: RuntimeSummaryPayload, incoming: RuntimeSummaryPayload): RuntimeSummaryPayload {
  return {
    provider: incoming.provider ?? base.provider,
    model: incoming.model ?? base.model,
    modelCount: incoming.modelCount ?? base.modelCount,
    sessionCount: incoming.sessionCount ?? base.sessionCount,
  };
}

function formatRunningStatusOutput(payload: StatusPayload): string {
  const daemonDetails: string[] = [];

  if (payload.daemon.pid !== null) {
    daemonDetails.push(`PID ${payload.daemon.pid}`);
  }

  if (payload.daemon.uptimeSeconds !== null) {
    daemonDetails.push(`uptime ${formatUptime(payload.daemon.uptimeSeconds)}`);
  }

  if (payload.daemon.version) {
    daemonDetails.push(`v${payload.daemon.version}`);
  }

  const daemonSuffix = daemonDetails.length > 0 ? ` (${daemonDetails.join(", ")})` : "";

  const provider = payload.summary.provider ?? "unknown";
  const modelCount = payload.summary.modelCount ?? 0;
  const model = payload.summary.model ?? "unknown";
  const sessions = payload.summary.sessionCount ?? 0;

  return [
    "reins status",
    "",
    `Daemon    ● running${daemonSuffix}`,
    `Provider  ${provider} (${modelCount} models available)`,
    `Model     ${model} (active)`,
    `Sessions  ${sessions} conversations`,
    "",
    "All systems operational.",
    "",
  ].join("\n");
}

function formatOfflineStatusOutput(): string {
  return [
    "reins status",
    "",
    "Daemon    ○ offline",
    "",
    "The daemon is not running. Start it with:",
    "  reins service start",
    "",
  ].join("\n");
}

function toJsonPayload(payload: StatusPayload): Record<string, unknown> {
  return {
    daemon: payload.daemon,
    provider: {
      name: payload.summary.provider,
      modelsAvailable: payload.summary.modelCount,
    },
    model: {
      name: payload.summary.model,
      active: payload.summary.model !== null,
    },
    sessions: {
      count: payload.summary.sessionCount,
    },
    status: "operational",
  };
}

function formatUptime(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

async function fetchJson(fetchFn: typeof fetch, url: string): Promise<Result<unknown, ReinsError>> {
  try {
    const response = await fetchFn(url, {
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      return err(
        new ReinsError(
          `Request failed for ${url}: ${response.status} ${response.statusText}`,
          "CLI_STATUS_HTTP_ERROR",
        ),
      );
    }

    return ok(await response.json());
  } catch (error) {
    return err(
      new ReinsError(
        `Unable to reach daemon endpoint ${url}`,
        "CLI_STATUS_FETCH_FAILED",
        error instanceof Error ? error : undefined,
      ),
    );
  }
}

function readUptimeSeconds(record: Record<string, unknown>): number | null {
  const uptimeSeconds = readNumber(record, ["uptimeSeconds", "uptime", "daemonUptimeSeconds"]);
  if (uptimeSeconds !== null) {
    return uptimeSeconds;
  }

  const uptimeMs = readNumber(record, ["uptimeMs", "uptimeMilliseconds"]);
  if (uptimeMs !== null) {
    return Math.floor(uptimeMs / 1000);
  }

  return null;
}

function readString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function readNumber(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function readArrayLength(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

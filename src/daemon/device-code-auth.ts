import { AuthError } from "../errors";
import type { ConvexDaemonClient } from "../convex";
import { err, ok, type Result } from "../result";

const DEFAULT_CODE_LENGTH = 6;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

const createDeviceCodeReference = "device_codes:create";
const getDeviceCodeByCodeReference = "device_codes:getByCode";

interface ConvexDeviceCodeClient {
  mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
  query(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
}

export interface GenerateDeviceCodeOptions {
  convexClient: ConvexDaemonClient;
  now?: () => number;
  ttlMs?: number;
  codeLength?: number;
}

export interface DeviceCodeGenerationResult {
  code: string;
  expiresAt: number;
}

export interface PollDeviceCodeOptions {
  convexClient: ConvexDaemonClient;
  code: string;
  now?: () => number;
}

export type DeviceCodePollStatus = "pending" | "verified" | "expired";

export interface DeviceCodePollResult {
  status: DeviceCodePollStatus;
  userId?: string;
  sessionToken?: string;
  expiresAt?: number;
}

interface DeviceCodeRecord {
  code: string;
  expiresAt: number;
  verified: boolean;
  userId?: string;
  sessionToken?: string;
}

export async function generateDeviceCode(
  options: GenerateDeviceCodeOptions,
): Promise<Result<DeviceCodeGenerationResult, AuthError>> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const codeLength = options.codeLength ?? DEFAULT_CODE_LENGTH;

  if (!Number.isInteger(codeLength) || codeLength <= 0) {
    return err(new AuthError("Device code length must be a positive integer"));
  }

  const clientResult = getConvexDeviceCodeClient(options.convexClient);
  if (!clientResult.ok) {
    return clientResult;
  }

  const code = createNumericCode(codeLength);
  const expiresAt = now() + ttlMs;

  try {
    await clientResult.value.mutation(createDeviceCodeReference, { code, expiresAt });
    return ok({ code, expiresAt });
  } catch (error) {
    return err(new AuthError("Failed to create device code", error instanceof Error ? error : undefined));
  }
}

export async function pollDeviceCode(
  options: PollDeviceCodeOptions,
): Promise<Result<DeviceCodePollResult, AuthError>> {
  const now = options.now ?? Date.now;
  const trimmedCode = options.code.trim();
  if (trimmedCode.length === 0) {
    return err(new AuthError("Device code is required"));
  }

  const clientResult = getConvexDeviceCodeClient(options.convexClient);
  if (!clientResult.ok) {
    return clientResult;
  }

  try {
    const response = await clientResult.value.query(getDeviceCodeByCodeReference, { code: trimmedCode });
    if (response === null) {
      return ok({ status: "expired" });
    }

    const recordResult = toDeviceCodeRecord(response);
    if (!recordResult.ok) {
      return recordResult;
    }

    const record = recordResult.value;
    if (record.expiresAt <= now()) {
      return ok({ status: "expired", expiresAt: record.expiresAt });
    }

    if (record.verified) {
      return ok({
        status: "verified",
        userId: record.userId,
        sessionToken: record.sessionToken,
        expiresAt: record.expiresAt,
      });
    }

    return ok({ status: "pending", expiresAt: record.expiresAt });
  } catch (error) {
    return err(new AuthError("Failed to fetch device code status", error instanceof Error ? error : undefined));
  }
}

function getConvexDeviceCodeClient(convexClient: ConvexDaemonClient): Result<ConvexDeviceCodeClient, AuthError> {
  const runtimeClient = convexClient.getClient();
  if (!runtimeClient) {
    return err(new AuthError("Convex client is not initialized"));
  }

  const candidate = runtimeClient as unknown as Partial<ConvexDeviceCodeClient>;
  if (typeof candidate.query !== "function" || typeof candidate.mutation !== "function") {
    return err(new AuthError("Convex client does not expose query/mutation APIs"));
  }

  return ok(candidate as ConvexDeviceCodeClient);
}

function toDeviceCodeRecord(value: unknown): Result<DeviceCodeRecord, AuthError> {
  if (!isRecord(value)) {
    return err(new AuthError("Device code record is invalid"));
  }

  const code = value.code;
  const expiresAt = value.expiresAt;
  const verified = value.verified;
  const userId = value.userId;
  const sessionToken = value.sessionToken;

  if (typeof code !== "string" || typeof expiresAt !== "number" || typeof verified !== "boolean") {
    return err(new AuthError("Device code record fields are invalid"));
  }

  return ok({
    code,
    expiresAt,
    verified,
    userId: typeof userId === "string" ? userId : undefined,
    sessionToken: typeof sessionToken === "string" ? sessionToken : undefined,
  });
}

function createNumericCode(length: number): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(length));
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += (randomBytes[index]! % 10).toString();
  }
  return code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

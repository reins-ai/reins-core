import type { KeychainProvider } from "../../security/keychain-provider";
import type { ImportLogWriter } from "../import-log";
import type { MapError, MapperOptions, MapResult } from "./types";

const GATEWAY_TOKEN_SERVICE = "reins-gateway-token";
const GATEWAY_TOKEN_ACCOUNT = "openclaw-import";
const CATEGORY = "gateway-config";

/**
 * Typed representation of the OpenClaw gateway config block.
 * Extends the inline shape from OpenClawConfig with additional known fields.
 */
export interface OpenClawGatewayConfig {
  port?: number;
  host?: string;
  authMode?: string;
  authToken?: string;
  tailscale?: boolean;
  allowedOrigins?: string[];
  rateLimit?: { requests: number; windowMs: number };
  ssl?: { cert?: string; key?: string };
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Reasons why each known gateway field cannot be mapped to Reins.
 */
const UNMAPPED_REASONS: Record<string, string> = {
  port: "Reins daemon uses a fixed port; gateway port config not applicable",
  host: "Reins daemon binds to localhost only; host config not applicable",
  authMode: "Reins uses Clerk/device-code auth; OpenClaw auth mode not applicable",
  tailscale: "Tailscale integration not yet supported in Reins",
  allowedOrigins: "Reins uses built-in CORS policy; origin allowlist not applicable",
  rateLimit: "Reins has built-in rate limiting; manual config not applicable",
  ssl: "Reins does not support direct SSL termination; use a reverse proxy",
  metadata: "Gateway metadata has no equivalent in Reins",
};

/**
 * Known gateway fields that are logged as unmapped (not secrets).
 * Ordered for deterministic log output.
 */
const KNOWN_UNMAPPED_FIELDS = [
  "port",
  "host",
  "authMode",
  "tailscale",
  "allowedOrigins",
  "rateLimit",
  "ssl",
  "metadata",
] as const;

/**
 * Maps OpenClaw gateway configuration to the Reins import log.
 *
 * OpenClaw gateway settings (port, host, auth mode, Tailscale, etc.) have no
 * direct equivalent in Reins. Every known field is logged to the ImportLogWriter
 * with an explanation. The sole exception is `authToken`, which is stored
 * securely in the system keychain and then logged with `isSecret: true` so the
 * value is redacted in the output file.
 */
export class GatewayConfigMapper {
  private readonly importLogWriter: ImportLogWriter;
  private readonly keychainProvider: KeychainProvider;

  constructor(importLogWriter: ImportLogWriter, keychainProvider: KeychainProvider) {
    this.importLogWriter = importLogWriter;
    this.keychainProvider = keychainProvider;
  }

  /**
   * Process a gateway config block, logging all fields and storing the auth
   * token in the keychain when present.
   *
   * @returns MapResult where `converted` is 1 if authToken was stored, 0
   *   otherwise; `skipped` counts fields that were absent in the config.
   */
  public async map(
    gatewayConfig: OpenClawGatewayConfig,
    options?: MapperOptions,
  ): Promise<MapResult> {
    const errors: MapError[] = [];
    let converted = 0;
    let skipped = 0;

    const totalFields = KNOWN_UNMAPPED_FIELDS.length + 1; // +1 for authToken
    let processed = 0;

    // --- Log all known unmapped fields ---
    for (const field of KNOWN_UNMAPPED_FIELDS) {
      const value = gatewayConfig[field];

      if (value === undefined || value === null) {
        skipped += 1;
      } else {
        const reason =
          UNMAPPED_REASONS[field] ?? `Gateway field '${field}' has no equivalent in Reins`;

        this.importLogWriter.addEntry({
          path: `gateway.${field}`,
          originalValue: value,
          isSecret: false,
          reason,
          category: CATEGORY,
        });
      }

      processed += 1;
      options?.onProgress?.(processed, totalFields);
    }

    // --- Handle authToken: store in keychain, log as secret ---
    const authToken = gatewayConfig.authToken;

    if (typeof authToken === "string" && authToken.trim().length > 0) {
      try {
        if (!options?.dryRun) {
          const result = await this.keychainProvider.set(
            GATEWAY_TOKEN_SERVICE,
            GATEWAY_TOKEN_ACCOUNT,
            authToken,
          );

          if (!result.ok) {
            errors.push({
              item: "gateway.authToken",
              reason: `Failed to store auth token in keychain: ${result.error.message}`,
            });
            skipped += 1;
          } else {
            converted += 1;
          }
        } else {
          // Dry run: count as converted without writing
          converted += 1;
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        errors.push({
          item: "gateway.authToken",
          reason: `Failed to store auth token in keychain: ${message}`,
        });
        skipped += 1;
      }

      // Always log the auth token entry (value redacted via isSecret: true)
      this.importLogWriter.addEntry({
        path: "gateway.authToken",
        originalValue: authToken,
        isSecret: true,
        reason: "Auth token stored in system keychain under 'reins-gateway-token'",
        category: CATEGORY,
      });
    } else {
      skipped += 1;
    }

    processed += 1;
    options?.onProgress?.(processed, totalFields);

    // --- Log any extra unknown fields not in the known set ---
    const knownSet = new Set<string>([...KNOWN_UNMAPPED_FIELDS, "authToken"]);

    for (const key of Object.keys(gatewayConfig)) {
      if (knownSet.has(key)) {
        continue;
      }

      const value = gatewayConfig[key];
      if (value === undefined || value === null) {
        continue;
      }

      this.importLogWriter.addEntry({
        path: `gateway.${key}`,
        originalValue: value,
        isSecret: false,
        reason: `Unknown gateway field '${key}' has no equivalent in Reins`,
        category: CATEGORY,
      });
    }

    return { converted, skipped, errors };
  }
}

/**
 * Provider setup validation for onboarding.
 *
 * Provides a diagnostic function that checks whether a provider is properly
 * configured and can list models. Used by the daemon HTTP API during
 * onboarding to validate API keys after entry.
 */

import { ok, type Result } from "../result";
import type { ProviderRegistry } from "../providers/registry";

/**
 * Result of validating a provider's setup status.
 */
export interface ProviderSetupValidation {
  /** Whether the provider is configured and reachable. */
  configured: boolean;
  /** Model IDs available from the provider (empty if not configured). */
  models: string[];
}

/**
 * Options for creating a provider setup validator.
 */
export interface ValidateProviderSetupOptions {
  /** Provider registry to look up providers by ID. */
  registry: ProviderRegistry;
}

const NOT_CONFIGURED: ProviderSetupValidation = {
  configured: false,
  models: [],
};

/**
 * Validate whether a provider is properly configured and can list models.
 *
 * This is a diagnostic function — it never propagates errors. All failure
 * modes return `ok({ configured: false, models: [] })` so callers can
 * safely display status without error handling.
 */
export async function validateProviderSetup(
  providerId: string,
  options: ValidateProviderSetupOptions,
): Promise<Result<ProviderSetupValidation>> {
  try {
    const provider = options.registry.get(providerId);
    if (!provider) {
      return ok(NOT_CONFIGURED);
    }

    const connected = await provider.validateConnection();
    if (!connected) {
      return ok(NOT_CONFIGURED);
    }

    const models = await provider.listModels();
    const modelIds = models.map((m) => m.id);

    return ok({ configured: true, models: modelIds });
  } catch {
    return ok(NOT_CONFIGURED);
  }
}

import { AuthError } from "../../errors";
import { createLogger } from "../../logger";
import { err, ok, type Result } from "../../result";

const log = createLogger("providers:byok:anthropic-auth");
import type { EncryptedCredentialStore } from "../credentials/store";
import type {
  ApiKeyAuthStrategy,
  ApiKeyCredentialInput,
  AuthStrategyContext,
  StoredApiKeyCredential,
} from "../oauth/types";

const ANTHROPIC_KEY_PREFIX = "sk-ant-";
const ANTHROPIC_VALIDATION_URL = "https://api.anthropic.com/v1/models?limit=1";
const ANTHROPIC_API_VERSION = "2023-06-01";
const CREDENTIAL_ID_PREFIX = "auth_anthropic_api_key";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AnthropicApiKeyStrategyOptions {
  store: EncryptedCredentialStore;
  fetchFn?: FetchLike;
  validationUrl?: string;
}

function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }

  const entries = Object.entries(metadata)
    .filter(([key, value]) => key.trim().length > 0 && value.trim().length > 0)
    .map(([key, value]) => [key.trim(), value.trim()] as const);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function validateKeyFormat(key: string): Result<string, AuthError> {
  const trimmed = key.trim();

  if (trimmed.length === 0) {
    return err(
      new AuthError(
        "Anthropic API key is required. You can find your API key at https://console.anthropic.com/settings/keys",
      ),
    );
  }

  if (!trimmed.startsWith(ANTHROPIC_KEY_PREFIX)) {
    return err(
      new AuthError(
        `Anthropic API key must start with "${ANTHROPIC_KEY_PREFIX}". ` +
          "Check that you copied the full key from https://console.anthropic.com/settings/keys",
      ),
    );
  }

  if (trimmed.length < 20) {
    return err(
      new AuthError(
        "Anthropic API key appears incomplete. " +
          "Ensure you copied the entire key from https://console.anthropic.com/settings/keys",
      ),
    );
  }

  return ok(trimmed);
}

function classifyValidationError(status: number, _body: string): AuthError {
  switch (status) {
    case 401:
      return new AuthError(
        "Anthropic API key is invalid or has been revoked. " +
          "Generate a new key at https://console.anthropic.com/settings/keys",
      );
    case 403:
      return new AuthError(
        "Anthropic API key does not have sufficient permissions. " +
          "Check your key's permissions at https://console.anthropic.com/settings/keys",
      );
    case 429:
      return new AuthError(
        "Anthropic API rate limit reached during validation. " +
          "Wait a moment and try again.",
      );
    default:
      return new AuthError(
        `Anthropic API returned an unexpected error (HTTP ${status}). ` +
          "Try again in a few moments. If the problem persists, check https://status.anthropic.com",
      );
  }
}

export class AnthropicApiKeyStrategy implements ApiKeyAuthStrategy {
  public readonly mode = "api_key" as const;

  private readonly credentialStore: EncryptedCredentialStore;
  private readonly fetchFn: FetchLike;
  private readonly validationUrl: string;

  constructor(options: AnthropicApiKeyStrategyOptions) {
    this.credentialStore = options.store;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.validationUrl = options.validationUrl ?? ANTHROPIC_VALIDATION_URL;
  }

  public validate(input: ApiKeyCredentialInput): Result<string, AuthError> {
    return validateKeyFormat(input.key);
  }

  public async validateWithEndpoint(key: string): Promise<Result<void, AuthError>> {
    const formatResult = validateKeyFormat(key);
    if (!formatResult.ok) {
      return formatResult;
    }

    let response: Response;
    try {
      response = await this.fetchFn(this.validationUrl, {
        method: "GET",
        headers: {
          "x-api-key": formatResult.value,
          "anthropic-version": ANTHROPIC_API_VERSION,
        },
      });
    } catch (error) {
      return err(
        new AuthError(
          "Unable to reach Anthropic API for key validation. " +
            "Check your network connection and try again.",
          error instanceof Error ? error : undefined,
        ),
      );
    }

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch (e) {
        // Expected: body may be unreadable on certain error responses
        log.debug("failed to read error response body", { error: e instanceof Error ? e.message : String(e) });
      }

      return err(classifyValidationError(response.status, body));
    }

    return ok(undefined);
  }

  public async store(input: ApiKeyCredentialInput): Promise<Result<void, AuthError>> {
    const result = await this.credentialStore.set({
      id: CREDENTIAL_ID_PREFIX,
      provider: "anthropic",
      type: "api_key",
      accountId: "default",
      metadata: normalizeMetadata(input.metadata),
      payload: {
        key: input.key,
      },
    });

    if (!result.ok) {
      return err(
        new AuthError(
          "Unable to save Anthropic API key. Try again or check file permissions.",
          result.error,
        ),
      );
    }

    return ok(undefined);
  }

  public async retrieve(
    _context: AuthStrategyContext,
  ): Promise<Result<StoredApiKeyCredential | null, AuthError>> {
    const result = await this.credentialStore.get({
      id: CREDENTIAL_ID_PREFIX,
      provider: "anthropic",
      type: "api_key",
      accountId: "default",
    });

    if (!result.ok) {
      return err(
        new AuthError("Unable to load Anthropic API key credential.", result.error),
      );
    }

    if (!result.value) {
      return ok(null);
    }

    const payloadResult = await this.credentialStore.decryptPayload<unknown>(result.value);
    if (!payloadResult.ok) {
      return err(
        new AuthError("Unable to decrypt Anthropic API key credential.", payloadResult.error),
      );
    }

    const payload = payloadResult.value;
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as Record<string, unknown>).key !== "string"
    ) {
      return err(new AuthError("Stored Anthropic API key credential is corrupted."));
    }

    return ok({
      key: (payload as Record<string, string>).key,
      metadata: result.value.metadata,
      updatedAt: result.value.updatedAt,
    });
  }

  public async revoke(_context: AuthStrategyContext): Promise<Result<void, AuthError>> {
    const result = await this.credentialStore.revoke(CREDENTIAL_ID_PREFIX);
    if (!result.ok) {
      return err(
        new AuthError("Unable to revoke Anthropic API key.", result.error),
      );
    }

    return ok(undefined);
  }
}

export { validateKeyFormat, classifyValidationError };

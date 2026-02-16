import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../../../result";
import { IntegrationError } from "../../errors";
import { validateIntegrationManifest } from "../../manifest";
import type { CredentialVault } from "../../credentials/types";
import type {
  Integration,
  IntegrationConfig,
  IntegrationManifest,
  IntegrationOperation,
  IntegrationStatus,
} from "../../types";
import { GmailAuth, type GmailOAuthConfig } from "./auth";
import type { OAuthRefreshManager } from "../../credentials/oauth-refresh";
import { connect as connectOperation } from "./operations/connect";
import { disconnect as disconnectOperation } from "./operations/disconnect";
import { readEmail } from "./operations/read-email";
import { searchEmails } from "./operations/search-emails";
import { sendEmail } from "./operations/send-email";
import { listEmails } from "./operations/list-emails";

let cachedManifest: IntegrationManifest | null = null;

export async function loadGmailManifest(): Promise<Result<IntegrationManifest, IntegrationError>> {
  if (cachedManifest) {
    return ok(cachedManifest);
  }

  const manifestPath = join(import.meta.dir, "manifest.json");

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    return err(new IntegrationError(`Failed to read Gmail manifest at ${manifestPath}`));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return err(new IntegrationError("Gmail manifest contains invalid JSON"));
  }

  const validationResult = validateIntegrationManifest(parsed);
  if (!validationResult.valid) {
    return err(
      new IntegrationError(
        `Gmail manifest validation failed: ${validationResult.errors.join("; ")}`,
      ),
    );
  }

  cachedManifest = validationResult.value;
  return ok(cachedManifest);
}

export function resetGmailManifestCacheForTests(): void {
  cachedManifest = null;
}

export interface GmailIntegrationOptions {
  vault: CredentialVault;
  manifest: IntegrationManifest;
  refreshManager?: OAuthRefreshManager;
  config?: Partial<IntegrationConfig>;
}

export class GmailIntegration implements Integration {
  public readonly config: IntegrationConfig;
  public readonly manifest: IntegrationManifest;

  private readonly auth: GmailAuth;

  constructor(options: GmailIntegrationOptions) {
    this.manifest = options.manifest;
    this.auth = new GmailAuth({
      vault: options.vault,
      refreshManager: options.refreshManager,
    });
    this.config = {
      id: options.manifest.id,
      enabled: options.config?.enabled ?? true,
      settings: options.config?.settings,
      authConfig: options.config?.authConfig,
    };
  }

  public async connect(): Promise<Result<void, IntegrationError>> {
    const oauthConfigResult = this.resolveOAuthConfig();
    if (!oauthConfigResult.ok) {
      return oauthConfigResult;
    }

    return this.auth.connect(oauthConfigResult.value);
  }

  public async disconnect(): Promise<Result<void, IntegrationError>> {
    return this.auth.disconnect();
  }

  public getStatus(): IntegrationStatus {
    return this.auth.getStatus();
  }

  public getOperations(): IntegrationOperation[] {
    return this.manifest.operations;
  }

  public async execute(
    operationName: string,
    args: Record<string, unknown>,
  ): Promise<Result<unknown, IntegrationError>> {
    if (operationName === "connect") {
      const oauthConfigResult = this.resolveOAuthConfig();
      if (!oauthConfigResult.ok) {
        return oauthConfigResult;
      }

      return connectOperation(this.auth, oauthConfigResult.value);
    }

    if (operationName === "disconnect") {
      return disconnectOperation(this.auth);
    }

    const tokenResult = await this.auth.getAccessToken();
    if (!tokenResult.ok) {
      return tokenResult;
    }

    const accessToken = tokenResult.value;

    switch (operationName) {
      case "read-email":
        return readEmail(accessToken, {
          id: String(args["id"] ?? ""),
        });

      case "search-emails":
        return searchEmails(accessToken, {
          query: String(args["query"] ?? ""),
          maxResults: typeof args["maxResults"] === "number" ? args["maxResults"] : undefined,
          pageToken: typeof args["pageToken"] === "string" ? args["pageToken"] : undefined,
        });

      case "send-email":
        return sendEmail(accessToken, {
          to: String(args["to"] ?? ""),
          subject: String(args["subject"] ?? ""),
          body: String(args["body"] ?? ""),
          cc: typeof args["cc"] === "string" ? args["cc"] : undefined,
          bcc: typeof args["bcc"] === "string" ? args["bcc"] : undefined,
        });

      case "list-emails":
        return listEmails(accessToken, {
          maxResults: typeof args["maxResults"] === "number" ? args["maxResults"] : undefined,
          pageToken: typeof args["pageToken"] === "string" ? args["pageToken"] : undefined,
          labelIds: Array.isArray(args["labelIds"])
            ? args["labelIds"].filter((item): item is string => typeof item === "string")
            : undefined,
        });

      default:
        return err(
          new IntegrationError(`Unknown Gmail operation: ${operationName}`),
        );
    }
  }

  public getAuth(): GmailAuth {
    return this.auth;
  }

  private resolveOAuthConfig(): Result<GmailOAuthConfig, IntegrationError> {
    const clientIdFromConfig = this.readStringConfig("googleClientId")
      ?? this.readStringConfig("clientId")
      ?? process.env["GMAIL_CLIENT_ID"]
      ?? process.env["GOOGLE_CLIENT_ID"];

    if (!clientIdFromConfig || clientIdFromConfig.trim().length === 0) {
      return err(
        new IntegrationError(
          [
            "Gmail requires OAuth credentials to connect.",
            "",
            "To set up Gmail OAuth:",
            "1. Go to Google Cloud Console (https://console.cloud.google.com)",
            "2. Create a new project or select existing",
            "3. Enable Gmail API",
            "4. Create OAuth 2.0 credentials (Desktop app type)",
            "5. Set environment variables:",
            '   export GMAIL_CLIENT_ID="your-client-id"',
            '   export GMAIL_CLIENT_SECRET="your-client-secret"',
            "6. Restart Reins daemon",
            "7. Try connecting again",
            "",
            "Need help? See: https://developers.google.com/gmail/api/quickstart",
          ].join("\n"),
        ),
      );
    }

    const clientSecret = this.readStringConfig("googleClientSecret")
      ?? this.readStringConfig("clientSecret")
      ?? process.env["GMAIL_CLIENT_SECRET"]
      ?? process.env["GOOGLE_CLIENT_SECRET"];

    const scopes = this.readScopesConfig() ?? this.resolveManifestScopes();

    return ok({
      clientId: clientIdFromConfig,
      clientSecret,
      scopes,
    });
  }

  private readStringConfig(key: string): string | undefined {
    const value = this.config.authConfig?.[key];
    if (typeof value !== "string") {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private readScopesConfig(): string[] | undefined {
    const value = this.config.authConfig?.["scopes"];
    if (!Array.isArray(value)) {
      return undefined;
    }

    const scopes = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    return scopes.length > 0 ? scopes : undefined;
  }

  private resolveManifestScopes(): string[] {
    if (this.manifest.auth.type !== "oauth2") {
      return [];
    }

    return this.manifest.auth.scopes;
  }
}

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok } from "../../../../src/result";

import { IntegrationError } from "../../../../src/integrations/errors";
import { validateIntegrationManifest } from "../../../../src/integrations/manifest";
import { InMemoryCredentialVault } from "../../../../src/integrations/credentials/vault";
import { IntegrationState } from "../../../../src/integrations/types";
import type { OAuthCredential } from "../../../../src/integrations/credentials/types";
import type { IntegrationResult } from "../../../../src/integrations/result";
import {
  GmailIntegration,
  loadGmailManifest,
  resetGmailManifestCacheForTests,
} from "../../../../src/integrations/adapters/gmail/index";
import { GmailAuth } from "../../../../src/integrations/adapters/gmail/auth";
import { connect as connectGmail } from "../../../../src/integrations/adapters/gmail/operations/connect";
import { disconnect as disconnectGmail } from "../../../../src/integrations/adapters/gmail/operations/disconnect";
import { readEmail } from "../../../../src/integrations/adapters/gmail/operations/read-email";
import { searchEmails } from "../../../../src/integrations/adapters/gmail/operations/search-emails";
import { sendEmail } from "../../../../src/integrations/adapters/gmail/operations/send-email";
import { listEmails } from "../../../../src/integrations/adapters/gmail/operations/list-emails";

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = mock(handler as typeof fetch) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

// ---------------------------------------------------------------------------
// Test OAuth credential helpers
// ---------------------------------------------------------------------------

function createTestOAuthCredential(overrides?: Partial<OAuthCredential>): OAuthCredential {
  return {
    type: "oauth",
    access_token: "test-access-token-abc123",
    refresh_token: "test-refresh-token-xyz789",
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    token_type: "Bearer",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Realistic Gmail API response factories
// ---------------------------------------------------------------------------

function gmailMessageFull(overrides?: Partial<{
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  bodyText: string;
  snippet: string;
  labelIds: string[];
  attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
}>) {
  const id = overrides?.id ?? "msg-001";
  const threadId = overrides?.threadId ?? "thread-001";
  const subject = overrides?.subject ?? "Test Subject";
  const from = overrides?.from ?? "sender@example.com";
  const to = overrides?.to ?? "recipient@example.com";
  const cc = overrides?.cc ?? "";
  const date = overrides?.date ?? "Mon, 15 Feb 2026 10:30:00 -0500";
  const bodyText = overrides?.bodyText ?? "Hello, this is the email body.";
  const snippet = overrides?.snippet ?? "Hello, this is the email body.";
  const labelIds = overrides?.labelIds ?? ["INBOX", "UNREAD"];
  const attachments = overrides?.attachments ?? [];

  const headers = [
    { name: "Subject", value: subject },
    { name: "From", value: from },
    { name: "To", value: to },
    { name: "Date", value: date },
  ];

  if (cc) {
    headers.push({ name: "Cc", value: cc });
  }

  const bodyData = Buffer.from(bodyText, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const parts: unknown[] = [
    {
      mimeType: "text/plain",
      body: { data: bodyData, size: bodyText.length },
    },
  ];

  for (const att of attachments) {
    parts.push({
      filename: att.filename,
      mimeType: att.mimeType,
      body: { size: att.size, attachmentId: att.attachmentId },
    });
  }

  return {
    id,
    threadId,
    labelIds,
    snippet,
    payload: {
      mimeType: "multipart/mixed",
      headers,
      parts,
    },
  };
}

function gmailMessageMetadata(overrides?: Partial<{
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  labelIds: string[];
}>) {
  const id = overrides?.id ?? "msg-001";
  const threadId = overrides?.threadId ?? "thread-001";
  const subject = overrides?.subject ?? "Test Subject";
  const from = overrides?.from ?? "sender@example.com";
  const to = overrides?.to ?? "recipient@example.com";
  const date = overrides?.date ?? "Mon, 15 Feb 2026 10:30:00 -0500";
  const snippet = overrides?.snippet ?? "Hello, this is the email body.";
  const labelIds = overrides?.labelIds ?? ["INBOX", "UNREAD"];

  return {
    id,
    threadId,
    labelIds,
    snippet,
    payload: {
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: from },
        { name: "To", value: to },
        { name: "Date", value: date },
      ],
    },
  };
}

function gmailMessageListResponse(
  messages: Array<{ id: string; threadId: string }>,
  nextPageToken?: string,
  resultSizeEstimate?: number,
) {
  return {
    messages: messages.length > 0 ? messages : undefined,
    nextPageToken,
    resultSizeEstimate: resultSizeEstimate ?? messages.length,
  };
}

function gmailSendResponse(id = "sent-001", threadId = "thread-sent-001") {
  return {
    id,
    threadId,
    labelIds: ["SENT"],
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetGmailManifestCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

describe("GmailManifest", () => {
  it("loads and validates the manifest from disk", async () => {
    const result = await loadGmailManifest();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = result.value;
    expect(manifest.id).toBe("gmail");
    expect(manifest.name).toBe("Gmail");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.category).toBe("communication");
    expect(manifest.auth.type).toBe("oauth2");
    expect(manifest.platforms).toContain("daemon");
    expect(manifest.operations).toHaveLength(6);
  });

  it("passes validateIntegrationManifest with the raw JSON", async () => {
    const manifestPath = join(import.meta.dir, "../../../../src/integrations/adapters/gmail/manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf-8"));
    const result = validateIntegrationManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("includes connect, disconnect, and core operations in the manifest", async () => {
    const result = await loadGmailManifest();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const opNames = result.value.operations.map((op) => op.name);
    expect(opNames).toContain("connect");
    expect(opNames).toContain("disconnect");
    expect(opNames).toContain("read-email");
    expect(opNames).toContain("search-emails");
    expect(opNames).toContain("send-email");
    expect(opNames).toContain("list-emails");
  });

  it("declares OAuth2 auth with required scopes", async () => {
    const result = await loadGmailManifest();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const auth = result.value.auth;
    expect(auth.type).toBe("oauth2");
    if (auth.type !== "oauth2") return;

    expect(auth.scopes).toContain("gmail.readonly");
    expect(auth.scopes).toContain("gmail.send");
    expect(auth.scopes).toContain("gmail.modify");
    expect(auth.pkce).toBe(true);
  });

  it("caches the manifest on subsequent loads", async () => {
    const first = await loadGmailManifest();
    const second = await loadGmailManifest();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // Same reference due to caching
    expect(first.value).toBe(second.value);
  });
});

// ---------------------------------------------------------------------------
// OAuth auth handler
// ---------------------------------------------------------------------------

describe("GmailAuth", () => {
  it("starts in INSTALLED state with disconnected indicator", () => {
    const vault = new InMemoryCredentialVault();
    const auth = new GmailAuth({ vault });

    const status = auth.getStatus();
    expect(status.state).toBe(IntegrationState.INSTALLED);
    expect(status.indicator).toBe("disconnected");
    expect(status.lastError).toBeUndefined();
  });

  it("returns error when getting access token without connection", async () => {
    const vault = new InMemoryCredentialVault();
    const auth = new GmailAuth({ vault });

    const result = await auth.getAccessToken();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("not connected");
  });

  it("returns access token when valid credential is stored", async () => {
    const vault = new InMemoryCredentialVault();
    const credential = createTestOAuthCredential();
    await vault.store("gmail", credential);

    const auth = new GmailAuth({ vault });
    const result = await auth.getAccessToken();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("test-access-token-abc123");
  });

  it("returns error for expired credential without refresh callback", async () => {
    const vault = new InMemoryCredentialVault();
    const expiredCredential = createTestOAuthCredential({
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    await vault.store("gmail", expiredCredential);

    const auth = new GmailAuth({ vault });
    const result = await auth.getAccessToken();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("refresh callback");
  });

  it("disconnects and clears stored credentials", async () => {
    const vault = new InMemoryCredentialVault();
    const credential = createTestOAuthCredential();
    await vault.store("gmail", credential);

    const auth = new GmailAuth({ vault });
    const disconnectResult = await auth.disconnect();
    expect(disconnectResult.ok).toBe(true);

    const status = auth.getStatus();
    expect(status.state).toBe(IntegrationState.DISCONNECTED);
    expect(status.indicator).toBe("disconnected");

    const hasCredentials = await vault.hasCredentials("gmail");
    expect(hasCredentials.ok).toBe(true);
    if (hasCredentials.ok) {
      expect(hasCredentials.value).toBe(false);
    }
  });

  it("retrieves stored credential", async () => {
    const vault = new InMemoryCredentialVault();
    const credential = createTestOAuthCredential();
    await vault.store("gmail", credential);

    const auth = new GmailAuth({ vault });
    const result = await auth.getCredential();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value?.access_token).toBe("test-access-token-abc123");
  });

  it("returns null credential when not stored", async () => {
    const vault = new InMemoryCredentialVault();
    const auth = new GmailAuth({ vault });

    const result = await auth.getCredential();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("updates status via IntegrationStatusUpdater interface", async () => {
    const vault = new InMemoryCredentialVault();
    const auth = new GmailAuth({ vault });

    await auth.updateStatus("gmail", "connected");
    expect(auth.getStatus().indicator).toBe("connected");

    await auth.updateStatus("gmail", "auth_expired", "Token expired");
    expect(auth.getStatus().indicator).toBe("auth_expired");
    expect(auth.getStatus().lastError).toBe("Token expired");
  });

  it("ignores status updates for other integration IDs", async () => {
    const vault = new InMemoryCredentialVault();
    const auth = new GmailAuth({ vault });

    await auth.updateStatus("spotify", "connected");
    // Should remain in initial state
    expect(auth.getStatus().indicator).toBe("disconnected");
  });
});

// ---------------------------------------------------------------------------
// GmailIntegration class
// ---------------------------------------------------------------------------

describe("GmailIntegration", () => {
  it("exposes manifest and config", async () => {
    const manifestResult = await loadGmailManifest();
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    const vault = new InMemoryCredentialVault();
    const integration = new GmailIntegration({
      vault,
      manifest: manifestResult.value,
      config: {
        authConfig: { googleClientId: "test-client-id" },
      },
    });

    expect(integration.manifest.id).toBe("gmail");
    expect(integration.config.id).toBe("gmail");
    expect(integration.config.enabled).toBe(true);
  });

  it("returns operations from manifest", async () => {
    const manifestResult = await loadGmailManifest();
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    const vault = new InMemoryCredentialVault();
    const integration = new GmailIntegration({
      vault,
      manifest: manifestResult.value,
    });

    const ops = integration.getOperations();
    expect(ops).toHaveLength(6);
    expect(ops.map((op) => op.name)).toEqual(
      expect.arrayContaining(["connect", "disconnect", "read-email", "search-emails", "send-email", "list-emails"]),
    );
  });

  it("returns error for connect without client ID", async () => {
    const manifestResult = await loadGmailManifest();
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    const vault = new InMemoryCredentialVault();
    const integration = new GmailIntegration({
      vault,
      manifest: manifestResult.value,
      // No authConfig with clientId
    });

    const result = await integration.connect();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("Gmail requires OAuth credentials");
  });

  it("includes setup guide in OAuth config error", async () => {
    const manifestResult = await loadGmailManifest();
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    const vault = new InMemoryCredentialVault();
    const integration = new GmailIntegration({
      vault,
      manifest: manifestResult.value,
    });

    const result = await integration.connect();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Google Cloud Console");
    expect(result.error.message).toContain("GMAIL_CLIENT_ID");
    expect(result.error.message).toContain("GMAIL_CLIENT_SECRET");
    expect(result.error.message).toContain("developers.google.com");
  });

  it("returns error for unknown operation", async () => {
    const manifestResult = await loadGmailManifest();
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    const vault = new InMemoryCredentialVault();
    const credential = createTestOAuthCredential();
    await vault.store("gmail", credential);

    const integration = new GmailIntegration({
      vault,
      manifest: manifestResult.value,
    });

    mockFetch(() => jsonResponse({}));

    const result = await integration.execute("unknown-operation", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Unknown Gmail operation");
  });

  it("delegates read-email to the operation handler", async () => {
    const manifestResult = await loadGmailManifest();
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    const vault = new InMemoryCredentialVault();
    const credential = createTestOAuthCredential();
    await vault.store("gmail", credential);

    const integration = new GmailIntegration({
      vault,
      manifest: manifestResult.value,
    });

    const message = gmailMessageFull({ id: "msg-delegate-001", subject: "Delegated Read" });
    mockFetch(() => jsonResponse(message));

    const result = await integration.execute("read-email", { id: "msg-delegate-001" });
    expect(result.ok).toBe(true);
  });

  it("dispatches connect through execute without requiring a pre-existing token", async () => {
    const manifestResult = await loadGmailManifest();
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    const vault = new InMemoryCredentialVault();
    const integration = new GmailIntegration({
      vault,
      manifest: manifestResult.value,
      config: {
        authConfig: { googleClientId: "test-client-id" },
      },
    });

    const auth = integration.getAuth() as unknown as {
      connect: (config: unknown) => Promise<unknown>;
      getAccessToken: () => Promise<unknown>;
    };

    auth.connect = mock(async () => ok(undefined));
    auth.getAccessToken = mock(async () => ok("oauth-token"));

    mockFetch(() => jsonResponse({ emailAddress: "user@example.com" }));

    const result = await integration.execute("connect", {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const modelData = (result.value as IntegrationResult).forModel.data as {
      connected: boolean;
      email?: string;
    };

    expect(modelData.connected).toBe(true);
    expect(modelData.email).toBe("user@example.com");
  });

  it("dispatches disconnect through execute without requiring an access token", async () => {
    const manifestResult = await loadGmailManifest();
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    const vault = new InMemoryCredentialVault();
    const integration = new GmailIntegration({
      vault,
      manifest: manifestResult.value,
      config: {
        authConfig: { googleClientId: "test-client-id" },
      },
    });

    const auth = integration.getAuth() as unknown as {
      disconnect: () => Promise<unknown>;
    };
    auth.disconnect = mock(async () => ok(undefined));

    const result = await integration.execute("disconnect", {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const modelData = (result.value as IntegrationResult).forModel.data as { connected: boolean };
    expect(modelData.connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// connect/disconnect operations
// ---------------------------------------------------------------------------

describe("gmail connect/disconnect operations", () => {
  it("connect returns connected result with profile email", async () => {
    const auth = {
      connect: mock(async () => ok(undefined)),
      getAccessToken: mock(async () => ok("oauth-token")),
    } as unknown as GmailAuth;

    mockFetch(() => jsonResponse({ emailAddress: "profile@example.com" }));

    const result = await connectGmail(auth, {
      clientId: "test-client-id",
      scopes: ["gmail.readonly", "gmail.send", "gmail.modify"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value;
    const modelData = data.forModel.data as { connected: boolean; email?: string };
    expect(modelData.connected).toBe(true);
    expect(modelData.email).toBe("profile@example.com");
    expect(data.forUser.message).toBe("Connected to Gmail as profile@example.com");
  });

  it("connect succeeds without email when profile endpoint fails", async () => {
    const auth = {
      connect: mock(async () => ok(undefined)),
      getAccessToken: mock(async () => ok("oauth-token")),
    } as unknown as GmailAuth;

    mockFetch(() => textResponse("Server Error", 500));

    const result = await connectGmail(auth, {
      clientId: "test-client-id",
      scopes: ["gmail.readonly", "gmail.send", "gmail.modify"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const modelData = result.value.forModel.data as { connected: boolean; email?: string };
    expect(modelData.connected).toBe(true);
    expect(modelData.email).toBeUndefined();
    expect(result.value.forUser.message).toBe("Connected to Gmail");
  });

  it("disconnect clears connection state", async () => {
    const auth = {
      disconnect: mock(async () => ok(undefined)),
    } as unknown as GmailAuth;

    const result = await disconnectGmail(auth);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const modelData = result.value.forModel.data as { connected: boolean };
    expect(modelData.connected).toBe(false);
    expect(result.value.forUser.message).toContain("cleared saved credentials");
  });
});

// ---------------------------------------------------------------------------
// read-email operation
// ---------------------------------------------------------------------------

describe("readEmail", () => {
  const TOKEN = "test-access-token";

  it("reads an email by ID with dual-channel result", async () => {
    const message = gmailMessageFull({
      id: "msg-read-001",
      threadId: "thread-read-001",
      subject: "Meeting Tomorrow",
      from: "alice@example.com",
      to: "bob@example.com",
      bodyText: "Don't forget the meeting at 3pm.",
      snippet: "Don't forget the meeting at 3pm.",
      labelIds: ["INBOX", "IMPORTANT"],
      attachments: [
        { filename: "agenda.pdf", mimeType: "application/pdf", size: 12345, attachmentId: "att-001" },
      ],
    });

    mockFetch(() => jsonResponse(message));

    const result = await readEmail(TOKEN, { id: "msg-read-001" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;

    // forModel: compact
    expect(data.forModel.kind).toBe("detail");
    expect(data.forModel.summary).toBe("email details");
    const modelData = data.forModel.data as {
      id: string;
      subject: string;
      from: string;
      snippet: string;
      date: string;
      hasAttachments: boolean;
    };
    expect(modelData.id).toBe("msg-read-001");
    expect(modelData.subject).toBe("Meeting Tomorrow");
    expect(modelData.from).toBe("alice@example.com");
    expect(modelData.hasAttachments).toBe(true);

    // forUser: rich
    expect(data.forUser.kind).toBe("detail");
    expect(data.forUser.title).toContain("Meeting Tomorrow");
    const userData = data.forUser.data as {
      id: string;
      threadId: string;
      subject: string;
      from: string;
      to: string;
      body: string;
      attachments: Array<{ filename: string }>;
    };
    expect(userData.id).toBe("msg-read-001");
    expect(userData.threadId).toBe("thread-read-001");
    expect(userData.to).toBe("bob@example.com");
    expect(userData.body).toContain("Don't forget the meeting");
    expect(userData.attachments).toHaveLength(1);
    expect(userData.attachments[0].filename).toBe("agenda.pdf");
  });

  it("returns forModel with fewer fields than forUser", async () => {
    const message = gmailMessageFull({
      id: "msg-compact-001",
      subject: "Compact Test",
      from: "test@example.com",
      bodyText: "Full body content that should only appear in forUser.",
    });

    mockFetch(() => jsonResponse(message));

    const result = await readEmail(TOKEN, { id: "msg-compact-001" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelKeys = Object.keys(data.forModel.data as Record<string, unknown>);
    const userKeys = Object.keys(data.forUser.data as Record<string, unknown>);

    // forModel should have fewer keys (token-optimized)
    expect(modelKeys.length).toBeLessThan(userKeys.length);

    // forUser should have body, forModel should not
    expect(userKeys).toContain("body");
    expect(modelKeys).not.toContain("body");
  });

  it("returns error for empty message ID", async () => {
    const result = await readEmail(TOKEN, { id: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("must not be empty");
  });

  it("returns error for whitespace-only message ID", async () => {
    const result = await readEmail(TOKEN, { id: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("must not be empty");
  });

  it("returns error for 404 not found", async () => {
    mockFetch(() => textResponse("Not Found", 404));

    const result = await readEmail(TOKEN, { id: "nonexistent-msg" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("not found");
  });

  it("returns error for 401 unauthorized", async () => {
    mockFetch(() => textResponse("Unauthorized", 401));

    const result = await readEmail(TOKEN, { id: "msg-001" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("authentication expired");
  });

  it("returns error for 500 server error", async () => {
    mockFetch(() => textResponse("Internal Server Error", 500));

    const result = await readEmail(TOKEN, { id: "msg-001" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Gmail API error (500)");
  });

  it("returns error when fetch throws (network failure)", async () => {
    mockFetch(() => {
      throw new Error("Network unreachable");
    });

    const result = await readEmail(TOKEN, { id: "msg-001" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Failed to connect");
  });

  it("handles email with no attachments", async () => {
    const message = gmailMessageFull({
      id: "msg-no-att",
      subject: "No Attachments",
      attachments: [],
    });

    mockFetch(() => jsonResponse(message));

    const result = await readEmail(TOKEN, { id: "msg-no-att" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const modelData = (result.value as IntegrationResult).forModel.data as { hasAttachments: boolean };
    expect(modelData.hasAttachments).toBe(false);
  });

  it("handles email with HTML-only body (no text/plain part)", async () => {
    const htmlBody = "<p>Hello from HTML</p>";
    const htmlData = Buffer.from(htmlBody, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const message = {
      id: "msg-html-only",
      threadId: "thread-html",
      labelIds: ["INBOX"],
      snippet: "Hello from HTML",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "Subject", value: "HTML Only" },
          { name: "From", value: "html@example.com" },
          { name: "To", value: "me@example.com" },
          { name: "Date", value: "Mon, 15 Feb 2026 10:30:00 -0500" },
        ],
        parts: [
          {
            mimeType: "text/html",
            body: { data: htmlData, size: htmlBody.length },
          },
        ],
      },
    };

    mockFetch(() => jsonResponse(message));

    const result = await readEmail(TOKEN, { id: "msg-html-only" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const userData = (result.value as IntegrationResult).forUser.data as { body: string };
    expect(userData.body).toContain("Hello from HTML");
  });

  it("handles email with nested multipart MIME structure", async () => {
    const plainText = "Nested plain text body";
    const plainData = Buffer.from(plainText, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const message = {
      id: "msg-nested",
      threadId: "thread-nested",
      labelIds: ["INBOX"],
      snippet: "Nested plain text body",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "Subject", value: "Nested MIME" },
          { name: "From", value: "nested@example.com" },
          { name: "To", value: "me@example.com" },
          { name: "Date", value: "Mon, 15 Feb 2026 10:30:00 -0500" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/plain",
                body: { data: plainData, size: plainText.length },
              },
              {
                mimeType: "text/html",
                body: { data: "aHRtbA", size: 4 },
              },
            ],
          },
          {
            filename: "report.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            body: { size: 54321, attachmentId: "att-nested-001" },
          },
        ],
      },
    };

    mockFetch(() => jsonResponse(message));

    const result = await readEmail(TOKEN, { id: "msg-nested" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const userData = (result.value as IntegrationResult).forUser.data as {
      body: string;
      attachments: Array<{ filename: string }>;
    };
    expect(userData.body).toContain("Nested plain text body");
    expect(userData.attachments).toHaveLength(1);
    expect(userData.attachments[0].filename).toBe("report.xlsx");
  });

  it("sends correct Authorization header", async () => {
    let capturedHeaders: Record<string, string> = {};

    mockFetch((url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers) {
        capturedHeaders = { ...headers };
      }
      return jsonResponse(gmailMessageFull());
    });

    await readEmail("my-secret-token", { id: "msg-001" });
    expect(capturedHeaders["Authorization"]).toBe("Bearer my-secret-token");
  });
});

// ---------------------------------------------------------------------------
// search-emails operation
// ---------------------------------------------------------------------------

describe("searchEmails", () => {
  const TOKEN = "test-access-token";

  it("searches emails with dual-channel result", async () => {
    const listBody = gmailMessageListResponse(
      [
        { id: "msg-s1", threadId: "thread-s1" },
        { id: "msg-s2", threadId: "thread-s2" },
      ],
      undefined,
      2,
    );

    const meta1 = gmailMessageMetadata({
      id: "msg-s1",
      threadId: "thread-s1",
      subject: "Invoice #1234",
      from: "billing@company.com",
      snippet: "Your invoice is ready.",
    });

    const meta2 = gmailMessageMetadata({
      id: "msg-s2",
      threadId: "thread-s2",
      subject: "Receipt for Payment",
      from: "payments@company.com",
      snippet: "Payment received.",
    });

    let callCount = 0;
    mockFetch((url) => {
      if (url.includes("/messages?")) {
        callCount++;
        return jsonResponse(listBody);
      }
      if (url.includes("msg-s1")) {
        callCount++;
        return jsonResponse(meta1);
      }
      if (url.includes("msg-s2")) {
        callCount++;
        return jsonResponse(meta2);
      }
      return textResponse("Not Found", 404);
    });

    const result = await searchEmails(TOKEN, { query: "from:billing@company.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;

    // forModel: compact list
    expect(data.forModel.kind).toBe("list");
    expect(data.forModel.count).toBe(2);
    const modelItems = (data.forModel.data as { items: Array<{ id: string; subject: string; from: string }> }).items;
    expect(modelItems).toHaveLength(2);
    expect(modelItems[0].subject).toBe("Invoice #1234");
    expect(modelItems[0].from).toBe("billing@company.com");

    // forUser: rich list
    expect(data.forUser.kind).toBe("list");
    expect(data.forUser.title).toContain("from:billing@company.com");
    const userItems = (data.forUser.data as { items: Array<{ id: string; threadId: string; labelIds: string[] }> }).items;
    expect(userItems).toHaveLength(2);
    expect(userItems[0].threadId).toBe("thread-s1");
    expect(userItems[0].labelIds).toContain("INBOX");
  });

  it("returns empty results for no matches", async () => {
    const listBody = gmailMessageListResponse([], undefined, 0);

    mockFetch(() => jsonResponse(listBody));

    const result = await searchEmails(TOKEN, { query: "from:nobody@nowhere.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.count).toBe(0);
    expect(data.forModel.summary).toContain("No");
    expect(data.forUser.message).toContain("No emails matching");
  });

  it("returns error for empty query", async () => {
    const result = await searchEmails(TOKEN, { query: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("must not be empty");
  });

  it("returns error for whitespace-only query", async () => {
    const result = await searchEmails(TOKEN, { query: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("must not be empty");
  });

  it("handles pagination with nextPageToken", async () => {
    const listBody = gmailMessageListResponse(
      [{ id: "msg-page1", threadId: "thread-page1" }],
      "next-page-token-abc",
      5,
    );

    const meta = gmailMessageMetadata({ id: "msg-page1", subject: "Page 1 Email" });

    mockFetch((url) => {
      if (url.includes("/messages?")) return jsonResponse(listBody);
      if (url.includes("msg-page1")) return jsonResponse(meta);
      return textResponse("Not Found", 404);
    });

    const result = await searchEmails(TOKEN, { query: "test", maxResults: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const metadata = (result.value as IntegrationResult).forUser.metadata as {
      nextPageToken: string | null;
    };
    expect(metadata.nextPageToken).toBe("next-page-token-abc");
  });

  it("passes pageToken to the API request", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      if (url.includes("/messages?")) {
        capturedUrl = url;
        return jsonResponse(gmailMessageListResponse([]));
      }
      return textResponse("Not Found", 404);
    });

    await searchEmails(TOKEN, { query: "test", pageToken: "my-page-token" });
    expect(capturedUrl).toContain("pageToken=my-page-token");
  });

  it("returns error for 401 unauthorized", async () => {
    mockFetch(() => textResponse("Unauthorized", 401));

    const result = await searchEmails(TOKEN, { query: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("authentication expired");
  });

  it("returns error for 500 server error", async () => {
    mockFetch(() => textResponse("Internal Server Error", 500));

    const result = await searchEmails(TOKEN, { query: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Gmail API error (500)");
  });

  it("returns error when fetch throws (network failure)", async () => {
    mockFetch(() => {
      throw new Error("DNS resolution failed");
    });

    const result = await searchEmails(TOKEN, { query: "test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Failed to connect");
  });

  it("skips messages that fail metadata fetch", async () => {
    const listBody = gmailMessageListResponse([
      { id: "msg-ok", threadId: "thread-ok" },
      { id: "msg-fail", threadId: "thread-fail" },
    ]);

    const metaOk = gmailMessageMetadata({ id: "msg-ok", subject: "Good Email" });

    mockFetch((url) => {
      if (url.includes("/messages?")) return jsonResponse(listBody);
      if (url.includes("msg-ok")) return jsonResponse(metaOk);
      if (url.includes("msg-fail")) return textResponse("Server Error", 500);
      return textResponse("Not Found", 404);
    });

    const result = await searchEmails(TOKEN, { query: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.count).toBe(1);
    const modelItems = (data.forModel.data as { items: Array<{ id: string }> }).items;
    expect(modelItems[0].id).toBe("msg-ok");
  });

  it("uses various Gmail query patterns", async () => {
    const queries = [
      "from:alice@example.com",
      "to:bob@example.com",
      "subject:meeting",
      "newer_than:7d",
      "has:attachment",
      "from:alice@example.com subject:meeting newer_than:7d",
    ];

    for (const query of queries) {
      let capturedUrl = "";
      mockFetch((url) => {
        if (url.includes("/messages?")) {
          capturedUrl = url;
          return jsonResponse(gmailMessageListResponse([]));
        }
        return textResponse("Not Found", 404);
      });

      const result = await searchEmails(TOKEN, { query });
      expect(result.ok).toBe(true);
      expect(capturedUrl).toContain(encodeURIComponent(query).replace(/%20/g, "+").charAt(0));
    }
  });
});

// ---------------------------------------------------------------------------
// send-email operation
// ---------------------------------------------------------------------------

describe("sendEmail", () => {
  const TOKEN = "test-access-token";

  it("sends an email with dual-channel result", async () => {
    mockFetch(() => jsonResponse(gmailSendResponse("sent-001", "thread-sent-001")));

    const result = await sendEmail(TOKEN, {
      to: "recipient@example.com",
      subject: "Hello World",
      body: "This is a test email.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;

    // forModel: compact
    expect(data.forModel.kind).toBe("detail");
    const modelData = data.forModel.data as {
      id: string;
      threadId: string;
      to: string;
      subject: string;
    };
    expect(modelData.id).toBe("sent-001");
    expect(modelData.threadId).toBe("thread-sent-001");
    expect(modelData.to).toBe("recipient@example.com");
    expect(modelData.subject).toBe("Hello World");

    // forUser: rich
    expect(data.forUser.kind).toBe("detail");
    expect(data.forUser.title).toContain("Hello World");
    const userData = data.forUser.data as {
      id: string;
      threadId: string;
      to: string;
      subject: string;
      bodyPreview: string;
      sentAt: string;
    };
    expect(userData.bodyPreview).toBe("This is a test email.");
    expect(userData.sentAt).toBeTruthy();
  });

  it("sends email with cc and bcc", async () => {
    let capturedBody = "";
    mockFetch((_url, init) => {
      capturedBody = init?.body as string ?? "";
      return jsonResponse(gmailSendResponse());
    });

    const result = await sendEmail(TOKEN, {
      to: "main@example.com",
      subject: "CC/BCC Test",
      body: "Testing cc and bcc.",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify the raw message includes cc/bcc headers
    const parsed = JSON.parse(capturedBody) as { raw: string };
    const decoded = Buffer.from(
      parsed.raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
    expect(decoded).toContain("Cc: cc@example.com");
    expect(decoded).toContain("Bcc: bcc@example.com");
  });

  it("forUser includes cc/bcc info in rich result", async () => {
    mockFetch(() => jsonResponse(gmailSendResponse()));

    const result = await sendEmail(TOKEN, {
      to: "main@example.com",
      subject: "Rich Result Test",
      body: "Testing rich result.",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const userData = (result.value as IntegrationResult).forUser.data as {
      cc: string;
      bcc: string;
    };
    expect(userData.cc).toBe("cc@example.com");
    expect(userData.bcc).toBe("bcc@example.com");
  });

  it("truncates long body in bodyPreview", async () => {
    mockFetch(() => jsonResponse(gmailSendResponse()));

    const longBody = "A".repeat(300);
    const result = await sendEmail(TOKEN, {
      to: "recipient@example.com",
      subject: "Long Body",
      body: longBody,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const userData = (result.value as IntegrationResult).forUser.data as { bodyPreview: string };
    expect(userData.bodyPreview.length).toBeLessThan(longBody.length);
    expect(userData.bodyPreview).toContain("...");
  });

  it("returns error for empty recipient", async () => {
    const result = await sendEmail(TOKEN, {
      to: "",
      subject: "Test",
      body: "Test body",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Recipient");
    expect(result.error.message).toContain("must not be empty");
  });

  it("returns error for empty subject", async () => {
    const result = await sendEmail(TOKEN, {
      to: "recipient@example.com",
      subject: "",
      body: "Test body",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("subject");
    expect(result.error.message).toContain("must not be empty");
  });

  it("returns error for empty body", async () => {
    const result = await sendEmail(TOKEN, {
      to: "recipient@example.com",
      subject: "Test",
      body: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("body");
    expect(result.error.message).toContain("must not be empty");
  });

  it("returns error for whitespace-only fields", async () => {
    const result = await sendEmail(TOKEN, {
      to: "   ",
      subject: "Test",
      body: "Test body",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("must not be empty");
  });

  it("returns error for 401 unauthorized", async () => {
    mockFetch(() => textResponse("Unauthorized", 401));

    const result = await sendEmail(TOKEN, {
      to: "recipient@example.com",
      subject: "Test",
      body: "Test body",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("authentication expired");
  });

  it("returns error for 403 forbidden", async () => {
    mockFetch(() => textResponse("Forbidden: insufficient permissions", 403));

    const result = await sendEmail(TOKEN, {
      to: "recipient@example.com",
      subject: "Test",
      body: "Test body",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Gmail API error (403)");
  });

  it("returns error when fetch throws (network failure)", async () => {
    mockFetch(() => {
      throw new Error("Connection refused");
    });

    const result = await sendEmail(TOKEN, {
      to: "recipient@example.com",
      subject: "Test",
      body: "Test body",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Failed to connect");
  });

  it("sends POST request with correct content type", async () => {
    let capturedMethod = "";
    let capturedContentType = "";

    mockFetch((_url, init) => {
      capturedMethod = init?.method ?? "";
      const headers = init?.headers as Record<string, string> | undefined;
      capturedContentType = headers?.["Content-Type"] ?? "";
      return jsonResponse(gmailSendResponse());
    });

    await sendEmail(TOKEN, {
      to: "recipient@example.com",
      subject: "Test",
      body: "Test body",
    });

    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
  });

  it("constructs valid RFC 2822 message with base64url encoding", async () => {
    let capturedBody = "";
    mockFetch((_url, init) => {
      capturedBody = init?.body as string ?? "";
      return jsonResponse(gmailSendResponse());
    });

    await sendEmail(TOKEN, {
      to: "recipient@example.com",
      subject: "RFC Test",
      body: "RFC 2822 body content.",
    });

    const parsed = JSON.parse(capturedBody) as { raw: string };
    expect(parsed.raw).toBeTruthy();

    // Decode the base64url message
    const base64 = parsed.raw.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(base64, "base64").toString("utf-8");

    expect(decoded).toContain("To: recipient@example.com");
    expect(decoded).toContain("Subject: RFC Test");
    expect(decoded).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(decoded).toContain("MIME-Version: 1.0");
    expect(decoded).toContain("RFC 2822 body content.");
  });
});

// ---------------------------------------------------------------------------
// list-emails operation
// ---------------------------------------------------------------------------

describe("listEmails", () => {
  const TOKEN = "test-access-token";

  it("lists inbox emails with dual-channel result", async () => {
    const listBody = gmailMessageListResponse(
      [
        { id: "msg-l1", threadId: "thread-l1" },
        { id: "msg-l2", threadId: "thread-l2" },
        { id: "msg-l3", threadId: "thread-l3" },
      ],
      undefined,
      3,
    );

    const metas = [
      gmailMessageMetadata({ id: "msg-l1", threadId: "thread-l1", subject: "First Email", from: "a@example.com" }),
      gmailMessageMetadata({ id: "msg-l2", threadId: "thread-l2", subject: "Second Email", from: "b@example.com" }),
      gmailMessageMetadata({ id: "msg-l3", threadId: "thread-l3", subject: "Third Email", from: "c@example.com" }),
    ];

    mockFetch((url) => {
      if (url.includes("/messages?")) return jsonResponse(listBody);
      for (const meta of metas) {
        if (url.includes(meta.id)) return jsonResponse(meta);
      }
      return textResponse("Not Found", 404);
    });

    const result = await listEmails(TOKEN, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;

    // forModel: compact list
    expect(data.forModel.kind).toBe("list");
    expect(data.forModel.count).toBe(3);
    const modelItems = (data.forModel.data as { items: Array<{ id: string; subject: string }> }).items;
    expect(modelItems).toHaveLength(3);
    expect(modelItems[0].subject).toBe("First Email");

    // forUser: rich list
    expect(data.forUser.kind).toBe("list");
    const userItems = (data.forUser.data as { items: Array<{ id: string; threadId: string }> }).items;
    expect(userItems).toHaveLength(3);
    expect(userItems[0].threadId).toBe("thread-l1");
  });

  it("returns empty results for empty inbox", async () => {
    mockFetch(() => jsonResponse(gmailMessageListResponse([], undefined, 0)));

    const result = await listEmails(TOKEN, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.count).toBe(0);
    expect(data.forModel.summary).toContain("No");
    expect(data.forUser.message).toContain("No emails found");
  });

  it("handles pagination with nextPageToken", async () => {
    const listBody = gmailMessageListResponse(
      [{ id: "msg-p1", threadId: "thread-p1" }],
      "next-page-token-xyz",
      10,
    );

    const meta = gmailMessageMetadata({ id: "msg-p1", subject: "Paginated" });

    mockFetch((url) => {
      if (url.includes("/messages?")) return jsonResponse(listBody);
      if (url.includes("msg-p1")) return jsonResponse(meta);
      return textResponse("Not Found", 404);
    });

    const result = await listEmails(TOKEN, { maxResults: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const metadata = (result.value as IntegrationResult).forUser.metadata as {
      nextPageToken: string | null;
      resultSizeEstimate: number | null;
    };
    expect(metadata.nextPageToken).toBe("next-page-token-xyz");
    expect(metadata.resultSizeEstimate).toBe(10);
  });

  it("passes pageToken to the API request", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      if (url.includes("/messages?")) {
        capturedUrl = url;
        return jsonResponse(gmailMessageListResponse([]));
      }
      return textResponse("Not Found", 404);
    });

    await listEmails(TOKEN, { pageToken: "resume-token-123" });
    expect(capturedUrl).toContain("pageToken=resume-token-123");
  });

  it("passes custom labelIds to the API request", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      if (url.includes("/messages?")) {
        capturedUrl = url;
        return jsonResponse(gmailMessageListResponse([]));
      }
      return textResponse("Not Found", 404);
    });

    await listEmails(TOKEN, { labelIds: ["SENT", "IMPORTANT"] });
    expect(capturedUrl).toContain("labelIds=SENT");
    expect(capturedUrl).toContain("labelIds=IMPORTANT");
  });

  it("defaults to INBOX label when no labelIds provided", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      if (url.includes("/messages?")) {
        capturedUrl = url;
        return jsonResponse(gmailMessageListResponse([]));
      }
      return textResponse("Not Found", 404);
    });

    await listEmails(TOKEN, {});
    expect(capturedUrl).toContain("labelIds=INBOX");
  });

  it("returns error for 401 unauthorized", async () => {
    mockFetch(() => textResponse("Unauthorized", 401));

    const result = await listEmails(TOKEN, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("authentication expired");
  });

  it("returns error for 500 server error", async () => {
    mockFetch(() => textResponse("Internal Server Error", 500));

    const result = await listEmails(TOKEN, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Gmail API error (500)");
  });

  it("returns error when fetch throws (network failure)", async () => {
    mockFetch(() => {
      throw new Error("Socket timeout");
    });

    const result = await listEmails(TOKEN, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Failed to connect");
  });

  it("skips messages that fail metadata fetch", async () => {
    const listBody = gmailMessageListResponse([
      { id: "msg-good", threadId: "thread-good" },
      { id: "msg-bad", threadId: "thread-bad" },
    ]);

    const metaGood = gmailMessageMetadata({ id: "msg-good", subject: "Good" });

    mockFetch((url) => {
      if (url.includes("/messages?")) return jsonResponse(listBody);
      if (url.includes("msg-good")) return jsonResponse(metaGood);
      if (url.includes("msg-bad")) return textResponse("Error", 500);
      return textResponse("Not Found", 404);
    });

    const result = await listEmails(TOKEN, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.count).toBe(1);
  });

  it("passes maxResults to the API request", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      if (url.includes("/messages?")) {
        capturedUrl = url;
        return jsonResponse(gmailMessageListResponse([]));
      }
      return textResponse("Not Found", 404);
    });

    await listEmails(TOKEN, { maxResults: 25 });
    expect(capturedUrl).toContain("maxResults=25");
  });
});

// ---------------------------------------------------------------------------
// Dual-channel result verification (cross-cutting)
// ---------------------------------------------------------------------------

describe("Dual-channel results", () => {
  const TOKEN = "test-access-token";

  it("readEmail forModel is more compact than forUser", async () => {
    const message = gmailMessageFull({
      id: "msg-dc-001",
      subject: "Dual Channel Test",
      from: "test@example.com",
      bodyText: "This is a longer body that should only appear in the user-facing result.",
      attachments: [
        { filename: "file.pdf", mimeType: "application/pdf", size: 1000, attachmentId: "att-dc" },
      ],
    });

    mockFetch(() => jsonResponse(message));

    const result = await readEmail(TOKEN, { id: "msg-dc-001" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelJson = JSON.stringify(data.forModel.data);
    const userJson = JSON.stringify(data.forUser.data);

    // forModel should be significantly smaller (token-optimized)
    expect(modelJson.length).toBeLessThan(userJson.length);
  });

  it("searchEmails forModel items have fewer fields than forUser items", async () => {
    const listBody = gmailMessageListResponse([{ id: "msg-dc-s1", threadId: "thread-dc-s1" }]);
    const meta = gmailMessageMetadata({
      id: "msg-dc-s1",
      threadId: "thread-dc-s1",
      subject: "Search DC",
      from: "dc@example.com",
      labelIds: ["INBOX", "STARRED"],
    });

    mockFetch((url) => {
      if (url.includes("/messages?")) return jsonResponse(listBody);
      if (url.includes("msg-dc-s1")) return jsonResponse(meta);
      return textResponse("Not Found", 404);
    });

    const result = await searchEmails(TOKEN, { query: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: Array<Record<string, unknown>> }).items;
    const userItems = (data.forUser.data as { items: Array<Record<string, unknown>> }).items;

    expect(modelItems).toHaveLength(1);
    expect(userItems).toHaveLength(1);

    const modelKeys = Object.keys(modelItems[0]);
    const userKeys = Object.keys(userItems[0]);

    // forModel should have fewer keys
    expect(modelKeys.length).toBeLessThan(userKeys.length);

    // forUser should have threadId and labelIds, forModel should not
    expect(userKeys).toContain("threadId");
    expect(userKeys).toContain("labelIds");
    expect(modelKeys).not.toContain("threadId");
    expect(modelKeys).not.toContain("labelIds");
  });

  it("sendEmail forModel is compact confirmation, forUser has full details", async () => {
    mockFetch(() => jsonResponse(gmailSendResponse("sent-dc", "thread-dc")));

    const result = await sendEmail(TOKEN, {
      to: "recipient@example.com",
      subject: "DC Send Test",
      body: "Dual channel send test body.",
      cc: "cc@example.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelData = data.forModel.data as Record<string, unknown>;
    const userData = data.forUser.data as Record<string, unknown>;

    // forModel: just id, threadId, to, subject
    expect(Object.keys(modelData)).toHaveLength(4);
    expect(modelData).toHaveProperty("id");
    expect(modelData).toHaveProperty("threadId");
    expect(modelData).toHaveProperty("to");
    expect(modelData).toHaveProperty("subject");

    // forUser: includes cc, bcc, bodyPreview, sentAt, labelIds
    expect(Object.keys(userData).length).toBeGreaterThan(4);
    expect(userData).toHaveProperty("cc");
    expect(userData).toHaveProperty("bodyPreview");
    expect(userData).toHaveProperty("sentAt");
  });

  it("listEmails forModel items have fewer fields than forUser items", async () => {
    const listBody = gmailMessageListResponse([{ id: "msg-dc-l1", threadId: "thread-dc-l1" }]);
    const meta = gmailMessageMetadata({
      id: "msg-dc-l1",
      threadId: "thread-dc-l1",
      subject: "List DC",
      from: "list@example.com",
      labelIds: ["INBOX"],
    });

    mockFetch((url) => {
      if (url.includes("/messages?")) return jsonResponse(listBody);
      if (url.includes("msg-dc-l1")) return jsonResponse(meta);
      return textResponse("Not Found", 404);
    });

    const result = await listEmails(TOKEN, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: Array<Record<string, unknown>> }).items;
    const userItems = (data.forUser.data as { items: Array<Record<string, unknown>> }).items;

    const modelKeys = Object.keys(modelItems[0]);
    const userKeys = Object.keys(userItems[0]);

    expect(modelKeys.length).toBeLessThan(userKeys.length);
    expect(userKeys).toContain("threadId");
    expect(modelKeys).not.toContain("threadId");
  });

  it("all operations return IntegrationResult with forModel and forUser", async () => {
    // readEmail
    mockFetch(() => jsonResponse(gmailMessageFull()));
    const readResult = await readEmail(TOKEN, { id: "msg-001" });
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      const r = readResult.value as IntegrationResult;
      expect(r).toHaveProperty("forModel");
      expect(r).toHaveProperty("forUser");
      expect(r.forModel).toHaveProperty("kind");
      expect(r.forModel).toHaveProperty("summary");
      expect(r.forUser).toHaveProperty("kind");
      expect(r.forUser).toHaveProperty("title");
      expect(r.forUser).toHaveProperty("message");
    }

    // searchEmails
    mockFetch(() => jsonResponse(gmailMessageListResponse([])));
    const searchResult = await searchEmails(TOKEN, { query: "test" });
    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      const r = searchResult.value as IntegrationResult;
      expect(r).toHaveProperty("forModel");
      expect(r).toHaveProperty("forUser");
    }

    // sendEmail
    mockFetch(() => jsonResponse(gmailSendResponse()));
    const sendResult = await sendEmail(TOKEN, {
      to: "a@b.com",
      subject: "Test",
      body: "Body",
    });
    expect(sendResult.ok).toBe(true);
    if (sendResult.ok) {
      const r = sendResult.value as IntegrationResult;
      expect(r).toHaveProperty("forModel");
      expect(r).toHaveProperty("forUser");
    }

    // listEmails
    mockFetch(() => jsonResponse(gmailMessageListResponse([])));
    const listResult = await listEmails(TOKEN, {});
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      const r = listResult.value as IntegrationResult;
      expect(r).toHaveProperty("forModel");
      expect(r).toHaveProperty("forUser");
    }
  });
});

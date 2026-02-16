/**
 * Gmail read-email operation.
 *
 * Fetches a single email by Gmail message ID using the Gmail API.
 * Returns dual-channel IntegrationResult with compact forModel
 * (subject, from, snippet) and rich forUser (full email with body,
 * headers, and attachments list).
 */

import { ok, err, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatDetailResult, type IntegrationResult } from "../../../result";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

export interface ReadEmailParams {
  id: string;
}

interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

interface EmailCompact {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  date: string;
  hasAttachments: boolean;
}

interface EmailRich {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  body: string;
  snippet: string;
  labelIds: string[];
  attachments: EmailAttachment[];
}

/**
 * Extract a header value from the Gmail message headers array.
 */
function getHeader(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string {
  const lower = name.toLowerCase();
  const header = headers.find((h) => h.name.toLowerCase() === lower);
  return header?.value ?? "";
}

/**
 * Decode a base64url-encoded string to UTF-8 text.
 */
function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf-8");
}

/**
 * Extract the plain text body from a Gmail message payload.
 * Walks the MIME parts tree looking for text/plain, falling back to text/html.
 */
function extractBody(payload: GmailPayload): string {
  // Simple single-part message
  if (payload.body?.data && payload.mimeType === "text/plain") {
    return decodeBase64Url(payload.body.data);
  }

  if (!payload.parts || payload.parts.length === 0) {
    // Fallback: try body data even if mimeType is html
    if (payload.body?.data) {
      return decodeBase64Url(payload.body.data);
    }
    return "";
  }

  // Walk parts looking for text/plain first
  let plainText = "";
  let htmlText = "";

  for (const part of payload.parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      plainText = decodeBase64Url(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data) {
      htmlText = decodeBase64Url(part.body.data);
    } else if (part.mimeType?.startsWith("multipart/") && part.parts) {
      // Recurse into nested multipart
      const nested = extractBody(part);
      if (nested.length > 0 && plainText.length === 0) {
        plainText = nested;
      }
    }
  }

  return plainText.length > 0 ? plainText : htmlText;
}

/**
 * Extract attachment metadata from a Gmail message payload.
 */
function extractAttachments(payload: GmailPayload): EmailAttachment[] {
  const attachments: EmailAttachment[] = [];

  function walkParts(parts: GmailPayload[]): void {
    for (const part of parts) {
      if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType ?? "application/octet-stream",
          size: part.body.size ?? 0,
          attachmentId: part.body.attachmentId,
        });
      }

      if (part.parts) {
        walkParts(part.parts);
      }
    }
  }

  if (payload.parts) {
    walkParts(payload.parts);
  }

  return attachments;
}

interface GmailPayload {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: {
    data?: string;
    size?: number;
    attachmentId?: string;
  };
  parts?: GmailPayload[];
  filename?: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPayload;
}

/**
 * Read a single email by its Gmail message ID.
 */
export async function readEmail(
  accessToken: string,
  params: ReadEmailParams,
): Promise<Result<IntegrationResult, IntegrationError>> {
  const messageId = params.id.trim();
  if (messageId.length === 0) {
    return err(new IntegrationError("Email message ID must not be empty"));
  }

  const url = `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(messageId)}?format=full`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
  } catch (cause) {
    return err(
      new IntegrationError(
        "Failed to connect to Gmail API",
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  if (!response.ok) {
    const status = response.status;
    if (status === 404) {
      return err(new IntegrationError(`Email not found: ${messageId}`));
    }
    if (status === 401) {
      return err(new IntegrationError("Gmail authentication expired. Reconnect to refresh credentials."));
    }

    let detail = "";
    try {
      const body = await response.text();
      detail = body.slice(0, 200);
    } catch {
      // ignore
    }

    return err(
      new IntegrationError(`Gmail API error (${status}): ${detail || response.statusText}`),
    );
  }

  let message: GmailMessage;
  try {
    message = (await response.json()) as GmailMessage;
  } catch {
    return err(new IntegrationError("Failed to parse Gmail API response"));
  }

  const headers = message.payload?.headers ?? [];
  const subject = getHeader(headers, "Subject");
  const from = getHeader(headers, "From");
  const to = getHeader(headers, "To");
  const cc = getHeader(headers, "Cc");
  const date = getHeader(headers, "Date");
  const snippet = message.snippet ?? "";
  const body = message.payload ? extractBody(message.payload) : "";
  const attachments = message.payload ? extractAttachments(message.payload) : [];
  const labelIds = message.labelIds ?? [];

  const rawEmail = {
    id: message.id,
    threadId: message.threadId,
    subject,
    from,
    to,
    cc,
    date,
    body,
    snippet,
    labelIds,
    attachments,
  };

  const result = formatDetailResult<typeof rawEmail, EmailCompact, EmailRich>({
    entityName: "email",
    item: rawEmail,
    toModel: (item) => ({
      id: item.id,
      subject: item.subject,
      from: item.from,
      snippet: item.snippet,
      date: item.date,
      hasAttachments: item.attachments.length > 0,
    }),
    toUser: (item) => ({
      id: item.id,
      threadId: item.threadId,
      subject: item.subject,
      from: item.from,
      to: item.to,
      cc: item.cc,
      date: item.date,
      body: item.body,
      snippet: item.snippet,
      labelIds: item.labelIds,
      attachments: item.attachments,
    }),
    title: subject || "Email",
    message: `Email from ${from || "unknown"}: "${subject || "(no subject)"}"`,
    metadata: {
      threadId: message.threadId,
      labelIds,
      attachmentCount: attachments.length,
    },
  });

  return ok(result);
}

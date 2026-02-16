/**
 * Gmail send-email operation.
 *
 * Composes and sends an email via the Gmail API. Constructs an RFC 2822
 * formatted message and sends it as base64url-encoded payload.
 * Returns dual-channel IntegrationResult confirming the send with
 * compact forModel (id, threadId) and rich forUser (full send details).
 */

import { ok, err, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatDetailResult, type IntegrationResult } from "../../../result";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

export interface SendEmailParams {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}

interface SendResultCompact {
  id: string;
  threadId: string;
  to: string;
  subject: string;
}

interface SendResultRich {
  id: string;
  threadId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyPreview: string;
  labelIds: string[];
  sentAt: string;
}

interface GmailSendResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
}

/**
 * Encode a string to base64url (RFC 4648 Section 5) for the Gmail API.
 */
function toBase64Url(input: string): string {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build an RFC 2822 formatted email message string.
 */
function buildRfc2822Message(params: SendEmailParams): string {
  const lines: string[] = [];

  lines.push(`To: ${params.to}`);

  if (params.cc && params.cc.trim().length > 0) {
    lines.push(`Cc: ${params.cc.trim()}`);
  }

  if (params.bcc && params.bcc.trim().length > 0) {
    lines.push(`Bcc: ${params.bcc.trim()}`);
  }

  lines.push(`Subject: ${params.subject}`);
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("MIME-Version: 1.0");
  lines.push(""); // blank line separates headers from body
  lines.push(params.body);

  return lines.join("\r\n");
}

/**
 * Send an email via the Gmail API.
 */
export async function sendEmail(
  accessToken: string,
  params: SendEmailParams,
): Promise<Result<IntegrationResult, IntegrationError>> {
  const to = params.to.trim();
  if (to.length === 0) {
    return err(new IntegrationError("Recipient (to) must not be empty"));
  }

  const subject = params.subject.trim();
  if (subject.length === 0) {
    return err(new IntegrationError("Email subject must not be empty"));
  }

  const body = params.body;
  if (body.trim().length === 0) {
    return err(new IntegrationError("Email body must not be empty"));
  }

  const rawMessage = buildRfc2822Message({
    to,
    subject,
    body,
    cc: params.cc,
    bcc: params.bcc,
  });

  const encodedMessage = toBase64Url(rawMessage);

  const url = `${GMAIL_API_BASE}/users/me/messages/send`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ raw: encodedMessage }),
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
    if (status === 401) {
      return err(new IntegrationError("Gmail authentication expired. Reconnect to refresh credentials."));
    }

    let detail = "";
    try {
      const responseBody = await response.text();
      detail = responseBody.slice(0, 200);
    } catch {
      // ignore
    }

    return err(
      new IntegrationError(`Gmail API error (${status}): ${detail || response.statusText}`),
    );
  }

  let sendResponse: GmailSendResponse;
  try {
    sendResponse = (await response.json()) as GmailSendResponse;
  } catch {
    return err(new IntegrationError("Failed to parse Gmail send response"));
  }

  const sentAt = new Date().toISOString();
  const cc = params.cc?.trim() ?? "";
  const bcc = params.bcc?.trim() ?? "";
  const bodyPreview = body.length > 200 ? `${body.slice(0, 200)}...` : body;

  const rawResult = {
    id: sendResponse.id,
    threadId: sendResponse.threadId,
    to,
    cc,
    bcc,
    subject,
    bodyPreview,
    labelIds: sendResponse.labelIds ?? [],
    sentAt,
  };

  const result = formatDetailResult<typeof rawResult, SendResultCompact, SendResultRich>({
    entityName: "email",
    item: rawResult,
    toModel: (item) => ({
      id: item.id,
      threadId: item.threadId,
      to: item.to,
      subject: item.subject,
    }),
    toUser: (item) => ({
      id: item.id,
      threadId: item.threadId,
      to: item.to,
      cc: item.cc,
      bcc: item.bcc,
      subject: item.subject,
      bodyPreview: item.bodyPreview,
      labelIds: item.labelIds,
      sentAt: item.sentAt,
    }),
    title: `Sent: ${subject}`,
    message: `Email sent to ${to}: "${subject}"`,
    metadata: {
      sentAt,
      hasCc: cc.length > 0,
      hasBcc: bcc.length > 0,
    },
  });

  return ok(result);
}

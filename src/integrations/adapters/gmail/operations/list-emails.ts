/**
 * Gmail list-emails operation.
 *
 * Lists recent inbox emails with pagination support using the Gmail API.
 * Returns dual-channel IntegrationResult with compact forModel
 * (id, subject, from, snippet) and rich forUser (full metadata).
 */

import { ok, err, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatListResult, type IntegrationResult } from "../../../result";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_LABEL_IDS = ["INBOX"];

export interface ListEmailsParams {
  maxResults?: number;
  pageToken?: string;
  labelIds?: string[];
}

interface EmailListItemCompact {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  date: string;
}

interface EmailListItemRich {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  labelIds: string[];
}

interface GmailMessageListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailMessageMetadata {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
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
 * Fetch metadata for a single message (headers + snippet).
 */
async function fetchMessageMetadata(
  accessToken: string,
  messageId: string,
): Promise<Result<GmailMessageMetadata, IntegrationError>> {
  const url = `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`;

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
        `Failed to fetch message ${messageId}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  if (!response.ok) {
    return err(
      new IntegrationError(`Gmail API error fetching message ${messageId} (${response.status})`),
    );
  }

  try {
    const data = (await response.json()) as GmailMessageMetadata;
    return ok(data);
  } catch {
    return err(new IntegrationError(`Failed to parse Gmail response for message ${messageId}`));
  }
}

/**
 * List recent inbox emails with pagination.
 */
export async function listEmails(
  accessToken: string,
  params: ListEmailsParams,
): Promise<Result<IntegrationResult, IntegrationError>> {
  const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;
  const labelIds = params.labelIds ?? DEFAULT_LABEL_IDS;

  const searchParams = new URLSearchParams({
    maxResults: String(maxResults),
  });

  for (const labelId of labelIds) {
    searchParams.append("labelIds", labelId);
  }

  if (params.pageToken) {
    searchParams.set("pageToken", params.pageToken);
  }

  const url = `${GMAIL_API_BASE}/users/me/messages?${searchParams.toString()}`;

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

  let listResponse: GmailMessageListResponse;
  try {
    listResponse = (await response.json()) as GmailMessageListResponse;
  } catch {
    return err(new IntegrationError("Failed to parse Gmail list response"));
  }

  const messageRefs = listResponse.messages ?? [];

  // Fetch metadata for each message in parallel
  const metadataResults = await Promise.all(
    messageRefs.map((ref) => fetchMessageMetadata(accessToken, ref.id)),
  );

  const emails: EmailListItemRich[] = [];
  for (const metaResult of metadataResults) {
    if (!metaResult.ok) {
      // Skip messages that fail to load metadata
      continue;
    }

    const meta = metaResult.value;
    const headers = meta.payload?.headers ?? [];

    emails.push({
      id: meta.id,
      threadId: meta.threadId,
      subject: getHeader(headers, "Subject"),
      from: getHeader(headers, "From"),
      to: getHeader(headers, "To"),
      date: getHeader(headers, "Date"),
      snippet: meta.snippet ?? "",
      labelIds: meta.labelIds ?? [],
    });
  }

  const labelLabel = labelIds.join(", ");

  const result = formatListResult<EmailListItemRich, EmailListItemCompact, EmailListItemRich>({
    entityName: "emails",
    items: emails,
    toModel: (item) => ({
      id: item.id,
      subject: item.subject,
      from: item.from,
      snippet: item.snippet,
      date: item.date,
    }),
    toUser: (item) => item,
    title: `Emails in ${labelLabel}`,
    emptyMessage: `No emails found in ${labelLabel}.`,
    metadata: {
      labelIds,
      maxResults,
      nextPageToken: listResponse.nextPageToken ?? null,
      resultSizeEstimate: listResponse.resultSizeEstimate ?? null,
    },
  });

  return ok(result);
}

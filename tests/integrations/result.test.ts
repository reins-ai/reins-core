import { describe, expect, it } from "bun:test";

import {
  formatDetailResult,
  formatErrorResult,
  formatListResult,
  type IntegrationResult,
} from "../../src/integrations/result";

type RawEmail = {
  id: string;
  subject: string;
  from: string;
  body: string;
  html: string;
  headers: Record<string, string>;
  attachments: Array<{ name: string; size: number; mimeType: string }>;
};

function createRawEmail(index: number): RawEmail {
  return {
    id: `email-${index}`,
    subject: `Project update ${index}`,
    from: `sender-${index}@example.com`,
    body: `Body ${index}: ${"long message ".repeat(30)}`,
    html: `<p>${"rich html content ".repeat(30)}</p>`,
    headers: {
      "x-thread-id": `thread-${index}`,
      "x-mailer": "reins-mail",
      "x-debug": "trace-enabled",
    },
    attachments: [
      {
        name: `report-${index}.pdf`,
        size: 250_000,
        mimeType: "application/pdf",
      },
      {
        name: `diagram-${index}.png`,
        size: 80_000,
        mimeType: "image/png",
      },
    ],
  };
}

function sizeOf(value: unknown): number {
  return JSON.stringify(value).length;
}

describe("formatListResult", () => {
  it("creates compact forModel and rich forUser channels", () => {
    const rawEmails = [createRawEmail(1), createRawEmail(2)];

    const result = formatListResult({
      entityName: "emails",
      items: rawEmails,
      toModel: (email) => ({
        id: email.id,
        subject: email.subject,
        from: email.from,
      }),
      toUser: (email) => ({
        ...email,
        preview: email.body.slice(0, 80),
      }),
      title: "Inbox",
      metadata: {
        integrationId: "adapter-alpha",
        page: 1,
      },
    });

    expect(result.forModel.kind).toBe("list");
    expect(result.forModel.count).toBe(2);
    expect(result.forModel.summary).toBe("2 emails");
    expect(result.forModel.data).toEqual({
      items: [
        {
          id: "email-1",
          subject: "Project update 1",
          from: "sender-1@example.com",
        },
        {
          id: "email-2",
          subject: "Project update 2",
          from: "sender-2@example.com",
        },
      ],
    });

    expect(result.forUser.kind).toBe("list");
    expect(result.forUser.title).toBe("Inbox");
    expect(result.forUser.message).toBe("2 emails found.");
    expect(result.forUser.metadata).toEqual({
      integrationId: "adapter-alpha",
      page: 1,
    });
    expect(result.forUser.data).toBeDefined();
  });

  it("keeps forModel at 50% or less of equivalent raw response", () => {
    const rawEmails = [createRawEmail(1), createRawEmail(2), createRawEmail(3)];
    const rawResponse = {
      items: rawEmails,
      nextPageToken: "next-page-token",
      requestMeta: {
        provider: "adapter-alpha",
        receivedAt: "2026-02-16T12:00:00.000Z",
        latencyMs: 238,
        trace: "full payload captured",
      },
    };

    const result = formatListResult({
      entityName: "emails",
      items: rawEmails,
      toModel: (email) => ({
        id: email.id,
        subject: email.subject,
      }),
    });

    const rawSize = sizeOf(rawResponse);
    const forModelSize = sizeOf(result.forModel);
    const ratio = forModelSize / rawSize;

    expect(ratio).toBeLessThanOrEqual(0.5);
  });

  it("supports empty list formatting", () => {
    const result = formatListResult({
      entityName: "notes",
      items: [],
      toModel: (note: { id: string }) => ({ id: note.id }),
      emptyMessage: "No notes in this folder.",
    });

    expect(result.forModel.summary).toBe("No notes.");
    expect(result.forUser.message).toBe("No notes in this folder.");
  });
});

describe("formatDetailResult", () => {
  it("formats detail result with dual channels", () => {
    const rawEmail = createRawEmail(42);
    const result = formatDetailResult({
      entityName: "email",
      item: rawEmail,
      toModel: (email) => ({
        id: email.id,
        subject: email.subject,
      }),
      toUser: (email) => ({
        ...email,
        renderedAt: "2026-02-16T12:00:00.000Z",
      }),
      metadata: {
        integrationId: "adapter-alpha",
      },
    });

    expect(result.forModel.kind).toBe("detail");
    expect(result.forModel.data).toEqual({
      id: "email-42",
      subject: "Project update 42",
    });
    expect(result.forUser.kind).toBe("detail");
    expect(result.forUser.title).toBe("Email Details");
    expect(result.forUser.metadata).toEqual({ integrationId: "adapter-alpha" });
  });
});

describe("formatErrorResult", () => {
  it("creates compact model error and rich user error", () => {
    const result = formatErrorResult(new Error("OAuth token expired"), {
      code: "AUTH_EXPIRED",
      title: "Authentication Required",
      metadata: {
        integrationId: "adapter-alpha",
      },
      retryable: true,
    });

    expect(result.forModel.kind).toBe("error");
    expect(result.forModel.error).toEqual({
      code: "AUTH_EXPIRED",
      message: "OAuth token expired",
    });

    expect(result.forUser.kind).toBe("error");
    expect(result.forUser.title).toBe("Authentication Required");
    expect(result.forUser.message).toBe("OAuth token expired");
    expect(result.forUser.metadata).toEqual({
      integrationId: "adapter-alpha",
      retryable: true,
    });
    expect(result.forUser.data).toBeNull();
  });
});

describe("IntegrationResult type", () => {
  it("supports typed forModel and forUser payloads", () => {
    const typedResult: IntegrationResult<{ ids: string[] }, { items: RawEmail[] }> = {
      forModel: {
        kind: "list",
        summary: "2 emails",
        data: {
          ids: ["email-1", "email-2"],
        },
      },
      forUser: {
        kind: "list",
        title: "Inbox",
        message: "2 emails found.",
        data: {
          items: [createRawEmail(1), createRawEmail(2)],
        },
      },
    };

    expect(typedResult.forModel.data?.ids).toEqual(["email-1", "email-2"]);
    expect(typedResult.forUser.data?.items).toHaveLength(2);
  });
});

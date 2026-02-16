/**
 * Gmail operations barrel export.
 *
 * Re-exports all four Gmail operations:
 * read-email, search-emails, send-email, list-emails.
 */

export { readEmail, type ReadEmailParams } from "./read-email";
export { searchEmails, type SearchEmailsParams } from "./search-emails";
export { sendEmail, type SendEmailParams } from "./send-email";
export { listEmails, type ListEmailsParams } from "./list-emails";

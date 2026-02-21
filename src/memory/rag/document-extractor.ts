import { extname } from "node:path";

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { read as readWorkbook, utils as xlsxUtils } from "xlsx";

import { err, ok, type Result } from "../../result";
import { MemoryError } from "../services/memory-error";

export const MAX_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024;
const SIZE_LIMIT_LABEL = "50MB";
const SNIFF_BYTE_LIMIT = 4096;

export const DOCUMENT_FORMATS = ["pdf", "docx", "csv", "xlsx", "html", "text"] as const;

export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export interface ExtractedDocument {
  content: string;
  format: DocumentFormat;
  metadata: {
    pageCount?: number;
    wordCount: number;
  };
}

export interface DocumentExtractorFileSystem {
  getSize(filePath: string): Promise<number>;
  readSample(filePath: string, maxBytes: number): Promise<Uint8Array>;
  readText(filePath: string): Promise<string>;
  readBytes(filePath: string): Promise<Uint8Array>;
}

interface PdfExtractionResult {
  text: string;
  pageCount?: number;
}

interface XlsxSheetData {
  name: string;
  csv: string;
}

export interface DocumentExtractorAdapters {
  extractPdf(bytes: Uint8Array): Promise<PdfExtractionResult>;
  extractDocx(bytes: Uint8Array): Promise<string>;
  extractXlsxSheets(bytes: Uint8Array): Promise<XlsxSheetData[]>;
}

export interface DocumentExtractorOptions {
  fileSystem?: DocumentExtractorFileSystem;
  adapters?: Partial<DocumentExtractorAdapters>;
}

class BunDocumentExtractorFileSystem implements DocumentExtractorFileSystem {
  async getSize(filePath: string): Promise<number> {
    return await Bun.file(filePath).size;
  }

  async readSample(filePath: string, maxBytes: number): Promise<Uint8Array> {
    const bytes = await Bun.file(filePath).slice(0, maxBytes).arrayBuffer();
    return new Uint8Array(bytes);
  }

  async readText(filePath: string): Promise<string> {
    return await Bun.file(filePath).text();
  }

  async readBytes(filePath: string): Promise<Uint8Array> {
    const bytes = await Bun.file(filePath).arrayBuffer();
    return new Uint8Array(bytes);
  }
}

const defaultAdapters: DocumentExtractorAdapters = {
  async extractPdf(bytes) {
    const parser = new PDFParse({ data: bytes });
    try {
      const parsed = await parser.getText();
      return {
        text: parsed.text ?? "",
        pageCount: typeof parsed.total === "number" ? parsed.total : undefined,
      };
    } finally {
      await parser.destroy();
    }
  },
  async extractDocx(bytes) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return result.value;
  },
  async extractXlsxSheets(bytes) {
    const workbook = readWorkbook(bytes, { type: "array" });
    return workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const csv = sheet ? xlsxUtils.sheet_to_csv(sheet, { blankrows: false }) : "";
      return { name, csv };
    });
  },
};

function countWords(content: string): number {
  const words = content.trim().match(/\S+/g);
  return words?.length ?? 0;
}

function normalizeWhitespace(content: string): string {
  return content.replace(/\r/g, "").trim();
}

function detectFormatFromExtension(filePath: string): DocumentFormat | null {
  const extension = extname(filePath).toLowerCase();
  switch (extension) {
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    case ".csv":
      return "csv";
    case ".xlsx":
      return "xlsx";
    case ".html":
    case ".htm":
      return "html";
    case ".txt":
    case ".md":
    case ".markdown":
      return "text";
    default:
      return null;
  }
}

function startsWithBytes(input: Uint8Array, prefix: number[]): boolean {
  if (input.length < prefix.length) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    if (input[index] !== prefix[index]) {
      return false;
    }
  }

  return true;
}

function looksLikeCsv(sampleText: string): boolean {
  const lines = sampleText
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);

  if (lines.length === 0) {
    return false;
  }

  const firstLineFields = parseCsvLine(lines[0]);
  if (firstLineFields.length < 2) {
    return false;
  }

  if (lines.length === 1) {
    return true;
  }

  const secondLineFields = parseCsvLine(lines[1]);
  return secondLineFields.length === firstLineFields.length;
}

function detectFormatFromContent(sample: Uint8Array): DocumentFormat {
  if (startsWithBytes(sample, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "pdf";
  }

  if (startsWithBytes(sample, [0x50, 0x4b])) {
    const zipText = new TextDecoder().decode(sample).toLowerCase();
    if (zipText.includes("word/")) {
      return "docx";
    }
    if (zipText.includes("xl/")) {
      return "xlsx";
    }
  }

  const sampleText = new TextDecoder().decode(sample);
  const normalized = sampleText.trimStart().toLowerCase();
  if (normalized.startsWith("<!doctype html") || normalized.startsWith("<html")) {
    return "html";
  }

  if (looksLikeCsv(sampleText)) {
    return "csv";
  }

  return "text";
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").trim();
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      fields.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  fields.push(current);
  return fields;
}

function csvToMarkdownTable(input: string): string {
  const lines = input
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return "";
  }

  const rows = lines.map(parseCsvLine);
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const normalizedRows = rows.map((row) => {
    const padded = row.slice(0);
    while (padded.length < columnCount) {
      padded.push("");
    }
    return padded.map(escapeMarkdownCell);
  });

  const header = normalizedRows[0];
  const separator = header.map((value) => "-".repeat(Math.max(3, value.length + 2)));
  const body = normalizedRows.slice(1);

  const output = [
    `| ${header.join(" | ")} |`,
    `|${separator.join("|")}|`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ];

  return output.join("\n");
}

function xlsxSheetsToMarkdown(sheets: XlsxSheetData[]): string {
  const sections: string[] = [];

  for (const sheet of sheets) {
    const markdownTable = csvToMarkdownTable(sheet.csv);
    if (!markdownTable) {
      continue;
    }

    sections.push(`## Sheet: ${sheet.name}`);
    sections.push(markdownTable);
  }

  return sections.join("\n\n");
}

function decodeHtmlEntities(content: string): string {
  const entities: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
  };

  let result = content;
  for (const [entity, replacement] of Object.entries(entities)) {
    result = result.replaceAll(entity, replacement);
  }

  return result;
}

function htmlToText(html: string): string {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, " ");
  const withoutScripts = withoutComments
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");

  const withLineBreaks = withoutScripts
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n");

  const withoutTags = withLineBreaks.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(withoutTags);

  return decoded
    .replace(/\r/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class DocumentExtractor {
  private readonly fileSystem: DocumentExtractorFileSystem;
  private readonly adapters: DocumentExtractorAdapters;

  constructor(options?: DocumentExtractorOptions) {
    this.fileSystem = options?.fileSystem ?? new BunDocumentExtractorFileSystem();
    this.adapters = {
      ...defaultAdapters,
      ...options?.adapters,
    };
  }

  async extract(filePath: string): Promise<Result<ExtractedDocument, MemoryError>> {
    try {
      const size = await this.fileSystem.getSize(filePath);
      if (size > MAX_DOCUMENT_SIZE_BYTES) {
        return err(
          new MemoryError(
            `Document exceeds ${SIZE_LIMIT_LABEL} hard limit: ${filePath}`,
            "MEMORY_DB_ERROR",
          ),
        );
      }

      const formatResult = await this.detectFormat(filePath);
      if (!formatResult.ok) {
        return err(formatResult.error);
      }

      const format = formatResult.value;
      switch (format) {
        case "pdf": {
          const bytes = await this.fileSystem.readBytes(filePath);
          const extracted = await this.adapters.extractPdf(bytes);
          const content = normalizeWhitespace(extracted.text);
          return ok({
            content,
            format,
            metadata: {
              pageCount: extracted.pageCount,
              wordCount: countWords(content),
            },
          });
        }

        case "docx": {
          const bytes = await this.fileSystem.readBytes(filePath);
          const extracted = await this.adapters.extractDocx(bytes);
          const content = normalizeWhitespace(extracted);
          return ok({
            content,
            format,
            metadata: {
              wordCount: countWords(content),
            },
          });
        }

        case "csv": {
          const text = await this.fileSystem.readText(filePath);
          const content = csvToMarkdownTable(text);
          return ok({
            content,
            format,
            metadata: {
              wordCount: countWords(content),
            },
          });
        }

        case "xlsx": {
          const bytes = await this.fileSystem.readBytes(filePath);
          const sheets = await this.adapters.extractXlsxSheets(bytes);
          const content = xlsxSheetsToMarkdown(sheets);
          return ok({
            content,
            format,
            metadata: {
              wordCount: countWords(content),
            },
          });
        }

        case "html": {
          const html = await this.fileSystem.readText(filePath);
          const content = htmlToText(html);
          return ok({
            content,
            format,
            metadata: {
              wordCount: countWords(content),
            },
          });
        }

        case "text": {
          const content = await this.fileSystem.readText(filePath);
          return ok({
            content,
            format,
            metadata: {
              wordCount: countWords(content),
            },
          });
        }
      }
    } catch (error) {
      return err(
        new MemoryError(
          `Failed to extract document content: ${filePath}`,
          "MEMORY_DB_ERROR",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  private async detectFormat(filePath: string): Promise<Result<DocumentFormat, MemoryError>> {
    const byExtension = detectFormatFromExtension(filePath);
    if (byExtension) {
      return ok(byExtension);
    }

    try {
      const sample = await this.fileSystem.readSample(filePath, SNIFF_BYTE_LIMIT);
      return ok(detectFormatFromContent(sample));
    } catch (error) {
      return err(
        new MemoryError(
          `Failed to detect document format: ${filePath}`,
          "MEMORY_DB_ERROR",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }
}

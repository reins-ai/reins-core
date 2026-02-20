import { describe, expect, it } from "bun:test";

import {
  DocumentExtractor,
  MAX_DOCUMENT_SIZE_BYTES,
  type DocumentExtractorAdapters,
  type DocumentExtractorFileSystem,
} from "../../../src/memory/rag/document-extractor";

const encoder = new TextEncoder();

interface MockFile {
  size: number;
  sample?: Uint8Array;
  text?: string;
  bytes?: Uint8Array;
}

class MockDocumentExtractorFileSystem implements DocumentExtractorFileSystem {
  readonly reads = {
    text: 0,
    bytes: 0,
    sample: 0,
  };

  private readonly files: Map<string, MockFile>;

  constructor(files: Record<string, MockFile>) {
    this.files = new Map(Object.entries(files));
  }

  async getSize(filePath: string): Promise<number> {
    const file = this.requireFile(filePath);
    return file.size;
  }

  async readSample(filePath: string, maxBytes: number): Promise<Uint8Array> {
    this.reads.sample += 1;
    const file = this.requireFile(filePath);
    const sample = file.sample ?? file.bytes ?? (file.text ? encoder.encode(file.text) : new Uint8Array());
    return sample.slice(0, maxBytes);
  }

  async readText(filePath: string): Promise<string> {
    this.reads.text += 1;
    const file = this.requireFile(filePath);
    if (typeof file.text === "string") {
      return file.text;
    }

    if (file.bytes) {
      return new TextDecoder().decode(file.bytes);
    }

    return "";
  }

  async readBytes(filePath: string): Promise<Uint8Array> {
    this.reads.bytes += 1;
    const file = this.requireFile(filePath);
    if (file.bytes) {
      return file.bytes;
    }

    if (typeof file.text === "string") {
      return encoder.encode(file.text);
    }

    return new Uint8Array();
  }

  private requireFile(filePath: string): MockFile {
    const file = this.files.get(filePath);
    if (!file) {
      throw new Error(`Missing mock file: ${filePath}`);
    }
    return file;
  }
}

function createExtractor(options?: {
  files?: Record<string, MockFile>;
  adapters?: Partial<DocumentExtractorAdapters>;
}) {
  const fileSystem = new MockDocumentExtractorFileSystem(options?.files ?? {});
  const extractor = new DocumentExtractor({
    fileSystem,
    adapters: {
      extractPdf: async () => ({ text: "pdf content", pageCount: 3 }),
      extractDocx: async () => "docx content",
      extractXlsxSheets: async () => [
        {
          name: "Sheet1",
          csv: "name,score\nAlice,10",
        },
      ],
      ...options?.adapters,
    },
  });

  return { extractor, fileSystem };
}

describe("DocumentExtractor", () => {
  it("rejects files larger than 50MB before reading content", async () => {
    const filePath = "/tmp/too-large.pdf";
    const { extractor, fileSystem } = createExtractor({
      files: {
        [filePath]: {
          size: MAX_DOCUMENT_SIZE_BYTES + 1,
          bytes: encoder.encode("%PDF-1.7"),
        },
      },
    });

    const result = await extractor.extract(filePath);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.message).toContain("50MB");
    expect(fileSystem.reads.sample).toBe(0);
    expect(fileSystem.reads.bytes).toBe(0);
    expect(fileSystem.reads.text).toBe(0);
  });

  it("extracts PDF content and page metadata by extension", async () => {
    const filePath = "/docs/file.pdf";
    const { extractor } = createExtractor({
      files: {
        [filePath]: {
          size: 1024,
          bytes: encoder.encode("%PDF-1.7 mock"),
        },
      },
      adapters: {
        extractPdf: async () => ({ text: "hello from pdf", pageCount: 2 }),
      },
    });

    const result = await extractor.extract(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.format).toBe("pdf");
    expect(result.value.content).toBe("hello from pdf");
    expect(result.value.metadata.pageCount).toBe(2);
    expect(result.value.metadata.wordCount).toBe(3);
  });

  it("falls back to content sniffing for unknown extension", async () => {
    const filePath = "/docs/upload.bin";
    const pdfHeader = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

    const { extractor } = createExtractor({
      files: {
        [filePath]: {
          size: 64,
          sample: pdfHeader,
          bytes: pdfHeader,
        },
      },
      adapters: {
        extractPdf: async () => ({ text: "sniffed pdf", pageCount: 1 }),
      },
    });

    const result = await extractor.extract(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.format).toBe("pdf");
    expect(result.value.content).toBe("sniffed pdf");
    expect(result.value.metadata.pageCount).toBe(1);
  });

  it("extracts DOCX content via adapter", async () => {
    const filePath = "/docs/notes.docx";
    const { extractor } = createExtractor({
      files: {
        [filePath]: {
          size: 2048,
          bytes: encoder.encode("PK...word/document.xml"),
        },
      },
      adapters: {
        extractDocx: async () => "docx paragraph one\n\ndocx paragraph two",
      },
    });

    const result = await extractor.extract(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.format).toBe("docx");
    expect(result.value.content).toContain("docx paragraph one");
    expect(result.value.metadata.wordCount).toBe(6);
  });

  it("converts CSV into markdown table format", async () => {
    const filePath = "/docs/people.csv";
    const { extractor } = createExtractor({
      files: {
        [filePath]: {
          size: 128,
          text: "name,age,city\nAlice,30,NYC",
        },
      },
    });

    const result = await extractor.extract(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.format).toBe("csv");
    expect(result.value.content).toBe(
      "| name | age | city |\n|------|-----|------|\n| Alice | 30 | NYC |",
    );
  });

  it("converts XLSX sheets to markdown tables", async () => {
    const filePath = "/docs/report.xlsx";
    const { extractor } = createExtractor({
      files: {
        [filePath]: {
          size: 1024,
          bytes: encoder.encode("PK...xl/workbook.xml"),
        },
      },
      adapters: {
        extractXlsxSheets: async () => [
          {
            name: "Q1",
            csv: "metric,value\nrevenue,120",
          },
          {
            name: "Q2",
            csv: "metric,value\nrevenue,160",
          },
        ],
      },
    });

    const result = await extractor.extract(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.format).toBe("xlsx");
    expect(result.value.content).toContain("## Sheet: Q1");
    expect(result.value.content).toContain("| metric | value |");
    expect(result.value.content).toContain("| revenue | 160 |");
  });

  it("strips HTML tags and returns plain text", async () => {
    const filePath = "/docs/page.html";
    const { extractor } = createExtractor({
      files: {
        [filePath]: {
          size: 256,
          text: "<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>",
        },
      },
    });

    const result = await extractor.extract(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.format).toBe("html");
    expect(result.value.content).toContain("Title");
    expect(result.value.content).toContain("Hello world");
    expect(result.value.content.includes("<h1>")).toBe(false);
  });

  it("passes through plain text unchanged", async () => {
    const filePath = "/docs/plain.txt";
    const text = "line one\nline two\n";

    const { extractor } = createExtractor({
      files: {
        [filePath]: {
          size: 32,
          text,
        },
      },
    });

    const result = await extractor.extract(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.format).toBe("text");
    expect(result.value.content).toBe(text);
    expect(result.value.metadata.wordCount).toBe(4);
  });

  it("sniffs unknown text as CSV when delimiter pattern matches", async () => {
    const filePath = "/docs/data.unknown";
    const csvText = "feature,status\nrag,done";

    const { extractor } = createExtractor({
      files: {
        [filePath]: {
          size: csvText.length,
          sample: encoder.encode(csvText),
          text: csvText,
        },
      },
    });

    const result = await extractor.extract(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.format).toBe("csv");
    expect(result.value.content).toContain("| feature | status |");
  });
});

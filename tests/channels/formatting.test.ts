import { describe, expect, it } from "bun:test";

import {
  chunkDiscordMessage,
  createDiscordEmbed,
  formatForDiscord,
  formatForTelegram,
} from "../../src/channels/formatting";

describe("formatForTelegram", () => {
  it("returns empty string for empty input", () => {
    expect(formatForTelegram("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(formatForTelegram("   ")).toBe("");
    expect(formatForTelegram("\n\n")).toBe("");
  });

  it("escapes MarkdownV2 special characters in plain text", () => {
    const result = formatForTelegram("Hello. How are you? Price is $10!");
    expect(result).toContain("\\.");
    expect(result).toContain("\\!");
  });

  it("escapes all 16 MarkdownV2 reserved characters", () => {
    const input = "_ * [ ] ( ) ~ ` > # + - = | { } . !";
    const result = formatForTelegram(input);
    expect(result).toContain("\\_");
    expect(result).toContain("\\*");
    expect(result).toContain("\\[");
    expect(result).toContain("\\]");
    expect(result).toContain("\\(");
    expect(result).toContain("\\)");
    expect(result).toContain("\\~");
    expect(result).toContain("\\`");
    expect(result).toContain("\\>");
    expect(result).toContain("\\#");
    expect(result).toContain("\\+");
    expect(result).toContain("\\-");
    expect(result).toContain("\\=");
    expect(result).toContain("\\|");
    expect(result).toContain("\\{");
    expect(result).toContain("\\}");
    expect(result).toContain("\\.");
    expect(result).toContain("\\!");
  });

  it("converts bold markers from ** to *", () => {
    const result = formatForTelegram("This is **bold** text");
    expect(result).toContain("*bold*");
    expect(result).not.toContain("**");
  });

  it("converts single-asterisk italic to underscore italic", () => {
    const result = formatForTelegram("This is *italic* text");
    expect(result).toContain("_italic_");
  });

  it("converts underscore italic and preserves it", () => {
    const result = formatForTelegram("This is _italic_ text");
    expect(result).toContain("_italic_");
  });

  it("converts strikethrough from ~~ to ~", () => {
    const result = formatForTelegram("This is ~~deleted~~ text");
    expect(result).toContain("~deleted~");
    expect(result).not.toContain("~~");
  });

  it("preserves fenced code blocks without escaping content", () => {
    const input = "Before\n```javascript\nconst x = 1 + 2;\nconsole.log(x);\n```\nAfter";
    const result = formatForTelegram(input);
    expect(result).toContain("```javascript\nconst x = 1 + 2;\nconsole.log(x);\n```");
  });

  it("preserves inline code without escaping content", () => {
    const input = "Use `console.log()` for debugging";
    const result = formatForTelegram(input);
    expect(result).toContain("`console.log()`");
  });

  it("converts markdown links with proper escaping", () => {
    const input = "Visit [Google](https://google.com) for search";
    const result = formatForTelegram(input);
    // The link should be preserved intact
    expect(result).toContain("[Google](https://google.com)");
    // Surrounding text should have special chars escaped
    expect(result).toMatch(/\[Google\]\(https:\/\/google\.com\)/);
  });

  it("converts unordered list markers to bullet characters", () => {
    const input = "Items:\n- First\n- Second\n- Third";
    const result = formatForTelegram(input);
    expect(result).toContain("• First");
    expect(result).toContain("• Second");
    expect(result).toContain("• Third");
  });

  it("converts asterisk list markers to bullet characters", () => {
    const input = "Items:\n* First\n* Second";
    const result = formatForTelegram(input);
    expect(result).toContain("• First");
    expect(result).toContain("• Second");
  });

  it("handles mixed formatting in a single message", () => {
    const input = "**Bold** and *italic* with `code` and a [link](https://example.com)";
    const result = formatForTelegram(input);
    expect(result).toContain("*Bold*");
    expect(result).toContain("_italic_");
    expect(result).toContain("`code`");
    expect(result).toContain("[link](https://example.com)");
  });

  it("handles code blocks with special characters inside", () => {
    const input = "```\nif (x > 0) { return x * 2; }\n```";
    const result = formatForTelegram(input);
    // Content inside code block should NOT be escaped
    expect(result).toContain("if (x > 0) { return x * 2; }");
    expect(result).not.toContain("\\{");
  });

  it("handles multiple code blocks in one message", () => {
    const input = "First:\n```\ncode1\n```\nMiddle text.\n```\ncode2\n```\nEnd.";
    const result = formatForTelegram(input);
    expect(result).toContain("```\ncode1\n```");
    expect(result).toContain("```\ncode2\n```");
    expect(result).toContain("\\.");
  });

  it("escapes special characters in bold text content", () => {
    const result = formatForTelegram("**hello.world!**");
    expect(result).toContain("*hello\\.world\\!*");
  });

  it("handles backslash characters", () => {
    const result = formatForTelegram("path\\to\\file");
    expect(result).toContain("\\\\");
  });

  it("handles parentheses in regular text", () => {
    const result = formatForTelegram("function(arg)");
    expect(result).toContain("\\(");
    expect(result).toContain("\\)");
  });

  it("handles URLs with special characters in links", () => {
    const input = "[docs](https://example.com/path?q=1&b=2)";
    const result = formatForTelegram(input);
    expect(result).toContain("[docs]");
    expect(result).toContain("https://example.com/path?q=1&b=2");
  });
});

describe("formatForDiscord", () => {
  it("returns empty string for empty input", () => {
    expect(formatForDiscord("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(formatForDiscord("   ")).toBe("");
    expect(formatForDiscord("\n\n")).toBe("");
  });

  it("passes through standard markdown unchanged", () => {
    const input = "**bold** and *italic* text";
    expect(formatForDiscord(input)).toBe(input);
  });

  it("preserves code blocks with language hints", () => {
    const input = "```typescript\nconst x = 1;\n```";
    expect(formatForDiscord(input)).toBe(input);
  });

  it("preserves inline code", () => {
    const input = "Use `console.log()` for debugging";
    expect(formatForDiscord(input)).toBe(input);
  });

  it("preserves markdown links", () => {
    const input = "Visit [Google](https://google.com)";
    expect(formatForDiscord(input)).toBe(input);
  });

  it("preserves strikethrough syntax", () => {
    const input = "This is ~~deleted~~ text";
    expect(formatForDiscord(input)).toBe(input);
  });

  it("preserves Discord underline syntax", () => {
    const input = "This is __underlined__ text";
    expect(formatForDiscord(input)).toBe(input);
  });

  it("preserves spoiler syntax", () => {
    const input = "This is ||spoiler|| text";
    expect(formatForDiscord(input)).toBe(input);
  });

  it("preserves unordered lists", () => {
    const input = "- Item 1\n- Item 2\n- Item 3";
    expect(formatForDiscord(input)).toBe(input);
  });

  it("converts HTML anchor tags to markdown links", () => {
    const input = 'Check <a href="https://example.com">this link</a> out';
    const result = formatForDiscord(input);
    expect(result).toContain("[this link](https://example.com)");
  });

  it("handles multiple HTML links", () => {
    const input = '<a href="https://a.com">A</a> and <a href="https://b.com">B</a>';
    const result = formatForDiscord(input);
    expect(result).toContain("[A](https://a.com)");
    expect(result).toContain("[B](https://b.com)");
  });

  it("preserves complex markdown with multiple features", () => {
    const input = "# Header\n\n**Bold** and *italic*\n\n```js\ncode()\n```\n\n- List item";
    expect(formatForDiscord(input)).toBe(input);
  });
});

describe("chunkDiscordMessage", () => {
  it("returns single chunk for short messages", () => {
    const result = chunkDiscordMessage("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  it("returns single chunk for exactly 2000 characters", () => {
    const text = "a".repeat(2000);
    const result = chunkDiscordMessage(text);
    expect(result).toEqual([text]);
  });

  it("splits long messages into multiple chunks", () => {
    const text = "a".repeat(3000);
    const result = chunkDiscordMessage(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join("").length).toBe(3000);
  });

  it("prefers splitting at line boundaries", () => {
    const line = "a".repeat(100);
    const lines = Array.from({ length: 25 }, () => line);
    const text = lines.join("\n");
    const result = chunkDiscordMessage(text);

    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it("prefers splitting at space boundaries when no newlines", () => {
    const word = "word ";
    const text = word.repeat(500);
    const result = chunkDiscordMessage(text);

    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it("hard splits when no good boundary found", () => {
    const text = "a".repeat(5000);
    const result = chunkDiscordMessage(text);

    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    expect(result.join("").length).toBe(5000);
  });

  it("respects custom max length", () => {
    const text = "a".repeat(100);
    const result = chunkDiscordMessage(text, 30);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });

  it("handles empty string", () => {
    const result = chunkDiscordMessage("");
    expect(result).toEqual([""]);
  });

  it("preserves all content across chunks", () => {
    const text = "Line 1\nLine 2\nLine 3\n" + "x".repeat(3000);
    const result = chunkDiscordMessage(text);
    const reassembled = result.join("");
    // Allow for stripped newlines at chunk boundaries
    expect(reassembled.length).toBeGreaterThanOrEqual(text.length - result.length);
  });
});

describe("createDiscordEmbed", () => {
  it("returns null for empty content", () => {
    expect(createDiscordEmbed("")).toBeNull();
  });

  it("returns null for whitespace-only content", () => {
    expect(createDiscordEmbed("   ")).toBeNull();
    expect(createDiscordEmbed("\n\n")).toBeNull();
  });

  it("creates embed with description and default color", () => {
    const embed = createDiscordEmbed("Hello world");
    expect(embed).not.toBeNull();
    expect(embed!.description).toBe("Hello world");
    expect(embed!.color).toBe(0x5865f2);
  });

  it("creates embed with custom title", () => {
    const embed = createDiscordEmbed("Content", { title: "My Title" });
    expect(embed).not.toBeNull();
    expect(embed!.title).toBe("My Title");
    expect(embed!.description).toBe("Content");
  });

  it("creates embed with custom color", () => {
    const embed = createDiscordEmbed("Content", { color: 0xff0000 });
    expect(embed).not.toBeNull();
    expect(embed!.color).toBe(0xff0000);
  });

  it("creates embed with footer", () => {
    const embed = createDiscordEmbed("Content", { footer: "Powered by Reins" });
    expect(embed).not.toBeNull();
    expect(embed!.footer).toEqual({ text: "Powered by Reins" });
  });

  it("creates embed with timestamp", () => {
    const embed = createDiscordEmbed("Content", { timestamp: true });
    expect(embed).not.toBeNull();
    expect(embed!.timestamp).toBeDefined();
    // Should be a valid ISO string
    expect(new Date(embed!.timestamp!).toISOString()).toBe(embed!.timestamp);
  });

  it("does not include timestamp when not requested", () => {
    const embed = createDiscordEmbed("Content");
    expect(embed).not.toBeNull();
    expect(embed!.timestamp).toBeUndefined();
  });

  it("truncates description exceeding 4096 characters", () => {
    const longContent = "a".repeat(5000);
    const embed = createDiscordEmbed(longContent);
    expect(embed).not.toBeNull();
    expect(embed!.description!.length).toBeLessThanOrEqual(4096);
    expect(embed!.description!.endsWith("...")).toBe(true);
  });

  it("does not truncate description at exactly 4096 characters", () => {
    const content = "a".repeat(4096);
    const embed = createDiscordEmbed(content);
    expect(embed).not.toBeNull();
    expect(embed!.description).toBe(content);
    expect(embed!.description!.endsWith("...")).toBe(false);
  });

  it("truncates title exceeding 256 characters", () => {
    const longTitle = "a".repeat(300);
    const embed = createDiscordEmbed("Content", { title: longTitle });
    expect(embed).not.toBeNull();
    expect(embed!.title!.length).toBeLessThanOrEqual(256);
    expect(embed!.title!.endsWith("...")).toBe(true);
  });

  it("does not truncate title at exactly 256 characters", () => {
    const title = "a".repeat(256);
    const embed = createDiscordEmbed("Content", { title });
    expect(embed).not.toBeNull();
    expect(embed!.title).toBe(title);
  });

  it("creates embed with all options combined", () => {
    const embed = createDiscordEmbed("Description text", {
      title: "Title",
      color: 0x00ff00,
      footer: "Footer text",
      timestamp: true,
    });
    expect(embed).not.toBeNull();
    expect(embed!.title).toBe("Title");
    expect(embed!.description).toBe("Description text");
    expect(embed!.color).toBe(0x00ff00);
    expect(embed!.footer).toEqual({ text: "Footer text" });
    expect(embed!.timestamp).toBeDefined();
  });

  it("trims whitespace from content", () => {
    const embed = createDiscordEmbed("  Hello world  ");
    expect(embed).not.toBeNull();
    expect(embed!.description).toBe("Hello world");
  });

  it("handles markdown content in description", () => {
    const content = "**Bold** and *italic* with `code`";
    const embed = createDiscordEmbed(content);
    expect(embed).not.toBeNull();
    expect(embed!.description).toBe(content);
  });

  it("handles multiline content", () => {
    const content = "Line 1\nLine 2\nLine 3";
    const embed = createDiscordEmbed(content);
    expect(embed).not.toBeNull();
    expect(embed!.description).toBe(content);
  });
});

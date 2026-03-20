import { describe, it, expect } from "vitest";
import { normalizeText, extractLinks, buildFileContext, buildLinkContext } from "./textNormalizer.js";

describe("normalizeText", () => {
  it("returns empty string for empty/whitespace input", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText("   ")).toBe("");
    expect(normalizeText("\n\t")).toBe("");
  });

  it("strips user mentions", () => {
    expect(normalizeText("Hey <@U123ABC> how are you?")).toBe("Hey how are you?");
    expect(normalizeText("<@U001><@U002> hi")).toBe("hi");
  });

  it("resolves channel links", () => {
    expect(normalizeText("Check <#C123|general> for updates")).toBe(
      "Check #general for updates",
    );
  });

  it("replaces URLs with type-aware link markers", () => {
    expect(normalizeText("Visit <https://example.com>")).toBe('Visit [link example.com]');
    expect(normalizeText("See <https://example.com|Example Site>")).toBe('See [link example.com "Example Site"]');
    expect(normalizeText("Check <https://github.com/org/repo/pull/42|Fix auth>")).toBe('Check [link:pr github.com "Fix auth"]');
    expect(normalizeText("Bug <https://github.com/org/repo/issues/99>")).toBe('Bug [link:issue github.com]');
  });

  it("converts bold to emphasis marker", () => {
    expect(normalizeText("This is *bold* text")).toBe("This is [emphasis: bold] text");
  });

  it("converts strikethrough to semantic marker", () => {
    expect(normalizeText("This is ~deleted~ text")).toBe("This is [strikethrough: deleted] text");
  });

  it("strips code blocks and inline code", () => {
    expect(normalizeText("Run `npm install` now")).toBe("Run npm install now");
    expect(normalizeText("```const x = 1;```")).toBe("const x = 1;");
  });

  it("converts emoji shortcodes", () => {
    const result = normalizeText("Great job! 👍");
    // node-emoji converts 👍 to :+1:, then we strip colons → "+1"
    expect(result).toContain("+1");
    expect(result).not.toContain(":");
  });

  it("preserves sentiment signals (caps, punctuation)", () => {
    const text = "THIS IS UNACCEPTABLE!!! Why???";
    const result = normalizeText(text);
    expect(result).toBe("THIS IS UNACCEPTABLE!!! Why???");
  });

  it("collapses whitespace", () => {
    expect(normalizeText("too   many    spaces")).toBe("too many spaces");
    expect(normalizeText("  leading and trailing  ")).toBe("leading and trailing");
  });

  it("truncates to 4000 chars at word boundary", () => {
    const longWord = "word ";
    const longText = longWord.repeat(1000); // 5000 chars
    const result = normalizeText(longText);
    expect(result.length).toBeLessThanOrEqual(4000);
    expect(result.endsWith(" ")).toBe(false);
  });

  it("handles combined Slack formatting", () => {
    const input = "<@U123> said *hello* in <#C456|general>: check <https://foo.com|link> ~old~";
    const result = normalizeText(input);
    expect(result).toBe('said [emphasis: hello] in #general: check [link foo.com "link"] [strikethrough: old]');
  });

  it("handles text shorter than max length without truncation", () => {
    const text = "Short message";
    expect(normalizeText(text)).toBe("Short message");
  });
});

describe("extractLinks", () => {
  it("extracts links with domain and type inference", () => {
    const links = extractLinks("Check <https://github.com/org/repo/pull/42|Fix auth> and <https://docs.google.com/doc/123>");
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({
      url: "https://github.com/org/repo/pull/42",
      domain: "github.com",
      label: "Fix auth",
      linkType: "pr",
    });
    expect(links[1]).toEqual({
      url: "https://docs.google.com/doc/123",
      domain: "docs.google.com",
      label: undefined,
      linkType: "doc",
    });
  });

  it("returns empty array for text without links", () => {
    expect(extractLinks("No links here")).toEqual([]);
  });

  it("infers issue, task, and design link types", () => {
    const links = extractLinks("<https://github.com/org/repo/issues/5> <https://linear.app/team/ENG-123> <https://figma.com/file/abc>");
    expect(links[0].linkType).toBe("issue");
    expect(links[1].linkType).toBe("task");
    expect(links[2].linkType).toBe("design");
  });
});

describe("buildFileContext", () => {
  it("includes title, type, and size", () => {
    const result = buildFileContext([
      { name: "report.pdf", title: "Q3 Report", filetype: "pdf", size: 2200000 },
    ]);
    expect(result).toBe('\n[shared file: "Q3 Report" (pdf, 2.1MB)]');
  });

  it("falls back to name when title is missing", () => {
    const result = buildFileContext([{ name: "data.csv", filetype: "csv" }]);
    expect(result).toBe('\n[shared file: "data.csv" (csv)]');
  });

  it("returns empty string for empty files", () => {
    expect(buildFileContext([])).toBe("");
    expect(buildFileContext(null)).toBe("");
    expect(buildFileContext(undefined)).toBe("");
  });
});

describe("buildLinkContext", () => {
  it("builds context with type and label", () => {
    const result = buildLinkContext([
      { url: "https://github.com/org/repo/pull/1", domain: "github.com", label: "Fix bug", linkType: "pr" },
    ]);
    expect(result).toBe('\n[link:pr github.com "Fix bug"]');
  });

  it("omits type tag for generic links", () => {
    const result = buildLinkContext([
      { url: "https://example.com", domain: "example.com", linkType: "link" },
    ]);
    expect(result).toBe("\n[link example.com]");
  });

  it("returns empty string for empty/null input", () => {
    expect(buildLinkContext([])).toBe("");
    expect(buildLinkContext(null)).toBe("");
  });
});

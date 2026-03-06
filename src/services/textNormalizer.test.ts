import { describe, it, expect } from "vitest";
import { normalizeText } from "./textNormalizer.js";

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

  it("cleans URLs to [link]", () => {
    expect(normalizeText("Visit <https://example.com>")).toBe("Visit [link]");
    expect(normalizeText("See <https://example.com|Example Site>")).toBe("See [link]");
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
    expect(result).toBe("said [emphasis: hello] in #general: check [link] [strikethrough: old]");
  });

  it("handles text shorter than max length without truncation", () => {
    const text = "Short message";
    expect(normalizeText(text)).toBe("Short message");
  });
});

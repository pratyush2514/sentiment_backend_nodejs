import { describe, expect, it } from "vitest";
import { envBoolean } from "./envBoolean.js";

describe("envBoolean", () => {
  it.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["yes", true],
    ["on", true],
    ["false", false],
    ["FALSE", false],
    ["0", false],
    ["no", false],
    ["off", false],
  ])("parses %s as %s", (input, expected) => {
    expect(envBoolean().parse(input)).toBe(expected);
  });

  it("treats empty strings as unset so defaults still apply", () => {
    expect(envBoolean(false).parse("")).toBe(false);
    expect(envBoolean(true).parse("")).toBe(true);
  });

  it("uses the provided default when unset", () => {
    expect(envBoolean(false).parse(undefined)).toBe(false);
    expect(envBoolean(true).parse(undefined)).toBe(true);
  });

  it("rejects invalid boolean-like values", () => {
    expect(() => envBoolean().parse("maybe")).toThrow();
  });
});


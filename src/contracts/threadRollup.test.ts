import { describe, expect, it } from "vitest";
import {
  ThreadOperationalRiskSchema,
  ThreadSurfacePrioritySchema,
  renderQuotedEnumList,
} from "./threadRollup.js";

describe("threadRollup contract", () => {
  it("accepts 'none' for low/no-risk thread outputs", () => {
    expect(ThreadOperationalRiskSchema.parse("none")).toBe("none");
    expect(ThreadSurfacePrioritySchema.parse("none")).toBe("none");
  });

  it("still rejects invalid enum values", () => {
    expect(() => ThreadOperationalRiskSchema.parse("minimal")).toThrow();
    expect(() => ThreadSurfacePrioritySchema.parse("urgent")).toThrow();
  });

  it("renders quoted enum lists for prompt instructions", () => {
    expect(renderQuotedEnumList(["none", "low"])).toBe('- "none"\n- "low"');
  });
});

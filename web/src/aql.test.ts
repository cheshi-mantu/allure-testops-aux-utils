import { describe, expect, it } from "vitest";
import { conditionAql, filterAql, type Condition } from "./aql";

const tag = { kind: "tag" } as const;
const browser = { kind: "env", id: 1, name: "browser" } as const;

function c(join: Condition["join"], field: Condition["field"], op: Condition["op"], ...values: string[]): Condition {
  return { key: Math.random().toString(), join, field, op, values };
}

describe("conditionAql", () => {
  it("writes tag conditions", () => {
    expect(conditionAql(c("and", tag, "is", "smoke"))).toBe('tag = "smoke"');
    expect(conditionAql(c("and", tag, "isNot", "smoke"))).toBe('tag != "smoke"');
    expect(conditionAql(c("and", tag, "anyOf", "a", "b"))).toBe('tag in ["a", "b"]');
    expect(conditionAql(c("and", tag, "noneOf", "a", "b"))).toBe('not (tag in ["a", "b"])');
    expect(conditionAql(c("and", tag, "contains", "nig"))).toBe('tag ~= "nig"');
    expect(conditionAql(c("and", tag, "empty"))).toBe("tag = null");
  });

  it("writes one environment variable at a time", () => {
    expect(conditionAql(c("and", browser, "is", "chrome"))).toBe('ev["browser"] = "chrome"');
    expect(conditionAql(c("and", browser, "anyOf", "chrome"))).toBe('ev["browser"] = "chrome"');
    expect(conditionAql(c("and", browser, "notEmpty"))).toBe('ev["browser"] != null');
  });

  it("escapes quotes and backslashes", () => {
    expect(conditionAql(c("and", { kind: "env", id: 2, name: 'my "var"' }, "is", "a\\b"))).toBe('ev["my \\"var\\""] = "a\\\\b"');
  });

  it("skips conditions without values", () => {
    expect(conditionAql(c("and", tag, "is"))).toBeNull();
    expect(conditionAql(c("and", tag, "anyOf", " "))).toBeNull();
  });
});

describe("filterAql", () => {
  it("joins conditions in order, leaving out incomplete ones", () => {
    expect(
      filterAql([
        c("or", tag, "is", "smoke"),
        c("and", browser, "is"),
        c("and", browser, "is", "chrome"),
        c("or", tag, "is", "nightly"),
      ]),
    ).toBe('tag = "smoke" and ev["browser"] = "chrome" or tag = "nightly"');
    expect(filterAql([])).toBe("");
  });
});

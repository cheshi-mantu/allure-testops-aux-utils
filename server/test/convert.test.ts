import { describe, expect, it } from "vitest";
import type { ResultDetails } from "../src/launchReport/api.js";
import { attachmentExtension, attachmentRows, convertResult, environmentProperties, groupByLabels, labelName, type AllureResult } from "../src/launchReport/convert.js";

const ctx = {
  endpoint: "https://testops.example.com",
  projectId: 3,
  attachment: (owner: "result" | "fixture", row: { id: number }) => (row.id === 99 ? null : `${owner}-${row.id}-attachment.txt`),
};

function details(overrides: Partial<ResultDetails> = {}): ResultDetails {
  return {
    result: { id: 7, name: "Login works", status: "passed", testCaseId: 42, historyKey: "hk", start: 1000, duration: 500 },
    scenario: null,
    fixtures: [],
    customFields: [],
    members: [],
    issues: [],
    ...overrides,
  };
}

describe("convertResult", () => {
  it("maps the basic fields", () => {
    const { result, container } = convertResult(details(), ctx);
    expect(result).toMatchObject({
      uuid: "testops-7",
      historyId: "hk",
      testCaseId: "42",
      name: "Login works",
      status: "passed",
      start: 1000,
      stop: 1500,
    });
    expect(result.links).toContainEqual({ name: "Test case 42", url: "https://testops.example.com/project/3/test-cases/42", type: "tms" });
    expect(container).toBeNull();
  });

  it("treats a result in progress as unknown and keeps the status flags", () => {
    const { result } = convertResult(details({ result: { id: 1, name: "x", status: null, message: "m", flaky: true, muted: false } }), ctx);
    expect(result.status).toBe("unknown");
    expect(result.statusDetails).toEqual({ message: "m", flaky: true });
    expect(result.historyId).toBe("result-1");
  });

  it("turns custom fields, members, tags and layer into labels", () => {
    const { result } = convertResult(
      details({
        result: { id: 1, name: "x", status: "passed", tags: [{ name: "smoke" }], layer: { id: 1, name: "UI" }, testCaseId: 5 },
        customFields: [
          { customField: { id: 1, name: "Parent Suite" }, values: [{ name: "Shop" }] },
          { customField: { id: 2, name: "sub_suite" }, values: [{ name: "UI" }] },
          { customField: { id: 3, name: "Component" }, values: [{ name: "cart" }, { name: "pay" }] },
        ],
        members: [
          { name: "alice", role: { name: "Owner" } },
          { name: "bob", role: { name: "Lead" } },
        ],
      }),
      ctx,
    );
    expect(result.labels).toEqual([
      { name: "tag", value: "smoke" },
      { name: "layer", value: "UI" },
      { name: "parentSuite", value: "Shop" },
      { name: "subSuite", value: "UI" },
      { name: "Component", value: "cart" },
      { name: "Component", value: "pay" },
      { name: "owner", value: "alice" },
      { name: "Lead", value: "bob" },
      { name: "ALLURE_ID", value: "5" },
    ]);
  });

  it("converts nested steps, expected results and attachments", () => {
    const { result } = convertResult(
      details({
        scenario: {
          steps: [
            {
              type: "body",
              body: "Open",
              status: "failed",
              message: "boom",
              parameters: [{ name: "p", value: "1" }],
              steps: [
                { type: "body", body: "Inner", status: "passed" },
                { type: "attachment", attachment: { id: 5, name: "log", contentType: "text/plain" } },
                { type: "attachment", attachment: { id: 99, name: "skipped" } },
              ],
              expectedResultSteps: [{ type: "expected_body", body: "Shown", status: "passed" }],
            },
            { type: "attachment", attachment: { id: 6, name: "top" } },
          ],
        },
      }),
      ctx,
    );
    expect(result.attachments).toEqual([{ name: "top", type: undefined, source: "result-6-attachment.txt" }]);
    const open = result.steps[0];
    expect(open).toMatchObject({ name: "Open", status: "failed", statusDetails: { message: "boom" }, parameters: [{ name: "p", value: "1" }] });
    expect(open.attachments).toEqual([{ name: "log", type: "text/plain", source: "result-5-attachment.txt" }]);
    expect(open.steps.map((s) => s.name)).toEqual(["Inner", "Expected result"]);
    expect(open.steps[1]).toMatchObject({ status: "passed", steps: [{ name: "Shown", status: "passed" }] });
  });

  it("puts fixtures into a container and keeps fixture attachments apart", () => {
    const d = details({
      fixtures: [
        { id: 1, type: "before", name: "setup", status: "passed", scenario: { steps: [{ type: "attachment", attachment: { id: 8, name: "b" } }] } },
        { id: 2, type: "after", name: "teardown", status: "broken", message: "oops" },
      ],
    });
    const { container } = convertResult(d, ctx);
    expect(container).toMatchObject({ children: ["testops-7"], befores: [{ name: "setup", attachments: [{ source: "fixture-8-attachment.txt" }] }], afters: [{ name: "teardown", statusDetails: { message: "oops" } }] });
    expect(attachmentRows(d)).toEqual([{ owner: "fixture", row: { id: 8, name: "b" } }]);
  });

  it("joins description, precondition and expected result", () => {
    const { result } = convertResult(details({ result: { id: 1, name: "x", description: "Desc", precondition: "Pre", expectedResult: "Exp" } }), ctx);
    expect(result.description).toBe("Desc\n\n## Precondition\n\nPre\n\n## Expected result\n\nExp");
    const html = convertResult(details({ result: { id: 1, name: "x", descriptionHtml: "<p>x</p>" } }), ctx).result;
    expect(html.descriptionHtml).toBe("<p>x</p>");
    expect(html.description).toBeUndefined();
  });

  it("keeps hidden and excluded parameters", () => {
    const { result } = convertResult(
      details({ result: { id: 1, name: "x", parameters: [{ name: "a", value: "1", hidden: true }, { name: "b", value: null, excluded: true }] } }),
      ctx,
    );
    expect(result.parameters).toEqual([
      { name: "a", value: "1", mode: "hidden" },
      { name: "b", value: "", excluded: true },
    ]);
  });
});

describe("helpers", () => {
  it("maps custom field names to Allure labels", () => {
    expect(labelName("Sub-Suite")).toBe("subSuite");
    expect(labelName("Epic")).toBe("epic");
    expect(labelName("Team")).toBe("Team");
  });

  it("picks the grouping from the labels present", () => {
    const withLabels = (...names: string[]) => [{ labels: names.map((name) => ({ name, value: "v" })) }] as AllureResult[];
    expect(groupByLabels("auto", withLabels("suite"))).toEqual(["parentSuite", "suite", "subSuite"]);
    expect(groupByLabels("auto", withLabels("feature"))).toEqual(["epic", "feature", "story"]);
    expect(groupByLabels("auto", withLabels("tag"))).toEqual([]);
    expect(groupByLabels("packages", withLabels("suite"))).toEqual(["package"]);
  });

  it("writes environment properties", () => {
    expect(
      environmentProperties([
        { name: "chrome", variable: { name: "browser" } },
        { name: "firefox", variable: { name: "browser" } },
        { name: "a=b", variable: { name: "my var" } },
      ]),
    ).toBe("browser=chrome, firefox\nmy\\ var=a=b\n");
  });

  it("chooses attachment extensions", () => {
    expect(attachmentExtension({ id: 1, name: "shot.PNG" })).toBe(".png");
    expect(attachmentExtension({ id: 1, name: "log", contentType: "text/plain; charset=utf-8" })).toBe(".txt");
    expect(attachmentExtension({ id: 1, name: "x", contentType: "application/x-unknown" })).toBe("");
  });
});

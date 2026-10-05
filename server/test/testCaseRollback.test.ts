import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobContext } from "../src/jobs.js";
import { DEFAULT_ATTRIBUTES, rewind, type AuditEntry, type Overview } from "../src/testCaseRollback/plan.js";
import { applyRollback, scanRollback, type ApplySummary, type RollbackPlan, type ScanOptions } from "../src/testCaseRollback/run.js";
import { useMock } from "./mock.js";

const client = useMock();
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "testcase-rollback-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function context(): JobContext & { warnings: string[]; last: () => unknown } {
  const warnings: string[] = [];
  let summary: unknown = null;
  return {
    dir,
    signal: new AbortController().signal,
    warnings,
    last: () => summary,
    title: () => {},
    summary: (s) => (summary = structuredClone(s)),
    phase: () => {},
    advance: () => {},
    log: () => {},
    warn: (l) => warnings.push(l),
  };
}

const DAY = 24 * 3600_000;

describe("rewind", () => {
  const current: Overview = { id: 1, name: "C", description: "c", tags: [{ id: 2, name: "b" }, { id: 3, name: "c" }] };
  const entries: AuditEntry[] = [
    { id: 4, timestamp: 400, actionType: "insert", data: [{ type: "test_case_test_tag", diff: { ids: { oldValue: null, newValue: [3] } } }] },
    { id: 3, timestamp: 300, actionType: "update", data: [{ type: "test_case", diff: { name: { oldValue: "B", newValue: "C" } } }] },
    { id: 2, timestamp: 200, actionType: "update", data: [{ type: "test_case", diff: { name: { oldValue: "A", newValue: "B" } } }] },
    { id: 1, timestamp: 200, actionType: "delete", data: [{ type: "test_case_test_tag", diff: { ids: { oldValue: [1], newValue: null } } }] },
    { id: 0, timestamp: 100, actionType: "update", data: [{ type: "test_case", diff: { description: { oldValue: null, newValue: "c" } } }] },
  ];

  it("takes each attribute back to its value at the time", () => {
    const r = rewind(current, entries, 150, DEFAULT_ATTRIBUTES);
    expect(r.target).toEqual({ name: "A", tags: [1, 2] });
    expect(r.changes).toBe(4);
  });

  it("looks only at the chosen attributes and at changes after the time", () => {
    expect(rewind(current, entries, 250, ["name"]).target).toEqual({ name: "B" });
    expect(rewind(current, entries, 50, ["description"]).target).toEqual({ description: null });
  });

  it("takes actions and types in any case", () => {
    const upper = entries.map((e) => ({ ...e, actionType: e.actionType.toUpperCase(), data: e.data?.map((d) => ({ ...d, type: d.type.toUpperCase() })) }));
    expect(rewind(current, upper, 150, DEFAULT_ATTRIBUTES).target).toEqual({ name: "A", tags: [1, 2] });
  });

  it("finds nothing to do when a change was undone later", () => {
    const back: AuditEntry[] = [
      { id: 2, timestamp: 300, actionType: "update", data: [{ type: "test_case", diff: { name: { oldValue: "B", newValue: "C" } } }] },
      { id: 1, timestamp: 200, actionType: "update", data: [{ type: "test_case", diff: { name: { oldValue: "C", newValue: "B" } } }] },
    ];
    expect(rewind(current, back, 100, DEFAULT_ATTRIBUTES).target).toEqual({});
  });
});

describe("test case rollback", () => {
  const options = (o: Partial<ScanOptions> = {}): ScanOptions => ({ projectId: 1, aql: "true", after: Date.now() - 3 * DAY, attributes: DEFAULT_ATTRIBUTES, onlyModified: true, threads: 4, ...o });

  async function scan(o?: Partial<ScanOptions>): Promise<RollbackPlan> {
    const file = await scanRollback(client(), options(o), context());
    return JSON.parse(readFileSync(file.path, "utf8")) as RollbackPlan;
  }

  const changes = (plan: RollbackPlan, id: number) =>
    Object.fromEntries((plan.testCases.find((t) => t.id === id)?.changes ?? []).map((c) => [c.label, `${c.current} -> ${c.target}`]));

  it("shows what each test case gets back", async () => {
    const plan = await scan();
    // The test case changed only before the time is not even looked at.
    expect(plan.matched).toBe(5);
    expect(plan.testCases.map((t) => t.id)).toEqual([9001, 9002, 9004, 9005]);
    expect(changes(plan, 9001)).toEqual({
      Name: "Login works -> Login with a valid password",
      Description: "Rewritten by an import -> Enter the user name and the password",
      Status: "Active -> Draft",
      Tags: "legacy -> smoke",
      "Custom fields": "Priority: Low -> Priority: High",
    });
    expect(changes(plan, 9002)).toEqual({
      Precondition: "The cart is full -> (empty)",
      Layer: "API -> UI",
      Members: "Lead: carol -> (nothing)",
      Issues: "SHOP-2 -> (nothing)",
    });
    expect(plan.testCases.find((t) => t.id === 9001)?.authors).toEqual({ bob: 5 });
    // Created after the time: nothing to go back to.
    expect(plan.testCases.find((t) => t.id === 9004)).toMatchObject({ changes: [], notes: [expect.stringContaining("Created after")] });
    // A custom field value deleted since cannot come back; the rest of the rollback still holds.
    expect(changes(plan, 9005)).toEqual({ Automated: "yes -> no" });
    expect(plan.testCases.find((t) => t.id === 9005)?.notes).toEqual([expect.stringContaining("no longer exists")]);
  });

  it("looks at every test case of the filter when asked to", async () => {
    const plan = await scan({ onlyModified: false, attributes: ["tags"], threads: 1 });
    expect(plan.matched).toBe(7);
    expect(plan.testCases.filter((t) => t.changes.length).map((t) => t.id)).toEqual([9001]);
  });

  it("finds changes that did not move the modification date only without the date filter", async () => {
    expect(changes(await scan({ onlyModified: true }), 9007)).toEqual({});
    expect(changes(await scan({ onlyModified: false }), 9007)).toEqual({ "Custom fields": "Priority: Low -> Priority: High" });
  });

  it("rolls back the chosen test cases and skips one changed since the preview", async () => {
    const plan = await scan();
    await client().patch("/api/rs/testcase/9002?v2=true", { precondition: "Changed meanwhile" });
    const ctx = context();
    await applyRollback(client(), plan, [9001, 9002, 9005], ctx);
    expect(ctx.last()).toMatchObject({ rolledBack: 2, skipped: 1, failed: 0 } satisfies Partial<ApplySummary>);
    expect(ctx.warnings).toEqual([expect.stringContaining("changed since the preview: Precondition")]);

    const login = await client().get<Overview>("/api/rs/testcase/9001/overview");
    expect(login).toMatchObject({ name: "Login with a valid password", description: "Enter the user name and the password", status: { name: "Draft" } });
    expect(login.tags?.map((t) => t.name).sort()).toEqual(["regression", "smoke"]);
    expect(login.customFields?.map((v) => v.name)).toEqual(["High"]);

    // Done ones have nothing left; the rollback itself is in the change log after the time.
    const again = await scan();
    expect(changes(again, 9001)).toEqual({});
    expect(changes(again, 9005)).toEqual({});
    expect(changes(again, 9002).Precondition).toBe("Changed meanwhile -> (empty)");
  });
});

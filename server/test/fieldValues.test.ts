import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobContext } from "../src/jobs.js";
import { checkValues, deleteUnusedValues, fieldValues, projectFields, type CleanupSummary } from "../src/fieldValues/cleanup.js";
import { useMock } from "./mock.js";

const client = useMock();
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "field-values-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function context(): JobContext & { warnings: string[]; last: () => CleanupSummary } {
  const warnings: string[] = [];
  let summary: unknown = null;
  return {
    dir,
    signal: new AbortController().signal,
    warnings,
    last: () => summary as CleanupSummary,
    title: () => {},
    summary: (s) => (summary = structuredClone(s)),
    phase: () => {},
    advance: () => {},
    log: () => {},
    warn: (l) => warnings.push(l),
  };
}

async function values(field: string) {
  const f = (await projectFields(client(), 1)).find((x) => x.name === field)!;
  return { field: f, values: await fieldValues(client(), 1, f.id) };
}

describe("custom field values cleanup", () => {
  it("lists the fields of a project and the values with their test cases", async () => {
    const fields = await projectFields(client(), 1);
    expect(fields.map((f) => f.name)).toEqual(["Component", "Epic", "Feature", "Priority", "Suite", "Team"]);
    const team = await values("Team");
    expect(Object.fromEntries(team.values.map((v) => [v.name, v.testCases]))).toEqual({ "Checkout squad": 3, "Legacy squad": 0, "Search squad": 0 });
    // A value test cases use is listed even when it is not linked to the project.
    expect((await values("Component")).values.find((v) => v.name === "Payments")?.testCases).toBe(1);
  });

  it("shows deleted test cases and the default value a deletion affects", async () => {
    const team = await values("Team");
    const priority = await values("Priority");
    const chosen = [...team.values, ...priority.values].filter((v) => v.testCases === 0);
    const ref = (v: { id: number }) => ({ fieldId: team.values.includes(v as never) ? team.field.id : priority.field.id, valueId: v.id });
    const impacts = await checkValues(client(), 1, chosen.map(ref));
    const by = Object.fromEntries(impacts.map((i) => [`${i.fieldName}: ${i.name}`, i]));
    expect(Object.keys(by)).toEqual(["Priority: Low", "Priority: Medium", "Team: Legacy squad", "Team: Search squad"]);
    expect(by["Team: Legacy squad"].deletedTestCases).toBe(1);
    expect(by["Team: Search squad"].deletedTestCases).toBe(0);
    expect(by["Priority: Medium"]).toMatchObject({ global: true, isDefault: true });
    expect(by["Priority: Low"]).toMatchObject({ global: true, isDefault: false });
  });

  it("deletes the unused values and leaves a value in use alone", async () => {
    const team = await values("Team");
    const ids = (names: string[]) => team.values.filter((v) => names.includes(v.name)).map((v) => ({ fieldId: team.field.id, valueId: v.id }));
    const ctx = context();
    const file = await deleteUnusedValues(client(), { projectId: 1, values: ids(["Search squad", "Legacy squad", "Checkout squad"]) }, ctx);
    expect(ctx.last()).toMatchObject({ deleted: 2, skipped: 1, failed: 0 });
    expect(ctx.warnings).toEqual(['Team: "Checkout squad": skipped, used by 3 test cases now']);
    expect((await values("Team")).values.map((v) => v.name)).toEqual(["Checkout squad"]);
    const report = JSON.parse(readFileSync(file.path, "utf8"));
    expect(report.values.map((v: { name: string; outcome: string }) => `${v.name} ${v.outcome}`)).toEqual(["Checkout squad skipped", "Legacy squad deleted", "Search squad deleted"]);
  });

  it("skips a value that is gone already and clears the default of the field", async () => {
    const priority = await values("Priority");
    const medium = { fieldId: priority.field.id, valueId: priority.values.find((v) => v.name === "Medium")!.id };
    const ctx = context();
    await deleteUnusedValues(client(), { projectId: 1, values: [medium] }, ctx);
    expect(ctx.last()).toMatchObject({ deleted: 1 });
    expect((await projectFields(client(), 1)).find((f) => f.name === "Priority")?.defaultValueId).toBeNull();

    const again = context();
    await deleteUnusedValues(client(), { projectId: 1, values: [medium] }, again);
    expect(again.last()).toMatchObject({ deleted: 0, skipped: 1 });
  });
});

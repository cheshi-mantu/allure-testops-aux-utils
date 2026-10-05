import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobContext, JobResult } from "../jobs.js";
import { safeFileName } from "../launchReport/export.js";
import { message } from "../launchReport/read.js";
import type { ApiProject, TestOpsClient } from "../testops.js";

interface ApiProjectField {
  required?: boolean;
  locked?: boolean;
  defaultCustomFieldValueId?: number | null;
  customField: { id: number; name: string };
}

interface ApiFieldValue {
  id: number;
  name: string;
  global?: boolean;
  testCasesCount?: number;
}

/** A custom field linked to the project. */
export interface ProjectField {
  id: number;
  name: string;
  required: boolean;
  locked: boolean;
  defaultValueId: number | null;
}

/** A value of a field in the project, with the number of its test cases there. */
export interface FieldValue {
  id: number;
  name: string;
  global: boolean;
  /** Test cases of the project with this value, not counting deleted ones. */
  testCases: number;
}

export interface ValueRef {
  fieldId: number;
  valueId: number;
}

/** What deleting a value does, checked right before asking to confirm. */
export interface ValueImpact extends ValueRef {
  fieldName: string;
  name: string;
  global: boolean;
  testCases: number;
  /** Deleted test cases of the project, in the recycle bin, that lose the value. */
  deletedTestCases: number;
  /** The value is the default of the field in the project; the field is left without a default. */
  isDefault: boolean;
  /** The value is no longer in the project. */
  gone: boolean;
}

export async function projectFields(client: TestOpsClient, projectId: number): Promise<ProjectField[]> {
  const rows = await client.all<ApiProjectField>(`/api/rs/project/${projectId}/cf`, { sort: "id,asc" });
  return rows
    .map((r) => ({ id: r.customField.id, name: r.customField.name, required: Boolean(r.required), locked: Boolean(r.locked), defaultValueId: r.defaultCustomFieldValueId ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Project and global values of a field in the project. */
export async function fieldValues(client: TestOpsClient, projectId: number, fieldId: number): Promise<FieldValue[]> {
  const rows = await client.all<ApiFieldValue>(`/api/rs/project/${projectId}/cfv`, { customFieldId: String(fieldId), sort: "name,asc" });
  return rows.map((v) => ({ id: v.id, name: v.name, global: Boolean(v.global), testCases: v.testCasesCount ?? 0 }));
}

/** Number of deleted test cases of the project holding any of the values of a field. */
async function deletedCount(client: TestOpsClient, projectId: number, fieldId: number, valueIds: number[]): Promise<number> {
  const r = await client.get<{ valid?: boolean; count?: number }>("/api/rs/testcase/query/validate", {
    projectId: String(projectId),
    deleted: "true",
    rql: `cf[${fieldId}] in [${valueIds.join(", ")}]`,
  });
  if (r.valid === false) throw new Error(`Allure TestOps did not accept the query for deleted test cases of field ${fieldId}`);
  return r.count ?? 0;
}

/** Deleted test cases per value; one query for the field, one per value only when some are there. */
async function deletedCounts(client: TestOpsClient, projectId: number, fieldId: number, valueIds: number[]): Promise<Map<number, number>> {
  const counts = new Map(valueIds.map((id) => [id, 0]));
  if (valueIds.length === 0 || (await deletedCount(client, projectId, fieldId, valueIds)) === 0) return counts;
  if (valueIds.length === 1) return counts.set(valueIds[0], await deletedCount(client, projectId, fieldId, valueIds));
  await Promise.all(valueIds.map(async (id) => counts.set(id, await deletedCount(client, projectId, fieldId, [id]))));
  return counts;
}

function byField(values: ValueRef[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const v of values) m.set(v.fieldId, [...(m.get(v.fieldId) ?? []), v.valueId]);
  return m;
}

/** Re-reads the chosen values and finds what deleting them affects. */
export async function checkValues(client: TestOpsClient, projectId: number, chosen: ValueRef[]): Promise<ValueImpact[]> {
  const fields = new Map((await projectFields(client, projectId)).map((f) => [f.id, f]));
  const result: ValueImpact[] = [];
  await Promise.all(
    [...byField(chosen)].map(async ([fieldId, ids]) => {
      const field = fields.get(fieldId);
      const values = field ? new Map((await fieldValues(client, projectId, fieldId)).map((v) => [v.id, v])) : new Map<number, FieldValue>();
      const present = ids.filter((id) => values.has(id));
      const deleted = await deletedCounts(client, projectId, fieldId, present);
      for (const id of ids) {
        const v = values.get(id);
        result.push({
          fieldId,
          valueId: id,
          fieldName: field?.name ?? `field ${fieldId}`,
          name: v?.name ?? `value ${id}`,
          global: v?.global ?? false,
          testCases: v?.testCases ?? 0,
          deletedTestCases: deleted.get(id) ?? 0,
          isDefault: field?.defaultValueId === id,
          gone: !v,
        });
      }
    }),
  );
  return result.sort((a, b) => a.fieldName.localeCompare(b.fieldName) || a.name.localeCompare(b.name));
}

export interface CleanupOptions {
  projectId: number;
  values: ValueRef[];
}

export type CleanupOutcome = "deleted" | "skipped" | "failed";

interface ReportEntry extends ValueImpact {
  outcome: CleanupOutcome;
  reason: string | null;
}

export interface CleanupSummary {
  project: ApiProject;
  deleted: number;
  skipped: number;
  failed: number;
}

/** Deletes values that still have no test cases; a value that got test cases since the check is left alone. */
export async function deleteUnusedValues(client: TestOpsClient, o: CleanupOptions, ctx: JobContext): Promise<JobResult> {
  ctx.phase("Checking the values");
  const project = await client.get<ApiProject>(`/api/rs/project/${o.projectId}`);
  ctx.title(`${project.name}: unused custom field values`);
  const impacts = await checkValues(client, o.projectId, o.values);
  const summary: CleanupSummary = { project, deleted: 0, skipped: 0, failed: 0 };
  const report: ReportEntry[] = [];
  ctx.summary(summary);

  ctx.phase("Deleting values", impacts.length);
  for (const v of impacts) {
    if (ctx.signal.aborted) throw new Error("Cancelled");
    const what = `${v.fieldName}: "${v.name}"`;
    let outcome: CleanupOutcome;
    let reason: string | null = null;
    if (v.gone) {
      outcome = "skipped";
      reason = "not in the project any more";
    } else if (v.testCases > 0) {
      outcome = "skipped";
      reason = `used by ${v.testCases} test cases now`;
    } else {
      try {
        // Not repeated on failure: the value may be gone already. Checking again shows what is left.
        await client.delete(`/api/rs/project/${o.projectId}/cfv/${v.valueId}`);
        outcome = "deleted";
        ctx.log(`Deleted ${what}`);
      } catch (e) {
        outcome = "failed";
        reason = message(e);
        ctx.warn(`${what}: not deleted: ${reason}`);
      }
    }
    if (outcome === "skipped") ctx.warn(`${what}: skipped, ${reason}`);
    summary[outcome]++;
    report.push({ ...v, outcome, reason });
    ctx.advance();
    ctx.summary(summary);
  }

  const name = `${safeFileName(`unused-values-${project.name}`)}.json`;
  const path = join(ctx.dir, name);
  await writeFile(path, JSON.stringify({ project, values: report }, null, 2));
  ctx.log(`${summary.deleted} deleted, ${summary.skipped} skipped, ${summary.failed} failed`);
  return { path, name, contentType: "application/json" };
}

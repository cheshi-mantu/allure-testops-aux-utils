import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jobFile, type JobContext, type JobResult } from "../jobs.js";
import { safeFileName } from "../launchReport/export.js";
import { message } from "../launchReport/read.js";
import { TestOpsError, type ApiProject, type TestOpsClient } from "../testops.js";
import {
  ATTRIBUTE_LABEL,
  currentRaw,
  rewind,
  sameRaw,
  type AttributeKey,
  type AuditEntry,
  type ListKey,
  type Named,
  type Overview,
  type RawValue,
} from "./plan.js";

const AUDIT_PAGE = 100;
/** Test cases written in parallel. */
const APPLY_THREADS = 8;
export const MAX_THREADS = 32;

export interface ScanOptions {
  projectId: number;
  /** AQL over test cases, `true` for all. */
  aql: string;
  /** Epoch milliseconds: changes made after this are undone. */
  after: number;
  attributes: AttributeKey[];
  /** Look only at test cases modified after the time: faster, but misses changes that do not move the modification date. */
  onlyModified: boolean;
  /** Test cases read at a time, and the requests made at a time. */
  threads: number;
}

/** An attribute to restore, as shown and as written. */
export interface AttributeChange {
  key: AttributeKey;
  label: string;
  current: string;
  target: string;
  currentRaw: RawValue;
  targetRaw: RawValue;
  /** Lists: entries that stay; `current` and `target` name only the ones that go and come back. */
  unchanged?: number;
}

export interface TestCasePlan {
  id: number;
  name: string;
  url: string;
  changes: AttributeChange[];
  /** Things not restored and why. */
  notes: string[];
  authors: Record<string, number>;
}

export interface RollbackPlan {
  project: ApiProject;
  options: ScanOptions;
  /** Test cases matching the filter, before looking at their changes. */
  matched: number;
  testCases: TestCasePlan[];
}

export interface ScanSummary {
  project: ApiProject;
  matched: number;
  scanned: number;
  /** Change log entries after the date, of all test cases read. */
  logEntries: number;
  toRollBack: number;
  attributes: number;
}

interface CfValue extends Named {
  customField?: Named | null;
}
interface Member extends Named {
  role?: Named | null;
}

/** Names of the things a test case refers to by id; `null` for those that are gone. */
class Lookups {
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(private readonly client: TestOpsClient) {}

  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) this.cache.set(key, load());
    return this.cache.get(key) as Promise<T>;
  }

  private byId<T>(path: string): Promise<T | null> {
    return this.once(path, () =>
      this.client.get<T>(path).catch((e: unknown) => {
        if (e instanceof TestOpsError && (e.status === 404 || e.status === 400)) return null;
        throw e;
      }),
    );
  }

  async named(kind: "workflow" | "status" | "layer", id: number): Promise<Named | null> {
    const path = { workflow: "/api/rs/workflow", status: "/api/rs/status", layer: "/api/rs/testlayer" }[kind];
    const all = await this.once(path, () => this.client.all<Named>(path, {}));
    return all.find((x) => x.id === id) ?? null;
  }

  item(list: ListKey, id: number): Promise<(Named & { customField?: Named | null; role?: Named | null }) | null> {
    const path = { tags: "/api/rs/tag", customFields: "/api/rs/cfv", members: "/api/rs/member", issues: "/api/rs/issue" }[list];
    return this.byId(`${path}/${id}`);
  }
}

function text(v: RawValue): string {
  if (v === null || v === "") return "(empty)";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

function itemText(list: ListKey, x: Named & { customField?: Named | null; role?: Named | null }): string {
  if (list === "customFields") return `${x.customField?.name ?? "?"}: ${x.name}`;
  if (list === "members") return `${x.role?.name ?? "?"}: ${x.name}`;
  return x.name;
}

/** All change log entries after the time, newest first; stops reading at the first older one. */
async function auditAfter(client: TestOpsClient, testCaseId: number, after: number): Promise<AuditEntry[]> {
  const result: AuditEntry[] = [];
  for (let page = 0; ; page++) {
    const p = await client.get<{ content: AuditEntry[]; last?: boolean; totalPages?: number }>("/api/rs/testcase/audit", {
      testCaseId: String(testCaseId),
      page: String(page),
      size: String(AUDIT_PAGE),
    });
    for (const e of p.content) {
      if (e.timestamp <= after) return result;
      result.push(e);
    }
    if (p.content.length < AUDIT_PAGE || p.last || page + 1 >= (p.totalPages ?? Infinity)) return result;
  }
}

async function describe(lookups: Lookups, current: Overview, key: AttributeKey, raw: RawValue, notes: string[]): Promise<{ text: string; raw: RawValue }> {
  if (key === "workflow" || key === "status" || key === "layer") {
    if (raw === null) return { text: "(empty)", raw };
    const own = current[key];
    const found = own?.id === raw ? own : await lookups.named(key, raw as number);
    if (!found) notes.push(`${ATTRIBUTE_LABEL[key]} ${raw} no longer exists`);
    return { text: found?.name ?? `#${raw}`, raw };
  }
  if (key === "tags" || key === "customFields" || key === "members" || key === "issues") {
    const own = new Map((current[key] ?? []).map((x) => [x.id, x as Named]));
    const kept: number[] = [];
    const names: string[] = [];
    for (const id of raw as number[]) {
      const x = own.get(id) ?? (await lookups.item(key, id));
      if (!x) {
        notes.push(`${ATTRIBUTE_LABEL[key]}: an entry (id ${id}) no longer exists and cannot be restored`);
        continue;
      }
      kept.push(id);
      names.push(itemText(key, x));
    }
    return { text: names.length ? names.sort().join(", ") : "(none)", raw: kept };
  }
  return { text: text(raw), raw };
}

async function planTestCase(client: TestOpsClient, lookups: Lookups, o: ScanOptions, id: number, seen: (entries: number) => void): Promise<TestCasePlan | null> {
  const entries = await auditAfter(client, id, o.after);
  seen(entries.length);
  if (entries.length === 0) return null;
  const current = await client.get<Overview>(`/api/rs/testcase/${id}/overview`);
  const r = rewind(current, entries, o.after, o.attributes);
  const plan: TestCasePlan = { id, name: current.name, url: `${client.endpoint}/project/${o.projectId}/test-cases/${id}`, changes: [], notes: [], authors: r.authors };
  if (r.createdAfter) {
    plan.notes.push("Created after the date: nothing to roll back to");
    return plan;
  }
  for (const key of Object.keys(r.target) as AttributeKey[]) {
    const now = currentRaw(current, key);
    const was = await describe(lookups, current, key, r.target[key]!, plan.notes);
    // What is left after dropping entries that are gone may be the current value already.
    if (sameRaw(was.raw, now)) continue;
    if (Array.isArray(now)) {
      // Lists show what goes and what comes back, not the entries that stay.
      const target = was.raw as number[];
      const stay = now.filter((id) => target.includes(id)).length;
      const goes = await describe(lookups, current, key, now.filter((id) => !target.includes(id)), []);
      const back = await describe(lookups, current, key, target.filter((id) => !now.includes(id)), []);
      const none = (t: string) => (t === "(none)" ? "(nothing)" : t);
      plan.changes.push({ key, label: ATTRIBUTE_LABEL[key], current: none(goes.text), target: none(back.text), currentRaw: now, targetRaw: was.raw, unchanged: stay });
      continue;
    }
    const cur = await describe(lookups, current, key, now, []);
    plan.changes.push({ key, label: ATTRIBUTE_LABEL[key], current: cur.text, target: was.text, currentRaw: now, targetRaw: was.raw });
  }
  if (plan.changes.some((c) => c.key === "status" && c.targetRaw === null)) {
    plan.changes = plan.changes.filter((c) => c.key !== "status");
    plan.notes.push("Status: a test case always has one, it is left as it is");
  }
  if (plan.changes.some((c) => c.key === "workflow" && c.targetRaw === null)) {
    plan.changes = plan.changes.filter((c) => c.key !== "workflow");
    plan.notes.push("Workflow: a test case always has one, it is left as it is");
  }
  if (plan.changes.some((c) => c.key === "name" && !c.targetRaw)) {
    plan.changes = plan.changes.filter((c) => c.key !== "name");
    plan.notes.push("Name: a test case always has one, it is left as it is");
  }
  return plan.changes.length || plan.notes.length ? plan : null;
}

async function inParallel<T>(items: T[], threads: number, body: (item: T) => Promise<void>, signal: AbortSignal): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(threads, items.length) }, async () => {
      while (next < items.length) {
        if (signal.aborted) throw new Error("Cancelled");
        await body(items[next++]);
      }
    }),
  );
}

export function scanAql(o: Pick<ScanOptions, "aql" | "after" | "onlyModified">): string {
  const filter = o.aql.trim() || "true";
  return o.onlyModified ? `(${filter}) and lastModifiedDate > ${o.after}` : filter;
}

/** Finds what rolling the matching test cases back would change, without changing anything. */
export async function scanRollback(shared: TestOpsClient, o: ScanOptions, ctx: JobContext): Promise<JobResult> {
  const client = shared.withParallel(o.threads);
  ctx.phase("Finding test cases");
  const project = await client.get<ApiProject>(`/api/rs/project/${o.projectId}`);
  ctx.title(`${project.name}: changes after ${new Date(o.after).toISOString().replace("T", " ").slice(0, 16)} UTC`);
  const rows = await client.all<{ id: number }>("/api/rs/testcase/__search", { projectId: String(o.projectId), rql: scanAql(o), sort: "id,asc" });
  const summary: ScanSummary = { project, matched: rows.length, scanned: 0, logEntries: 0, toRollBack: 0, attributes: 0 };
  ctx.summary(summary);
  ctx.log(`${rows.length} test cases match the filter`);

  ctx.phase("Reading change logs", rows.length);
  const lookups = new Lookups(client);
  const plans: TestCasePlan[] = [];
  ctx.log(`Reading with ${o.threads} threads`);
  await inParallel(
    rows,
    o.threads,
    async (row) => {
      try {
        const plan = await planTestCase(client, lookups, o, row.id, (n) => (summary.logEntries += n));
        if (plan) {
          plans.push(plan);
          if (plan.changes.length) {
            summary.toRollBack++;
            summary.attributes += plan.changes.length;
          }
        }
      } catch (e) {
        ctx.warn(`Test case ${row.id}: not read: ${message(e)}`);
      }
      summary.scanned++;
      ctx.advance();
      ctx.summary(summary);
    },
    ctx.signal,
  );
  plans.sort((a, b) => a.id - b.id);

  const result: RollbackPlan = { project, options: o, matched: rows.length, testCases: plans };
  const name = `${safeFileName(`rollback-plan-${project.name}`)}.json`;
  const path = join(ctx.dir, name);
  await writeFile(path, JSON.stringify(result));
  ctx.log(`${summary.logEntries} change log entries after the date; ${summary.toRollBack} test cases to roll back, ${summary.attributes} attributes`);
  return { path, name, contentType: "application/json" };
}

export type ApplyOutcome = "rolled back" | "skipped" | "failed";

export interface ApplySummary {
  project: ApiProject;
  rolledBack: number;
  skipped: number;
  failed: number;
}

export class PlanError extends Error {}

export async function readPlan(planJobId: string): Promise<RollbackPlan> {
  const file = jobFile(planJobId, 0);
  if (!file) throw new PlanError("The preview is gone; find the changes again");
  return JSON.parse(await readFile(file.path, "utf8")) as RollbackPlan;
}

/** The request body that sets the attributes; issues are set by a request of their own. */
export function patchBody(changes: AttributeChange[]): { patch: Record<string, unknown>; issues: number[] | null } {
  const patch: Record<string, unknown> = {};
  let issues: number[] | null = null;
  for (const c of changes) {
    const v = c.targetRaw;
    switch (c.key) {
      case "workflow":
        patch.workflowId = v;
        break;
      case "status":
        patch.statusId = v;
        break;
      case "layer":
        patch.testLayerId = v;
        break;
      case "tags":
      case "members":
        patch[c.key] = (v as number[]).map((id) => ({ id }));
        break;
      case "customFields":
        patch.customFields = (v as number[]).map((id) => ({ id }));
        break;
      case "issues":
        issues = v as number[];
        break;
      default:
        patch[c.key] = v;
    }
  }
  return { patch, issues };
}

/**
 * Rolls the chosen test cases of a plan back. A test case changed since the
 * preview is skipped: its plan no longer holds.
 */
export async function applyRollback(client: TestOpsClient, plan: RollbackPlan, testCaseIds: number[], ctx: JobContext): Promise<JobResult> {
  const wanted = new Set(testCaseIds);
  const chosen = plan.testCases.filter((t) => wanted.has(t.id) && t.changes.length);
  ctx.title(`${plan.project.name}: rollback of ${chosen.length} test cases`);
  const summary: ApplySummary = { project: plan.project, rolledBack: 0, skipped: 0, failed: 0 };
  const report: { id: number; name: string; outcome: ApplyOutcome; reason: string | null; changes: AttributeChange[] }[] = [];
  ctx.summary(summary);
  ctx.phase("Rolling back", chosen.length);
  await inParallel(
    chosen,
    APPLY_THREADS,
    async (t) => {
      let outcome: ApplyOutcome;
      let reason: string | null = null;
      try {
        const now = await client.get<Overview>(`/api/rs/testcase/${t.id}/overview`);
        const moved = t.changes.filter((c) => !sameRaw(currentRaw(now, c.key), c.currentRaw)).map((c) => c.label);
        if (moved.length) {
          outcome = "skipped";
          reason = `changed since the preview: ${moved.join(", ")}`;
        } else {
          const { patch, issues } = patchBody(t.changes);
          // Not repeated on failure: the write may have taken effect. A new preview shows what is left.
          if (Object.keys(patch).length) await client.patch(`/api/rs/testcase/${t.id}?v2=true`, patch);
          if (issues) await client.post(`/api/rs/testcase/${t.id}/issue`, issues.map((id) => ({ id })));
          outcome = "rolled back";
          ctx.log(`Rolled back ${t.id} ${t.name}: ${t.changes.map((c) => c.label).join(", ")}`);
        }
      } catch (e) {
        outcome = "failed";
        reason = message(e);
      }
      if (reason) ctx.warn(`Test case ${t.id} ${t.name}: ${outcome}, ${reason}`);
      summary[outcome === "rolled back" ? "rolledBack" : outcome]++;
      report.push({ id: t.id, name: t.name, outcome, reason, changes: t.changes });
      ctx.advance();
      ctx.summary(summary);
    },
    ctx.signal,
  );
  report.sort((a, b) => a.id - b.id);
  const name = `${safeFileName(`rollback-${plan.project.name}`)}.json`;
  const path = join(ctx.dir, name);
  await writeFile(path, JSON.stringify({ project: plan.project, options: plan.options, testCases: report }, null, 2));
  ctx.log(`${summary.rolledBack} rolled back, ${summary.skipped} skipped, ${summary.failed} failed`);
  return { path, name, contentType: "application/json" };
}

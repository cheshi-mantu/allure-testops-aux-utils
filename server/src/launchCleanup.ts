import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jobFile, type JobContext, type JobResult } from "./jobs.js";
import type { ApiEnvVarValue, ApiLaunch, ApiStatus } from "./launchReport/api.js";
import { safeFileName } from "./launchReport/export.js";
import { message } from "./launchReport/read.js";
import { mapLimit } from "./pool.js";
import { TestOpsError, type ApiProject, type TestOpsClient } from "./testops.js";

const DAY = 24 * 3600_000;
export const MAX_THREADS = 32;

export interface CleanupOptions {
  projectId: number;
  /** Launches created more than this many days ago go. */
  keepDays: number;
  /** AQL over launches, `true` for all. */
  aql: string;
  /** Leave launches that are not closed. */
  onlyClosed: boolean;
  /** Launches read or deleted at a time. */
  threads: number;
}

/** The AQL of the launches to delete; the cut-off is fixed when the list is made. */
export function cleanupAql(o: Pick<CleanupOptions, "aql" | "onlyClosed">, before: number): string {
  const filter = o.aql.trim() || "true";
  return `(${filter}) and createdDate < ${before}${o.onlyClosed ? " and closed = true" : ""}`;
}

export function cutoff(keepDays: number, now = Date.now()): number {
  return now - keepDays * DAY;
}

export class CleanupError extends Error {}

/** How many launches the options select right now. */
export async function countLaunches(client: TestOpsClient, o: CleanupOptions): Promise<number> {
  const check = await client.get<{ valid: boolean; count?: number }>("/api/rs/launch/query/validate", {
    projectId: String(o.projectId),
    rql: cleanupAql(o, cutoff(o.keepDays)),
  });
  if (!check.valid) throw new CleanupError("Allure TestOps does not accept this AQL filter");
  return check.count ?? 0;
}

export interface LaunchEntry {
  id: number;
  name: string;
  url: string;
  createdDate: number | null;
  createdBy: string | null;
  closed: boolean;
  tags: string[];
  env: string[];
  /** Test results by status; null when the counts could not be read. */
  statistic: Partial<Record<ApiStatus, number>> | null;
  results: number | null;
}

export interface CleanupPlan {
  project: ApiProject;
  options: CleanupOptions;
  /** Launches created before this go. */
  before: number;
  rql: string;
  launches: LaunchEntry[];
}

export interface ScanSummary {
  project: ApiProject;
  before: number;
  found: number;
  read: number;
  results: number;
}

async function search(client: TestOpsClient, projectId: number, rql: string): Promise<ApiLaunch[]> {
  return client.all<ApiLaunch>("/api/rs/launch/__search", { projectId: String(projectId), rql, sort: "created_date,asc" });
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(launches: LaunchEntry[]): string {
  const head = ["id", "name", "created", "created by", "closed", "tags", "environment", "results", "passed", "failed", "broken", "skipped", "unknown", "url"];
  const rows = launches.map((l) =>
    [
      l.id,
      l.name,
      l.createdDate ? new Date(l.createdDate).toISOString() : "",
      l.createdBy,
      l.closed,
      l.tags.join("; "),
      l.env.join("; "),
      l.results,
      l.statistic?.passed ?? 0,
      l.statistic?.failed ?? 0,
      l.statistic?.broken ?? 0,
      l.statistic?.skipped ?? 0,
      l.statistic?.unknown ?? 0,
      l.url,
    ]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...rows].join("\n") + "\n";
}

/** Dry run: lists the launches the options select, with their attributes, and changes nothing. */
export async function scanLaunches(shared: TestOpsClient, o: CleanupOptions, ctx: JobContext): Promise<JobResult[]> {
  const client = shared.withParallel(o.threads);
  ctx.phase("Finding launches");
  const project = await client.get<ApiProject>(`/api/rs/project/${o.projectId}`);
  const before = cutoff(o.keepDays);
  const rql = cleanupAql(o, before);
  ctx.title(`${project.name}: launches older than ${o.keepDays} days`);
  ctx.log(`AQL: ${rql}`);
  const check = await client.get<{ valid: boolean; count?: number }>("/api/rs/launch/query/validate", { projectId: String(o.projectId), rql });
  if (!check.valid) throw new CleanupError("Allure TestOps does not accept this AQL filter");
  // Oldest first, whatever order the server gives.
  const found = (await search(client, o.projectId, rql)).sort((a, b) => (a.createdDate ?? 0) - (b.createdDate ?? 0) || a.id - b.id);
  const summary: ScanSummary = { project, before, found: found.length, read: 0, results: 0 };
  ctx.summary(summary);
  ctx.log(`${found.length} launches to delete`);

  ctx.phase("Reading launch attributes", found.length);
  const launches = await mapLimit(found, o.threads, async (l): Promise<LaunchEntry> => {
    if (ctx.signal.aborted) throw new Error("Cancelled");
    const [env, stat] = await Promise.all([
      client.get<ApiEnvVarValue[]>(`/api/rs/launch/${l.id}/env`).catch(() => null),
      client.get<{ status: ApiStatus | null; count: number }[]>(`/api/rs/launch/${l.id}/statistic`).catch(() => null),
    ]);
    let statistic: LaunchEntry["statistic"] = null;
    if (stat) {
      const counts: Partial<Record<ApiStatus, number>> = {};
      for (const x of stat) counts[x.status ?? "unknown"] = (counts[x.status ?? "unknown"] ?? 0) + x.count;
      statistic = counts;
    }
    const results = stat ? stat.reduce((n, s) => n + s.count, 0) : null;
    summary.read++;
    summary.results += results ?? 0;
    ctx.advance();
    ctx.summary(summary);
    return {
      id: l.id,
      name: l.name,
      url: `${client.endpoint}/launch/${l.id}`,
      createdDate: l.createdDate ?? null,
      createdBy: l.createdBy ?? null,
      closed: Boolean(l.closed),
      tags: (l.tags ?? []).map((t) => t.name),
      env: (env ?? []).map((v) => `${v.variable?.name ?? "?"}=${v.name}`),
      statistic,
      results,
    };
  });

  const plan: CleanupPlan = { project, options: o, before, rql, launches };
  const base = safeFileName(`launches-to-delete-${project.name}`);
  const json = join(ctx.dir, `${base}.json`);
  const table = join(ctx.dir, `${base}.csv`);
  await writeFile(json, JSON.stringify(plan, null, 2));
  await writeFile(table, csv(launches));
  ctx.log(`${launches.length} launches with ${summary.results} test results`);
  return [
    { path: json, name: `${base}.json`, contentType: "application/json" },
    { path: table, name: `${base}.csv`, contentType: "text/csv" },
  ];
}

export class PlanError extends Error {}

export async function readCleanupPlan(jobId: string): Promise<CleanupPlan> {
  const file = jobFile(jobId, 0);
  if (!file) throw new PlanError("The dry run is gone; run it again");
  return JSON.parse(await readFile(file.path, "utf8")) as CleanupPlan;
}

export type DeleteOutcome = "deleted" | "skipped" | "failed";

export interface DeleteSummary {
  project: ApiProject;
  deleted: number;
  skipped: number;
  failed: number;
}

/** Whether a launch is still there; after a failed deletion it may be gone anyway. */
async function exists(client: TestOpsClient, id: number): Promise<boolean> {
  try {
    await client.get(`/api/rs/launch/${id}`);
    return true;
  } catch (e) {
    if (e instanceof TestOpsError && e.status === 404) return false;
    throw e;
  }
}

/**
 * Deletes the chosen launches of a dry run. The query of the dry run is made
 * again first: a launch that no longer matches it is left alone.
 */
export async function deleteLaunches(shared: TestOpsClient, plan: CleanupPlan, launchIds: number[], ctx: JobContext): Promise<JobResult> {
  const client = shared.withParallel(plan.options.threads);
  const wanted = new Set(launchIds);
  const chosen = plan.launches.filter((l) => wanted.has(l.id));
  ctx.title(`${plan.project.name}: deleting ${chosen.length} launches`);
  ctx.phase("Checking the launches again");
  const still = new Set((await search(client, plan.options.projectId, plan.rql)).map((l) => l.id));
  const summary: DeleteSummary = { project: plan.project, deleted: 0, skipped: 0, failed: 0 };
  const report: (LaunchEntry & { outcome: DeleteOutcome; reason: string | null })[] = [];
  ctx.summary(summary);

  ctx.phase("Deleting launches", chosen.length);
  await mapLimit(chosen, plan.options.threads, async (l) => {
    if (ctx.signal.aborted) throw new Error("Cancelled");
    let outcome: DeleteOutcome;
    let reason: string | null = null;
    if (!still.has(l.id)) {
      outcome = "skipped";
      reason = "no longer matches the filter, or is gone already";
    } else {
      try {
        await client.delete(`/api/rs/launch/${l.id}`);
        outcome = "deleted";
      } catch (e) {
        // Not repeated: the server may have deleted it all the same. Looking it up tells.
        const gone = await exists(client, l.id).then((x) => !x, () => false);
        outcome = gone ? "deleted" : "failed";
        reason = gone ? `though Allure TestOps answered: ${message(e)}` : message(e);
      }
    }
    if (outcome === "deleted") ctx.log(`Deleted ${l.id} ${l.name}`);
    if (reason) ctx.warn(`Launch ${l.id} ${l.name}: ${outcome}, ${reason}`);
    summary[outcome]++;
    report.push({ ...l, outcome, reason });
    ctx.advance();
    ctx.summary(summary);
  });

  report.sort((a, b) => a.id - b.id);
  const name = `${safeFileName(`deleted-launches-${plan.project.name}`)}.json`;
  const path = join(ctx.dir, name);
  await writeFile(path, JSON.stringify({ project: plan.project, options: plan.options, before: plan.before, rql: plan.rql, launches: report }, null, 2));
  ctx.log(`${summary.deleted} deleted, ${summary.skipped} skipped, ${summary.failed} failed`);
  return { path, name, contentType: "application/json" };
}

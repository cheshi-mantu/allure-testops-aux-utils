/** Launch lists and the values to filter them by. */
import type { ApiEnvVarValue, ApiLaunch, ApiStatus } from "./launchReport/api.js";
import { mapLimit } from "./pool.js";
import { TestOpsError, type Page, type TestOpsClient } from "./testops.js";

const LAUNCH_LIST_SIZE = 50;
const SUGGEST_SIZE = 50;

export interface LaunchRow {
  id: number;
  name: string;
  closed: boolean;
  createdDate: number | null;
  createdBy: string | null;
  tags: string[];
  env: { name: string; value: string }[];
  /** null when the counts could not be read. */
  statistic: { status: ApiStatus | null; count: number }[] | null;
}

export interface LaunchList {
  launches: LaunchRow[];
  /** All launches matching the filter; the latest `launches.length` are listed. */
  total: number;
}

export class InvalidAqlError extends Error {}

/** AQL string literal. */
export function aqlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Joins the user's AQL with the name or ID search box. */
export function launchQuery(aql: string, q: string): string {
  const parts: string[] = [];
  if (aql.trim()) parts.push(`(${aql.trim()})`);
  if (q) parts.push(/^\d+$/.test(q) ? `(id = ${q} or name ~= ${aqlString(q)})` : `name ~= ${aqlString(q)}`);
  return parts.join(" and ");
}

type PreviewLaunch = ApiLaunch & { environment?: ApiEnvVarValue[] | null };

function row(l: PreviewLaunch, env: ApiEnvVarValue[] | null, statistic: LaunchRow["statistic"]): LaunchRow {
  return {
    id: l.id,
    name: l.name,
    closed: Boolean(l.closed),
    createdDate: l.createdDate ?? null,
    createdBy: l.createdBy ?? null,
    tags: (l.tags ?? []).map((t) => t.name),
    env: (env ?? []).map((v) => ({ name: v.variable?.name ?? "", value: v.name })),
    statistic,
  };
}

/** The latest launches of a project, all of them or those matching the AQL and the search text. */
export async function listLaunches(c: TestOpsClient, projectId: number, aql: string, q: string): Promise<LaunchList> {
  const params = { projectId: String(projectId), page: "0", size: String(LAUNCH_LIST_SIZE), sort: "created_date,desc" };
  const rql = launchQuery(aql, q);
  if (!rql) {
    const page = await c.get<Page<PreviewLaunch>>("/api/rs/launch", { ...params, preview: "true" });
    return { launches: page.content.map((l) => row(l, l.environment ?? [], l.statistic ?? null)), total: page.totalElements };
  }
  const check = await c.get<{ valid: boolean; count?: number }>("/api/rs/launch/query/validate", { projectId: String(projectId), rql });
  if (!check.valid) throw new InvalidAqlError(`Invalid AQL: ${rql}`);
  const page = await c.get<Page<ApiLaunch>>("/api/rs/launch/__search", { ...params, rql });
  // Search results come without environment and counts: they are read per launch.
  const launches = await mapLimit(page.content, 8, async (l) => {
    const [env, statistic] = await Promise.all([
      c.get<ApiEnvVarValue[]>(`/api/rs/launch/${l.id}/env`).catch(() => null),
      c.get<{ status: ApiStatus | null; count: number }[]>(`/api/rs/launch/${l.id}/statistic`).catch(() => null),
    ]);
    return row(l, env, statistic);
  });
  return { launches, total: check.count ?? page.totalElements };
}

interface IdName {
  id: number;
  name: string;
}

async function suggest(c: TestOpsClient, path: string, params: Record<string, string>): Promise<IdName[]> {
  const page = await c.get<Page<IdName> | IdName[]>(path, { ...params, page: "0", size: String(SUGGEST_SIZE), sort: "name,asc" });
  return Array.isArray(page) ? page : page.content;
}

export function launchTags(c: TestOpsClient, projectId: number, query: string): Promise<IdName[]> {
  return suggest(c, "/api/rs/launch/tag/suggest", { projectId: String(projectId), query });
}

/** Environment variables are shared by all projects. */
export function envVars(c: TestOpsClient, query: string): Promise<IdName[]> {
  return suggest(c, "/api/rs/ev/suggest", { query });
}

export function envValues(c: TestOpsClient, projectId: number, envVarId: number, query: string): Promise<IdName[]> {
  return suggest(c, "/api/rs/evv/suggest", { projectId: String(projectId), envVarId: String(envVarId), query });
}

export function isBadRequest(e: unknown): boolean {
  return e instanceof TestOpsError && e.status === 400;
}

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobContext, JobResult } from "../jobs.js";
import { safeFileName } from "../launchReport/export.js";
import { message } from "../launchReport/read.js";
import type { ApiProject, TestOpsClient } from "../testops.js";
import { SECTIONS, type ActionKind, type CopyContext, type PlannedAction, type SectionKey } from "./sections.js";

export type TemplateTarget =
  | { mode: "new"; name: string; abbr: string; description: string; isPublic: boolean }
  | { mode: "existing"; projectId: number };

export interface TemplateOptions {
  sourceProjectId: number;
  target: TemplateTarget;
  sections: SectionKey[];
}

export interface ActionView {
  kind: ActionKind;
  name: string;
  detail: string | null;
}

export interface SectionPreview {
  key: SectionKey;
  label: string;
  description: string;
  actions: ActionView[];
  /** The section could not be read. */
  error: string | null;
}

export interface TemplatePreview {
  source: ApiProject;
  target: ApiProject | null;
  sections: SectionPreview[];
  warnings: string[];
}

export type Outcome = "done" | "failed" | "not needed";

export interface SectionSummary {
  key: SectionKey;
  label: string;
  counts: Record<ActionKind, number>;
  failed: number;
  error: string | null;
}

/** What the job reports as its summary. */
export interface TemplateSummary {
  sourceProject: ApiProject;
  targetProject: ApiProject | null;
  targetUrl: string | null;
  sections: SectionSummary[];
}

const view = (a: PlannedAction): ActionView => ({ kind: a.kind, name: a.name, detail: a.detail ?? null });

/** Thrown for a template that cannot be applied as asked; the API answers it with 400. */
export class TemplateError extends Error {}

/** Project names are unique in an Allure TestOps instance. */
async function checkNameFree(client: TestOpsClient, name: string): Promise<void> {
  const projects = await client.projects();
  if (projects.some((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    throw new TemplateError(`A project named "${name.trim()}" exists already; project names are unique, choose another one`);
  }
}

async function me(client: TestOpsClient): Promise<string> {
  const account = await client.get<{ username?: string }>("/api/uaa/account/me").catch(() => ({ username: "" }));
  return account.username ?? "";
}

function selected(o: TemplateOptions) {
  const wanted = new Set(o.sections);
  return SECTIONS.filter((s) => wanted.has(s.key));
}

/** What applying the template would do, without changing anything. */
export async function previewTemplate(client: TestOpsClient, o: TemplateOptions): Promise<TemplatePreview> {
  const warnings: string[] = [];
  const source = await client.get<ApiProject>(`/api/rs/project/${o.sourceProjectId}`);
  let target: ApiProject | null = null;
  if (o.target.mode === "existing") {
    if (o.target.projectId === o.sourceProjectId) throw new TemplateError("The source and the target are the same project");
    target = await client.get<ApiProject>(`/api/rs/project/${o.target.projectId}`);
  } else {
    await checkNameFree(client, o.target.name);
    warnings.push("A new project comes with defaults of Allure TestOps (a few custom fields, environment and role mappings, trees); those the source does not have are removed");
  }
  const ctx: CopyContext = { client, source: source.id, target: target?.id ?? null, fresh: o.target.mode === "new", me: await me(client), ids: new Map() };
  const sections: SectionPreview[] = [];
  for (const s of selected(o)) {
    try {
      sections.push({ key: s.key, label: s.label, description: s.description, actions: (await s.plan(ctx)).map(view), error: null });
    } catch (e) {
      sections.push({ key: s.key, label: s.label, description: s.description, actions: [], error: message(e) });
    }
  }
  return { source, target, sections, warnings };
}

interface ReportEntry extends ActionView {
  section: string;
  outcome: Outcome;
  error: string | null;
}

/** Applies the template: creates the target project if asked, then every chosen section in turn. */
export async function applyTemplate(client: TestOpsClient, o: TemplateOptions, ctx: JobContext): Promise<JobResult> {
  ctx.phase("Reading the source project");
  const source = await client.get<ApiProject>(`/api/rs/project/${o.sourceProjectId}`);
  let target: ApiProject;
  if (o.target.mode === "new") {
    ctx.phase("Creating the project");
    await checkNameFree(client, o.target.name);
    // Not repeated on failure: the project may have been created anyway.
    const created = await client.post<ApiProject>("/api/rs/project", {
      name: o.target.name.trim(),
      abbr: o.target.abbr.trim() || undefined,
      description: o.target.description.trim() || undefined,
      isPublic: o.target.isPublic,
    });
    if (!created) throw new Error("Allure TestOps did not return the created project");
    target = created;
    ctx.log(`Created project ${target.id} "${target.name}"`);
  } else {
    if (o.target.projectId === o.sourceProjectId) throw new TemplateError("The source and the target are the same project");
    target = await client.get<ApiProject>(`/api/rs/project/${o.target.projectId}`);
  }
  const targetUrl = `${client.endpoint}/project/${target.id}`;
  ctx.title(`${source.name} → ${target.name}`);

  const copy: CopyContext = { client, source: source.id, target: target.id, fresh: o.target.mode === "new", me: await me(client), ids: new Map() };
  const summary: TemplateSummary = { sourceProject: source, targetProject: target, targetUrl, sections: [] };
  const report: ReportEntry[] = [];
  for (const s of selected(o)) {
    if (ctx.signal.aborted) throw new Error("Cancelled");
    const counts: Record<ActionKind, number> = { create: 0, update: 0, remove: 0, skip: 0, manual: 0 };
    const entry: SectionSummary = { key: s.key, label: s.label, counts, failed: 0, error: null };
    summary.sections.push(entry);
    ctx.summary(summary);
    let actions: PlannedAction[];
    try {
      actions = await s.plan(copy);
    } catch (e) {
      entry.error = message(e);
      ctx.warn(`${s.label}: not copied, the source or the target could not be read: ${entry.error}`);
      continue;
    }
    ctx.phase(s.label, actions.filter((a) => a.run).length);
    for (const a of actions) {
      counts[a.kind]++;
      if (!a.run) {
        report.push({ section: s.label, ...view(a), outcome: "not needed", error: null });
        if (a.kind === "manual") ctx.warn(`${s.label}: ${a.name}: ${a.detail ?? ""}`);
        continue;
      }
      if (ctx.signal.aborted) throw new Error("Cancelled");
      try {
        await a.run();
        report.push({ section: s.label, ...view(a), outcome: "done", error: null });
        ctx.log(`${a.kind} ${a.name}`);
      } catch (e) {
        // A failed write is not repeated: it may have taken effect. Running the template again picks up from here.
        entry.failed++;
        report.push({ section: s.label, ...view(a), outcome: "failed", error: message(e) });
        ctx.warn(`${s.label}: ${a.kind} ${a.name} failed: ${message(e)}`);
      }
      ctx.advance();
      ctx.summary(summary);
    }
  }

  const name = `${safeFileName(`template-${source.name}-to-${target.name}`)}.json`;
  const path = join(ctx.dir, name);
  await writeFile(path, JSON.stringify({ source, target, targetUrl, sections: summary.sections, actions: report }, null, 2));
  const failed = report.filter((r) => r.outcome === "failed").length;
  ctx.log(failed ? `${failed} actions failed; running the template again retries them` : "All actions done");
  return { path, name, contentType: "application/json" };
}

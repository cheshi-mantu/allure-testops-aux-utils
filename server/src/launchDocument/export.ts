import { open } from "node:fs/promises";
import { join } from "node:path";
import type { JobContext, JobResult } from "../jobs.js";
import { safeFileName } from "../launchReport/export.js";
import type { ApiAttachmentRow, ApiEnvVarValue, ApiJobRun, ApiLaunch, ApiTestResult, ResultDetails } from "../launchReport/api.js";
import { attachmentRows, type AttachmentOwner } from "../launchReport/convert.js";
import { attachmentContentPath, checkCancelled, message, readResultDetails, warner, type ResultParts } from "../launchReport/read.js";
import { mapLimit } from "../pool.js";
import type { ApiProject, TestOpsClient } from "../testops.js";
import { PdfDocumentWriter } from "./pdf.js";
import {
  addEnvironment,
  attributesSection,
  contentsSection,
  documentEnd,
  documentStart,
  formatSize,
  jobRunTitle,
  resultSection,
  STATUS_ORDER,
  statusKey,
  SECTION_LABEL,
  type AttributesInput,
  type DocumentSections,
  type Embedded,
  type Environment,
  type JobRunGroup,
  type StatusKey,
} from "./render.js";

export interface LaunchDocumentOptions {
  launchId: number;
  /** Statuses to put into the document; empty means all. */
  statuses: StatusKey[];
  includeRetries: boolean;
  /** Images and text attachments are embedded; other types are only listed. */
  embedAttachments: boolean;
  maxAttachmentMb: number;
  /** Once this much is embedded, further attachments are only listed. */
  maxTotalAttachmentMb: number;
  /** A PDF next to the HTML page. */
  pdf: boolean;
  /** Optional parts of every test result; the assignee of manual tests is always there. */
  sections: DocumentSections;
}

/** Results are read and written this many at a time, so memory does not grow with the launch. */
const BATCH_SIZE = 100;
const CONCURRENCY = 8;
const MB = 1024 * 1024;

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|x-sh|x-ndjson)|[^;]*\+(json|xml))/i;

/** Attachments the document shows: all of them with the scenario, else only the test's own. */
function shownAttachments(d: ResultDetails, sections: DocumentSections): { owner: AttachmentOwner; row: ApiAttachmentRow }[] {
  if (!sections.attachments) return [];
  if (sections.scenario) return attachmentRows(d);
  return (d.scenario?.steps ?? []).flatMap((s) => (s.type === "attachment" && s.attachment && !s.attachment.missed ? [{ owner: "result" as const, row: s.attachment }] : []));
}

function embeddable(row: ApiAttachmentRow): "image" | "text" | null {
  const type = (row.contentType ?? "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (TEXT_TYPES.test(type)) return "text";
  return null;
}

export async function exportLaunchDocument(client: TestOpsClient, o: LaunchDocumentOptions, ctx: JobContext): Promise<JobResult[]> {
  const { warn, flush } = warner(ctx);

  ctx.phase("Reading the launch");
  const launch = await client.get<ApiLaunch>(`/api/rs/launch/${o.launchId}`);
  ctx.title(`Launch ${launch.id}: ${launch.name}`);
  const [project, launchEnv, jobRuns] = await Promise.all([
    client.get<ApiProject>(`/api/rs/project/${launch.projectId}`).catch(() => ({ id: launch.projectId, name: `Project ${launch.projectId}` })),
    client.get<ApiEnvVarValue[]>(`/api/rs/launch/${launch.id}/env`).catch((e: unknown) => {
      warn("env", `Launch environment is not exported: ${message(e)}`);
      return [];
    }),
    client.get<ApiJobRun[]>(`/api/rs/launch/${launch.id}/job`).catch((e: unknown) => {
      warn("jobs", `Job runs of the launch are not exported: ${message(e)}`);
      return [];
    }),
  ]);
  ctx.log(`Launch ${launch.id} "${launch.name}" of project ${launch.projectId}, ${jobRuns.length} job runs`);

  ctx.phase("Listing test results");
  const all = await client.all<ApiTestResult>("/api/rs/testresult", { launchId: String(launch.id), sort: "id,asc" });
  const omitted: string[] = [];
  let results = all;
  if (!o.includeRetries) {
    results = results.filter((r) => !r.hidden);
    if (results.length < all.length) omitted.push(`${all.length - results.length} earlier attempts of retried tests`);
  }
  if (o.statuses.length) {
    const before = results.length;
    const wanted = new Set(o.statuses);
    results = results.filter((r) => wanted.has(statusKey(r.status)));
    if (results.length < before) omitted.push(`${before - results.length} test results with other statuses`);
  }
  const leftOutSections = (Object.keys(SECTION_LABEL) as (keyof DocumentSections)[]).filter((k) => !o.sections[k]);
  if (leftOutSections.length) omitted.push(`Not included: ${leftOutSections.map((k) => SECTION_LABEL[k]).join(", ")}`);
  ctx.log(`${all.length} test results, ${results.length} go into the document`);
  if (results.length === 0) throw new Error("No test results to export: the launch is empty or the status filter leaves nothing");

  // Grouped by status as in the contents, by name inside a group.
  const rank = new Map(STATUS_ORDER.map((s, i) => [s, i]));
  results.sort((a, b) => rank.get(statusKey(a.status))! - rank.get(statusKey(b.status))! || a.name.localeCompare(b.name) || a.id - b.id);

  // With several job runs each gets its own environment, collected from its
  // test results before anything is written: the attributes come first.
  const perJobRun = jobRuns.length > 1;
  const environments = new Map<number, ApiEnvVarValue[]>();
  if (perJobRun) {
    ctx.phase("Reading environments of the test results", results.length);
    await mapLimit(results, CONCURRENCY, async (r) => {
      checkCancelled(ctx);
      const env = await client.get<ApiEnvVarValue[]>(`/api/rs/testresult/${r.id}/evv`).catch((e: unknown) => {
        warn("environment", `Test result ${r.id} "${r.name}": environment not exported: ${message(e)}`);
        return [];
      });
      environments.set(r.id, env);
      ctx.advance();
    });
  }
  const jobRunById = new Map(jobRuns.map((j) => [j.id, j]));
  const groups = new Map<number | null, JobRunGroup>(jobRuns.map((j) => [j.id, { jobRun: j, results: 0, environment: new Map() as Environment }]));
  for (const r of results) {
    const id = r.jobRun?.id ?? null;
    if (!groups.has(id)) groups.set(id, { jobRun: id != null ? { id, name: r.jobRun?.name, url: r.jobRun?.url } : null, results: 0, environment: new Map() });
    const g = groups.get(id)!;
    g.results++;
    addEnvironment(g.environment, environments.get(r.id) ?? []);
  }
  const jobRunName = (r: ApiTestResult) => {
    const j = r.jobRun?.id != null ? jobRunById.get(r.jobRun.id) : undefined;
    return j ? jobRunTitle(j) : (r.jobRun?.name ?? null);
  };

  const counts = { byStatus: new Map<StatusKey, number>(), total: results.length };
  for (const r of results) counts.byStatus.set(statusKey(r.status), (counts.byStatus.get(statusKey(r.status)) ?? 0) + 1);
  const launchEnvironment: Environment = new Map();
  addEnvironment(launchEnvironment, launchEnv);
  const attributes: AttributesInput = {
    launch,
    projectName: project.name,
    launchEnvironment,
    jobRuns: [...groups.values()].filter((g) => g.jobRun || g.results > 0),
    counts,
    omitted,
  };

  let embeddedTotal = 0;
  let budgetWarned = false;
  const totalLimit = o.maxTotalAttachmentMb > 0 ? o.maxTotalAttachmentMb * MB : Infinity;
  const perLimit = o.maxAttachmentMb > 0 ? o.maxAttachmentMb * MB : Infinity;
  // Shared by both documents, replaced for every batch.
  let embedded = new Map<string, Embedded>();
  const renderCtx = {
    endpoint: client.endpoint,
    projectId: launch.projectId,
    sections: o.sections,
    attachment: (owner: AttachmentOwner, row: ApiAttachmentRow): Embedded =>
      embedded.get(`${owner}:${row.id}`) ?? { kind: "none", reason: "Attachments are not embedded in this document." },
  };

  const baseName = `${safeFileName(`launch-${launch.id}-${launch.name}`)}-document`;
  const htmlFile: JobResult = { path: join(ctx.dir, `${baseName}.html`), name: `${baseName}.html`, contentType: "text/html; charset=utf-8" };
  const pdfFile: JobResult = { path: join(ctx.dir, `${baseName}.pdf`), name: `${baseName}.pdf`, contentType: "application/pdf" };
  const html = await open(htmlFile.path, "w");
  const pdf = o.pdf ? new PdfDocumentWriter(pdfFile.path, launch.name, renderCtx) : null;
  try {
    ctx.phase("Writing the attributes and contents");
    await html.write(documentStart(launch, client.endpoint) + attributesSection(attributes) + contentsSection(results));
    pdf?.header(launch.id, launch.name);
    pdf?.attributes(attributes);
    pdf?.contents(results);

    // Parts left out of the document are not read at all.
    const parts: ResultParts = {
      scenario: o.sections.scenario || o.sections.attachments,
      fixtures: o.sections.scenario,
      customFields: o.sections.customFields,
      members: true,
      issues: true,
      // With several job runs the environments are read already.
      environment: o.sections.environment && !perJobRun,
    };
    ctx.phase("Reading and writing test results", results.length);
    for (let start = 0; start < results.length; start += BATCH_SIZE) {
      checkCancelled(ctx);
      const batch = results.slice(start, start + BATCH_SIZE);
      const details = await mapLimit(batch, CONCURRENCY, async (r) => {
        checkCancelled(ctx);
        const d = await readResultDetails(client, r, warn, parts);
        if (perJobRun) d.environment = environments.get(r.id) ?? [];
        return d;
      });

      embedded = new Map();
      if (o.embedAttachments && o.sections.attachments) {
        const rows = new Map<string, { owner: AttachmentOwner; row: ApiAttachmentRow }>();
        for (const d of details) for (const a of shownAttachments(d, o.sections)) rows.set(`${a.owner}:${a.row.id}`, a);
        const wanted: { key: string; owner: AttachmentOwner; row: ApiAttachmentRow; kind: "image" | "text" }[] = [];
        for (const [key, { owner, row }] of rows) {
          const kind = embeddable(row);
          const size = row.contentLength ?? 0;
          if (!kind) embedded.set(key, { kind: "none", reason: "This type of attachment is not embedded." });
          else if (size > perLimit) embedded.set(key, { kind: "none", reason: `Larger than ${o.maxAttachmentMb} MB, not embedded.` });
          else if (embeddedTotal + size > totalLimit) {
            embedded.set(key, { kind: "none", reason: `Not embedded: the document reached ${o.maxTotalAttachmentMb} MB of attachments.` });
            if (!budgetWarned) warn("budget", `${o.maxTotalAttachmentMb} MB of attachments are embedded; further ones are only listed`);
            budgetWarned = true;
          } else {
            embeddedTotal += size;
            wanted.push({ key, owner, row, kind });
          }
        }
        await mapLimit(wanted, CONCURRENCY, async ({ key, owner, row, kind }) => {
          try {
            const content = await client.download(attachmentContentPath(owner, row.id));
            embeddedTotal += content.length - (row.contentLength ?? 0);
            if (content.length > perLimit) {
              embedded.set(key, { kind: "none", reason: `Larger than ${o.maxAttachmentMb} MB, not embedded.` });
              return;
            }
            const type = (row.contentType ?? "application/octet-stream").split(";")[0].trim();
            embedded.set(key, kind === "image" ? { kind, type, data: content } : { kind, text: content.toString("utf8") });
          } catch (e) {
            embedded.set(key, { kind: "none", reason: `Could not be read: ${message(e)}` });
            warn("attachments", `Attachment "${row.name}" (${row.id}) is not embedded: ${message(e)}`);
          }
        });
      }

      let chunk = "";
      for (const d of details) {
        const name = jobRunName(d.result);
        chunk += resultSection(d, renderCtx, name);
        pdf?.result(d, name);
      }
      await html.write(chunk);
      ctx.advance(batch.length);
    }
    await html.write(documentEnd());
  } finally {
    await html.close();
    if (pdf) await pdf.close();
  }
  if (o.embedAttachments) ctx.log(`${formatSize(embeddedTotal)} of attachments embedded`);
  if (pdf) ctx.log(`PDF: ${pdf.pages} pages`);
  flush();
  return pdf ? [htmlFile, pdfFile] : [htmlFile];
}

import { createReadStream, createWriteStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { JobContext, JobResult } from "../jobs.js";
import { safeFileName } from "../launchReport/export.js";
import type { ApiAttachmentRow, ApiEnvVarValue, ApiJobRun, ApiLaunch, ApiTestResult } from "../launchReport/api.js";
import { attachmentRows, type AttachmentOwner } from "../launchReport/convert.js";
import { attachmentContentPath, checkCancelled, message, readResultDetails, warner } from "../launchReport/read.js";
import { mapLimit } from "../pool.js";
import type { ApiProject, TestOpsClient } from "../testops.js";
import {
  addEnvironment,
  attributesSection,
  contentsSection,
  documentEnd,
  documentStart,
  formatSize,
  resultSection,
  STATUS_ORDER,
  statusKey,
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
}

/** Results are read and written this many at a time, so memory does not grow with the launch. */
const BATCH_SIZE = 100;
const CONCURRENCY = 8;
const MB = 1024 * 1024;

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|x-sh|x-ndjson)|[^;]*\+(json|xml))/i;

function embeddable(row: ApiAttachmentRow): "image" | "text" | null {
  const type = (row.contentType ?? "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (TEXT_TYPES.test(type)) return "text";
  return null;
}

export async function exportLaunchDocument(client: TestOpsClient, o: LaunchDocumentOptions, ctx: JobContext): Promise<JobResult> {
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
  ctx.log(`${all.length} test results, ${results.length} go into the document`);
  if (results.length === 0) throw new Error("No test results to export: the launch is empty or the status filter leaves nothing");

  // Grouped by status as in the contents, by name inside a group.
  const rank = new Map(STATUS_ORDER.map((s, i) => [s, i]));
  results.sort((a, b) => rank.get(statusKey(a.status))! - rank.get(statusKey(b.status))! || a.name.localeCompare(b.name) || a.id - b.id);

  // With several job runs each gets its own environment, collected from its test results.
  const perJobRun = jobRuns.length > 1;
  const jobRunById = new Map(jobRuns.map((j) => [j.id, j]));
  const groups = new Map<number | null, JobRunGroup>(jobRuns.map((j) => [j.id, { jobRun: j, results: 0, environment: new Map() as Environment }]));
  const jobRunName = (id: number | null | undefined) => {
    const j = id != null ? jobRunById.get(id) : undefined;
    return j ? [j.job?.name, j.name].filter(Boolean).join(" ") || `Job run ${j.id}` : null;
  };

  let embeddedTotal = 0;
  let budgetWarned = false;
  const totalLimit = o.maxTotalAttachmentMb > 0 ? o.maxTotalAttachmentMb * MB : Infinity;
  const perLimit = o.maxAttachmentMb > 0 ? o.maxAttachmentMb * MB : Infinity;

  const bodyPath = join(ctx.dir, "body.html");
  const body = await open(bodyPath, "w");
  try {
    ctx.phase("Reading test results", results.length);
    for (let start = 0; start < results.length; start += BATCH_SIZE) {
      checkCancelled(ctx);
      const batch = results.slice(start, start + BATCH_SIZE);
      const details = await mapLimit(batch, CONCURRENCY, async (r) => {
        checkCancelled(ctx);
        return readResultDetails(client, r, warn, perJobRun);
      });

      const embedded = new Map<string, Embedded>();
      if (o.embedAttachments) {
        const rows = new Map<string, { owner: AttachmentOwner; row: ApiAttachmentRow }>();
        for (const d of details) for (const a of attachmentRows(d)) rows.set(`${a.owner}:${a.row.id}`, a);
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
            embedded.set(key, kind === "image" ? { kind, dataUri: `data:${type};base64,${content.toString("base64")}` } : { kind, text: content.toString("utf8") });
          } catch (e) {
            embedded.set(key, { kind: "none", reason: `Could not be read: ${message(e)}` });
            warn("attachments", `Attachment "${row.name}" (${row.id}) is not embedded: ${message(e)}`);
          }
        });
      }

      const renderCtx = {
        endpoint: client.endpoint,
        projectId: launch.projectId,
        attachment: (owner: AttachmentOwner, row: ApiAttachmentRow): Embedded =>
          embedded.get(`${owner}:${row.id}`) ?? { kind: "none", reason: "Attachments are not embedded in this document." },
      };
      let html = "";
      for (const d of details) {
        const jobRunId = d.result.jobRun?.id ?? null;
        if (!groups.has(jobRunId)) groups.set(jobRunId, { jobRun: jobRunId != null ? (jobRunById.get(jobRunId) ?? { id: jobRunId, name: d.result.jobRun?.name, url: d.result.jobRun?.url }) : null, results: 0, environment: new Map() });
        const g = groups.get(jobRunId)!;
        g.results++;
        addEnvironment(g.environment, d.environment ?? []);
        html += resultSection(d, renderCtx, jobRunName(jobRunId) ?? d.result.jobRun?.name ?? null);
      }
      await body.write(html);
      ctx.advance(batch.length);
    }
  } finally {
    await body.close();
  }
  if (o.embedAttachments) ctx.log(`${formatSize(embeddedTotal)} of attachments embedded`);
  flush();

  ctx.phase("Assembling the document");
  const counts = { byStatus: new Map<StatusKey, number>(), total: results.length };
  for (const r of results) counts.byStatus.set(statusKey(r.status), (counts.byStatus.get(statusKey(r.status)) ?? 0) + 1);
  const launchEnvironment: Environment = new Map();
  addEnvironment(launchEnvironment, launchEnv);
  const jobRunGroups = [...groups.values()].filter((g) => g.jobRun || g.results > 0);
  const head =
    documentStart(launch, client.endpoint) +
    attributesSection({ launch, projectName: project.name, launchEnvironment, jobRuns: jobRunGroups, counts, omitted }) +
    contentsSection(results);

  const fileName = `${safeFileName(`launch-${launch.id}-${launch.name}`)}-document.html`;
  const path = join(ctx.dir, fileName);
  const out = await open(path, "w");
  await out.write(head);
  await out.close();
  await pipeline(createReadStream(bodyPath), createWriteStream(path, { flags: "a" }));
  const tail = await open(path, "a");
  await tail.write(documentEnd());
  await tail.close();
  await rm(bodyPath, { force: true });
  return { path, name: fileName, contentType: "text/html; charset=utf-8" };
}

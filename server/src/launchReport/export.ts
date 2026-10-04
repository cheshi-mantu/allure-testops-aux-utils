import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobContext, JobResult } from "../jobs.js";
import { mapLimit } from "../pool.js";
import type { TestOpsClient } from "../testops.js";
import type { ApiAttachmentRow, ApiEnvVarValue, ApiLaunch, ApiTestResult } from "./api.js";
import {
  attachmentExtension,
  attachmentRows,
  convertResult,
  environmentProperties,
  groupByLabels,
  type AttachmentOwner,
  type GroupBy,
} from "./convert.js";
import { generateSingleFileReport } from "./generate.js";
import { attachmentContentPath, checkCancelled as checkCancelledJob, message, readResultDetails, warner } from "./read.js";

export interface LaunchReportOptions {
  launchId: number;
  /** The launch name when empty. */
  reportName: string;
  includeAttachments: boolean;
  /** Larger attachments are left out; 0 means no limit. */
  maxAttachmentMb: number;
  /** Earlier attempts of retried tests, shown as retries in the report. */
  includeRetries: boolean;
  groupBy: GroupBy;
  theme: "auto" | "light" | "dark";
}

/** Results are read this many at a time; each takes several requests, which the client throttles. */
const RESULT_CONCURRENCY = 8;
export function attachmentFileName(owner: AttachmentOwner, row: ApiAttachmentRow): string {
  return `${owner}-${row.id}-attachment${attachmentExtension(row)}`;
}

export async function exportLaunchReport(client: TestOpsClient, o: LaunchReportOptions, ctx: JobContext): Promise<JobResult> {
  const { warn, flush } = warner(ctx);
  const checkCancelled = () => checkCancelledJob(ctx);

  ctx.phase("Reading the launch");
  const launch = await client.get<ApiLaunch>(`/api/rs/launch/${o.launchId}`);
  const env = await client.get<ApiEnvVarValue[]>(`/api/rs/launch/${o.launchId}/env`).catch((e: unknown) => {
    warn("env", `Launch environment is not exported: ${message(e)}`);
    return [];
  });
  ctx.title(`Launch ${launch.id}: ${launch.name}`);
  ctx.log(`Launch ${launch.id} "${launch.name}" of project ${launch.projectId}`);

  ctx.phase("Listing test results");
  const all = await client.all<ApiTestResult>("/api/rs/testresult", { launchId: String(o.launchId), sort: "id,asc" });
  const results = o.includeRetries ? all : all.filter((r) => !r.hidden);
  ctx.log(`${all.length} test results, ${all.length - results.length} earlier retries left out`);
  if (results.length === 0) throw new Error("The launch has no test results");

  ctx.phase("Reading test result details", results.length);
  const details = await mapLimit(results, RESULT_CONCURRENCY, async (result) => {
    checkCancelled();
    const d = await readResultDetails(client, result, warn);
    ctx.advance();
    return d;
  });

  const resultsDir = join(ctx.dir, "allure-results");
  await mkdir(resultsDir, { recursive: true });

  const saved = new Set<string>();
  if (o.includeAttachments) {
    const unique = new Map<string, { owner: AttachmentOwner; row: ApiAttachmentRow }>();
    for (const d of details) for (const a of attachmentRows(d)) unique.set(`${a.owner}:${a.row.id}`, a);
    const limit = o.maxAttachmentMb > 0 ? o.maxAttachmentMb * 1024 * 1024 : Infinity;
    const wanted = [...unique.values()].filter((a) => {
      if ((a.row.contentLength ?? 0) <= limit) return true;
      warn("large", `Attachment "${a.row.name}" (${mb(a.row.contentLength ?? 0)}) is larger than ${o.maxAttachmentMb} MB and left out`);
      return false;
    });
    ctx.phase("Downloading attachments", wanted.length);
    await mapLimit(wanted, RESULT_CONCURRENCY, async ({ owner, row }) => {
      checkCancelled();
      try {
        const content = await client.download(attachmentContentPath(owner, row.id));
        const name = attachmentFileName(owner, row);
        await writeFile(join(resultsDir, name), content);
        saved.add(name);
      } catch (e) {
        warn("attachments", `Attachment "${row.name}" (${row.id}) is not exported: ${message(e)}`);
      }
      ctx.advance();
    });
  }

  ctx.phase("Writing Allure results", details.length);
  const convertCtx = {
    endpoint: client.endpoint,
    projectId: launch.projectId,
    attachment: (owner: AttachmentOwner, row: ApiAttachmentRow) => {
      const name = attachmentFileName(owner, row);
      return saved.has(name) ? name : null;
    },
  };
  const converted = details.map((d) => convertResult(d, convertCtx));
  for (const { result, container } of converted) {
    checkCancelled();
    await writeFile(join(resultsDir, `${result.uuid}-result.json`), JSON.stringify(result));
    if (container) await writeFile(join(resultsDir, `${container.uuid}-container.json`), JSON.stringify(container));
    ctx.advance();
  }
  if (env.length) await writeFile(join(resultsDir, "environment.properties"), environmentProperties(env));
  await writeFile(
    join(resultsDir, "executor.json"),
    JSON.stringify({ name: "Allure TestOps", type: "allure-testops", buildName: launch.name, buildUrl: `${client.endpoint}/launch/${launch.id}` }),
  );

  flush();

  checkCancelled();
  ctx.phase("Generating the report");
  const name = o.reportName.trim() || launch.name;
  const groupBy = groupByLabels(o.groupBy, converted.map((c) => c.result));
  ctx.log(`Grouping by ${groupBy.length ? groupBy.join(" → ") : "nothing (flat list)"}`);
  const outputDir = join(ctx.dir, "report");
  await generateSingleFileReport({ resultsDir, outputDir, cwd: ctx.dir, name, groupBy, theme: o.theme });

  const fileName = `${safeFileName(`launch-${launch.id}-${launch.name}`)}.html`;
  const path = join(ctx.dir, fileName);
  await rename(join(outputDir, "index.html"), path);
  await rm(resultsDir, { recursive: true, force: true });
  await rm(outputDir, { recursive: true, force: true });
  return { path, name: fileName, contentType: "text/html; charset=utf-8" };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function safeFileName(name: string): string {
  return (
    name
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 120) || "report"
  );
}

import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getConfig, isConfigured, normalizeEndpoint, saveConfig, toPublic } from "./config.js";
import { cancelJob, deleteJob, getJob, jobFile, listJobs, removeOrphanedJobDirs, startJob } from "./jobs.js";
import { exportLaunchDocument, type LaunchDocumentOptions } from "./launchDocument/export.js";
import { STATUS_ORDER, type DocumentSections, type StatusKey } from "./launchDocument/render.js";
import { exportLaunchReport, type LaunchReportOptions } from "./launchReport/export.js";
import { envValues, envVars, InvalidAqlError, isBadRequest, launchTags, listLaunches } from "./launches.js";
import { TestOpsClient, TestOpsError } from "./testops.js";

let client: TestOpsClient | null = null;

function currentClient(): TestOpsClient {
  const cfg = getConfig();
  if (!client || client.endpoint !== cfg.endpoint) client = new TestOpsClient(cfg.endpoint, cfg.token);
  return client;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requireConfigured(): void {
  if (!isConfigured()) throw new HttpError(409, "Allure TestOps connection is not configured");
}

function parseConnection(body: Record<string, unknown>): { endpoint: string; token: string } {
  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(String(body.endpoint ?? ""));
  } catch {
    throw new HttpError(400, "Invalid endpoint: expected a URL like https://testops.example.com");
  }
  const token = String(body.token ?? "").trim() || getConfig().token;
  if (!token) throw new HttpError(400, "API token is required");
  return { endpoint, token };
}

async function probe(endpoint: string, token: string): Promise<number> {
  try {
    const page = await new TestOpsClient(endpoint, token).get<{ totalElements: number }>("/api/rs/project", { size: "1" });
    return page.totalElements;
  } catch (e) {
    throw new HttpError(502, `Cannot connect to Allure TestOps: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function positiveInt(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `${what} must be a positive integer`);
  return n;
}

const app = express();
app.use(express.json());

app.get("/api/config", (_req, res) => {
  res.json(toPublic(getConfig()));
});

app.post("/api/config/test", async (req, res) => {
  const { endpoint, token } = parseConnection(req.body ?? {});
  res.json({ projects: await probe(endpoint, token) });
});

app.put("/api/config", async (req, res) => {
  const { endpoint, token } = parseConnection(req.body ?? {});
  const prev = getConfig();
  if (endpoint !== prev.endpoint || token !== prev.token) {
    await probe(endpoint, token);
    client = null;
  }
  saveConfig({ endpoint, token });
  res.json(toPublic(getConfig()));
});

app.get("/api/projects", async (_req, res) => {
  requireConfigured();
  res.json(await currentClient().projects());
});

/** Latest launches of a project, filtered by AQL and by part of the name or ID. */
app.get("/api/projects/:projectId/launches", async (req, res) => {
  requireConfigured();
  const projectId = positiveInt(req.params.projectId, "Project ID");
  const aql = String(req.query.aql ?? "");
  const q = String(req.query.q ?? "").trim();
  try {
    res.json(await listLaunches(currentClient(), projectId, aql, q));
  } catch (e) {
    if (e instanceof InvalidAqlError || isBadRequest(e)) throw new HttpError(400, e instanceof Error ? e.message : String(e));
    throw e;
  }
});

app.get("/api/projects/:projectId/launch-tags", async (req, res) => {
  requireConfigured();
  res.json(await launchTags(currentClient(), positiveInt(req.params.projectId, "Project ID"), String(req.query.q ?? "")));
});

app.get("/api/env-vars", async (req, res) => {
  requireConfigured();
  res.json(await envVars(currentClient(), String(req.query.q ?? "")));
});

app.get("/api/projects/:projectId/env-vars/:envVarId/values", async (req, res) => {
  requireConfigured();
  const projectId = positiveInt(req.params.projectId, "Project ID");
  const envVarId = positiveInt(req.params.envVarId, "Environment variable ID");
  res.json(await envValues(currentClient(), projectId, envVarId, String(req.query.q ?? "")));
});

const GROUP_BY = ["auto", "suites", "behaviors", "packages", "none"] as const;
const THEMES = ["auto", "light", "dark"] as const;

function parseLaunchReport(body: Record<string, unknown>): LaunchReportOptions {
  const groupBy = String(body.groupBy ?? "auto");
  const theme = String(body.theme ?? "auto");
  const maxAttachmentMb = Number(body.maxAttachmentMb ?? 0);
  if (!(GROUP_BY as readonly string[]).includes(groupBy)) throw new HttpError(400, `groupBy must be one of ${GROUP_BY.join(", ")}`);
  if (!(THEMES as readonly string[]).includes(theme)) throw new HttpError(400, `theme must be one of ${THEMES.join(", ")}`);
  if (!Number.isFinite(maxAttachmentMb) || maxAttachmentMb < 0) throw new HttpError(400, "maxAttachmentMb must be 0 or more");
  return {
    launchId: positiveInt(body.launchId, "Launch ID"),
    reportName: String(body.reportName ?? ""),
    includeAttachments: body.includeAttachments !== false,
    maxAttachmentMb,
    includeRetries: body.includeRetries !== false,
    groupBy: groupBy as LaunchReportOptions["groupBy"],
    theme: theme as LaunchReportOptions["theme"],
  };
}

app.post("/api/launch-report", (req, res) => {
  requireConfigured();
  const options = parseLaunchReport(req.body ?? {});
  const c = currentClient();
  res.status(202).json(startJob("launch-report", `Launch ${options.launchId}`, (ctx) => exportLaunchReport(c, options, ctx)));
});

function nonNegative(value: unknown, fallback: number, what: string): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${what} must be 0 or more`);
  return n;
}

/** All sections unless switched off one by one. */
function parseSections(value: unknown): DocumentSections {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { scenario: v.scenario !== false, customFields: v.customFields !== false, environment: v.environment !== false, attachments: v.attachments !== false };
}

function parseLaunchDocument(body: Record<string, unknown>): LaunchDocumentOptions {
  const statuses = Array.isArray(body.statuses) ? body.statuses.map(String) : [];
  const unknown = statuses.filter((s) => !(STATUS_ORDER as string[]).includes(s));
  if (unknown.length) throw new HttpError(400, `Unknown statuses: ${unknown.join(", ")}`);
  return {
    launchId: positiveInt(body.launchId, "Launch ID"),
    statuses: statuses as StatusKey[],
    includeRetries: body.includeRetries === true,
    embedAttachments: body.embedAttachments !== false,
    maxAttachmentMb: nonNegative(body.maxAttachmentMb, 2, "maxAttachmentMb"),
    maxTotalAttachmentMb: nonNegative(body.maxTotalAttachmentMb, 200, "maxTotalAttachmentMb"),
    pdf: body.pdf !== false,
    sections: parseSections(body.sections),
  };
}

app.post("/api/launch-document", (req, res) => {
  requireConfigured();
  const options = parseLaunchDocument(req.body ?? {});
  const c = currentClient();
  res.status(202).json(startJob("launch-document", `Launch ${options.launchId}`, (ctx) => exportLaunchDocument(c, options, ctx)));
});

app.get("/api/jobs", (req, res) => {
  res.json(listJobs(req.query.kind ? String(req.query.kind) : undefined));
});

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw new HttpError(404, "Job not found");
  res.json(job);
});

app.get(["/api/jobs/:id/file", "/api/jobs/:id/files/:index"], (req, res) => {
  const index = req.params.index === undefined ? 0 : Number(req.params.index);
  const file = Number.isSafeInteger(index) ? jobFile(String(req.params.id), index) : null;
  if (!file) throw new HttpError(404, "The job has no file to download");
  // `inline` opens the file in the browser instead of saving it.
  if (req.query.inline === "true") res.type(file.contentType).sendFile(file.path);
  else res.download(file.path, file.name);
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  if (!cancelJob(req.params.id)) throw new HttpError(409, "The job is not running");
  res.json(getJob(req.params.id));
});

app.delete("/api/jobs/:id", (req, res) => {
  if (!deleteJob(req.params.id)) throw new HttpError(404, "Job not found");
  res.status(204).end();
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found")));

const webRoot = process.env.WEB_DIR ?? join(process.cwd(), "web", "dist");
if (existsSync(webRoot)) {
  app.use(express.static(webRoot));
  app.get("/{*path}", (_req, res) => res.sendFile(join(webRoot, "index.html")));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
  } else if (err instanceof TestOpsError) {
    res.status(502).json({ error: err.message });
  } else {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

await removeOrphanedJobDirs();

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`Allure TestOps aux utils listening on :${port}`);
});

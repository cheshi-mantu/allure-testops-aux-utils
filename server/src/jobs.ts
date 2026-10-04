import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./config.js";

/** Finished jobs and their files are dropped after this time. */
const JOB_TTL_MS = 24 * 3600_000;
const MAX_LOG_LINES = 500;

export type JobState = "running" | "done" | "failed" | "cancelled";

export interface JobFile {
  name: string;
  size: number;
  contentType: string;
}

/** What the UI sees of a job. */
export interface JobView {
  id: string;
  kind: string;
  title: string;
  state: JobState;
  phase: string;
  done: number;
  total: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  warnings: string[];
  log: string[];
  /** Files to download once the job is done, the main one first. */
  files: JobFile[];
}

/** Handed to the job body to report progress and check for cancellation. */
export interface JobContext {
  /** A scratch directory of the job, removed together with the job. */
  dir: string;
  signal: AbortSignal;
  /** Replaces the title given at the start, e.g. once a name is known. */
  title(title: string): void;
  phase(name: string, total?: number): void;
  advance(by?: number): void;
  log(line: string): void;
  warn(line: string): void;
}

export interface JobResult {
  /** Absolute path of the file offered for download. */
  path: string;
  name: string;
  contentType: string;
}

class Job {
  readonly id = randomUUID();
  readonly dir = join(dataDir, "jobs", this.id);
  readonly controller = new AbortController();
  state: JobState = "running";
  phase = "Starting";
  done = 0;
  total = 0;
  readonly startedAt = Date.now();
  finishedAt: number | null = null;
  error: string | null = null;
  readonly warnings: string[] = [];
  readonly log: string[] = [];
  files: (JobResult & { size: number })[] = [];

  constructor(
    readonly kind: string,
    public title: string,
  ) {}

  view(): JobView {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      state: this.state,
      phase: this.phase,
      done: this.done,
      total: this.total,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this.error,
      warnings: this.warnings.slice(0, MAX_LOG_LINES),
      log: this.log.slice(-MAX_LOG_LINES),
      files: this.files.map((f) => ({ name: f.name, size: f.size, contentType: f.contentType })),
    };
  }
}

const jobs = new Map<string, Job>();

export function startJob(kind: string, title: string, body: (ctx: JobContext) => Promise<JobResult | JobResult[] | null>): JobView {
  prune();
  const job = new Job(kind, title);
  jobs.set(job.id, job);
  mkdirSync(job.dir, { recursive: true });
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const ctx: JobContext = {
    dir: job.dir,
    signal: job.controller.signal,
    title(title) {
      job.title = title;
    },
    phase(name, total = 0) {
      job.phase = name;
      job.done = 0;
      job.total = total;
      job.log.push(`${stamp()} ${name}${total ? ` (${total})` : ""}`);
    },
    advance(by = 1) {
      job.done += by;
    },
    log(line) {
      job.log.push(`${stamp()} ${line}`);
    },
    warn(line) {
      job.warnings.push(line);
      job.log.push(`${stamp()} WARN ${line}`);
    },
  };
  void body(ctx).then(
    (result) => {
      job.files = (Array.isArray(result) ? result : result ? [result] : []).map((f) => ({ ...f, size: statSync(f.path).size }));
      job.state = job.controller.signal.aborted ? "cancelled" : "done";
      job.phase = job.state === "done" ? "Done" : "Cancelled";
    },
    (e: unknown) => {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.phase = job.state === "cancelled" ? "Cancelled" : "Failed";
      job.error = job.state === "failed" ? (e instanceof Error ? e.message : String(e)) : null;
      if (job.state === "failed") console.error(`Job ${job.kind} ${job.id} failed`, e);
    },
  ).finally(() => {
    job.finishedAt = Date.now();
    job.log.push(`${stamp()} ${job.phase}`);
  });
  return job.view();
}

export function getJob(id: string): JobView | null {
  return jobs.get(id)?.view() ?? null;
}

export function listJobs(kind?: string): JobView[] {
  return [...jobs.values()]
    .filter((j) => !kind || j.kind === kind)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((j) => j.view());
}

export function jobFile(id: string, index = 0): JobResult | null {
  const job = jobs.get(id);
  return job?.state === "done" ? (job.files[index] ?? null) : null;
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.state !== "running") return false;
  job.controller.abort();
  return true;
}

export function deleteJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.controller.abort();
  jobs.delete(id);
  rmSync(job.dir, { recursive: true, force: true });
  return true;
}

function prune(): void {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.finishedAt !== null && now - job.finishedAt > JOB_TTL_MS) deleteJob(job.id);
  }
}

/** Jobs live in memory: directories left by a previous run of the server are removed. */
export async function removeOrphanedJobDirs(): Promise<void> {
  const root = join(dataDir, "jobs");
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const name of entries) {
    if (!jobs.has(name)) rmSync(join(root, name), { recursive: true, force: true });
  }
}

setInterval(prune, 3600_000).unref();

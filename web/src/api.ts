export interface PublicConfig {
  endpoint: string;
  tokenSet: boolean;
  tokenHint: string;
}

export interface Project {
  id: number;
  name: string;
}

export interface IdName {
  id: number;
  name: string;
}

export type ResultStatus = "passed" | "failed" | "broken" | "skipped" | "unknown";

export interface LaunchRow {
  id: number;
  name: string;
  closed: boolean;
  createdDate: number | null;
  createdBy: string | null;
  tags: string[];
  env: { name: string; value: string }[];
  /** null when the counts could not be read. */
  statistic: { status: ResultStatus | null; count: number }[] | null;
}

export interface LaunchList {
  launches: LaunchRow[];
  /** All launches matching the filter; the latest are listed. */
  total: number;
}

export type GroupBy = "auto" | "suites" | "behaviors" | "packages" | "none";
export type Theme = "auto" | "light" | "dark";

export interface LaunchReportInput {
  launchId: number;
  reportName: string;
  includeAttachments: boolean;
  maxAttachmentMb: number;
  includeRetries: boolean;
  groupBy: GroupBy;
  theme: Theme;
}

export type DocumentStatus = ResultStatus | "in_progress";

export type DocumentSection = "scenario" | "customFields" | "environment" | "attachments";

export interface LaunchDocumentInput {
  launchId: number;
  /** Empty means all. */
  statuses: DocumentStatus[];
  includeRetries: boolean;
  embedAttachments: boolean;
  maxAttachmentMb: number;
  maxTotalAttachmentMb: number;
  /** A PDF next to the HTML page. */
  pdf: boolean;
  /** Optional parts of every test result. */
  sections: Record<DocumentSection, boolean>;
}

export type TemplateTarget =
  | { mode: "new"; name: string; abbr: string; description: string; isPublic: boolean }
  | { mode: "existing"; projectId: number };

export interface TemplateInput {
  sourceProjectId: number;
  target: TemplateTarget;
  sections: string[];
}

export interface TemplateSection {
  key: string;
  label: string;
  description: string;
}

export type ActionKind = "create" | "update" | "remove" | "skip" | "manual";

export interface TemplatePreview {
  source: Project;
  target: Project | null;
  warnings: string[];
  sections: (TemplateSection & { actions: { kind: ActionKind; name: string; detail: string | null }[]; error: string | null })[];
}

export interface TemplateSummary {
  sourceProject: Project;
  targetProject: Project | null;
  targetUrl: string | null;
  sections: { key: string; label: string; counts: Record<ActionKind, number>; failed: number; error: string | null }[];
}

export interface ProjectField {
  id: number;
  name: string;
  required: boolean;
  locked: boolean;
  defaultValueId: number | null;
}

export interface FieldValue {
  id: number;
  name: string;
  global: boolean;
  testCases: number;
}

export interface ValueRef {
  fieldId: number;
  valueId: number;
}

export interface ValueImpact extends ValueRef {
  fieldName: string;
  name: string;
  global: boolean;
  testCases: number;
  deletedTestCases: number;
  isDefault: boolean;
  gone: boolean;
}

export interface CleanupSummary {
  project: Project;
  deleted: number;
  skipped: number;
  failed: number;
}

export type RollbackAttribute =
  | "name"
  | "fullName"
  | "description"
  | "precondition"
  | "expectedResult"
  | "automated"
  | "workflow"
  | "status"
  | "layer"
  | "tags"
  | "customFields"
  | "members"
  | "issues";

export interface RollbackScanInput {
  projectId: number;
  aql: string;
  after: number;
  attributes: RollbackAttribute[];
  onlyModified: boolean;
  threads: number;
}

export interface RollbackChange {
  key: RollbackAttribute;
  label: string;
  current: string;
  target: string;
  unchanged?: number;
}

export interface RollbackTestCase {
  id: number;
  name: string;
  url: string;
  changes: RollbackChange[];
  notes: string[];
  authors: Record<string, number>;
}

export interface RollbackPlan {
  project: Project;
  options: RollbackScanInput;
  matched: number;
  testCases: RollbackTestCase[];
}

export interface RollbackScanSummary {
  project: Project;
  matched: number;
  scanned: number;
  logEntries?: number;
  toRollBack: number;
  attributes: number;
}

export interface RollbackApplySummary {
  project: Project;
  rolledBack: number;
  skipped: number;
  failed: number;
}

export interface LaunchCleanupInput {
  projectId: number;
  keepDays: number;
  aql: string;
  onlyClosed: boolean;
  threads: number;
}

export interface CleanupLaunch {
  id: number;
  name: string;
  url: string;
  createdDate: number | null;
  createdBy: string | null;
  closed: boolean;
  tags: string[];
  env: string[];
  statistic: Partial<Record<ResultStatus, number>> | null;
  results: number | null;
}

export interface LaunchCleanupPlan {
  project: Project;
  options: LaunchCleanupInput;
  before: number;
  rql: string;
  launches: CleanupLaunch[];
}

export interface LaunchCleanupScanSummary {
  project: Project;
  before: number;
  found: number;
  read: number;
  results: number;
}

export interface LaunchCleanupDeleteSummary {
  project: Project;
  deleted: number;
  skipped: number;
  failed: number;
}

export type JobState = "running" | "done" | "failed" | "cancelled";

export interface Job {
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
  files: { name: string; size: number; contentType: string }[];
  /** Tool-specific results. */
  summary: unknown;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(payload.error ?? res.statusText, res.status);
  return payload as T;
}

export const api = {
  getConfig: () => call<PublicConfig>("GET", "/api/config"),
  testConfig: (c: { endpoint: string; token: string }) => call<{ projects: number }>("POST", "/api/config/test", c),
  saveConfig: (c: { endpoint: string; token: string }) => call<PublicConfig>("PUT", "/api/config", c),
  projects: () => call<Project[]>("GET", "/api/projects"),
  launches: (projectId: number, q: string, aql: string) =>
    call<LaunchList>("GET", `/api/projects/${projectId}/launches?${new URLSearchParams({ q, aql })}`),
  launchTags: (projectId: number, q: string) => call<IdName[]>("GET", `/api/projects/${projectId}/launch-tags?${new URLSearchParams({ q })}`),
  envVars: (q: string) => call<IdName[]>("GET", `/api/env-vars?${new URLSearchParams({ q })}`),
  envValues: (projectId: number, envVarId: number, q: string) =>
    call<IdName[]>("GET", `/api/projects/${projectId}/env-vars/${envVarId}/values?${new URLSearchParams({ q })}`),
  startLaunchReport: (input: LaunchReportInput) => call<Job>("POST", "/api/launch-report", input),
  startLaunchDocument: (input: LaunchDocumentInput) => call<Job>("POST", "/api/launch-document", input),
  templateSections: () => call<TemplateSection[]>("GET", "/api/project-template/sections"),
  previewTemplate: (input: TemplateInput) => call<TemplatePreview>("POST", "/api/project-template/preview", input),
  startTemplate: (input: TemplateInput) => call<Job>("POST", "/api/project-template", input),
  projectFields: (projectId: number) => call<ProjectField[]>("GET", `/api/projects/${projectId}/custom-fields`),
  fieldValues: (projectId: number, fieldId: number) => call<FieldValue[]>("GET", `/api/projects/${projectId}/custom-fields/${fieldId}/values`),
  checkValues: (projectId: number, values: ValueRef[]) => call<ValueImpact[]>("POST", "/api/field-values/check", { projectId, values }),
  deleteValues: (projectId: number, values: ValueRef[]) => call<Job>("POST", "/api/field-values/delete", { projectId, values }),
  rollbackCount: (input: RollbackScanInput) => call<{ count: number }>("POST", "/api/testcase-rollback/count", input),
  rollbackScan: (input: RollbackScanInput) => call<Job>("POST", "/api/testcase-rollback/scan", input),
  rollbackPlan: (jobId: string) => call<RollbackPlan>("GET", `/api/testcase-rollback/plan/${jobId}`),
  rollbackApply: (planJobId: string, testCaseIds: number[]) => call<Job>("POST", "/api/testcase-rollback", { planJobId, testCaseIds }),
  launchCleanupCount: (input: LaunchCleanupInput) => call<{ count: number }>("POST", "/api/launch-cleanup/count", input),
  launchCleanupScan: (input: LaunchCleanupInput) => call<Job>("POST", "/api/launch-cleanup/scan", input),
  launchCleanupPlan: (jobId: string) => call<LaunchCleanupPlan>("GET", `/api/launch-cleanup/plan/${jobId}`),
  launchCleanupDelete: (planJobId: string, launchIds: number[]) => call<Job>("POST", "/api/launch-cleanup", { planJobId, launchIds }),
  jobs: (kind: string) => call<Job[]>("GET", `/api/jobs?kind=${encodeURIComponent(kind)}`),
  job: (id: string) => call<Job>("GET", `/api/jobs/${id}`),
  cancelJob: (id: string) => call<Job>("POST", `/api/jobs/${id}/cancel`),
  deleteJob: (id: string) => call<void>("DELETE", `/api/jobs/${id}`),
  jobFileUrl: (id: string, index: number, inline = false) => `/api/jobs/${id}/files/${index}${inline ? "?inline=true" : ""}`,
};

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

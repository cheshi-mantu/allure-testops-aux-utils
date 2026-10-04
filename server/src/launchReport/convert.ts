/**
 * Turns Allure TestOps test results into the Allure results format
 * (`*-result.json`, `*-container.json`, attachments) read by Allure Report 3.
 */
import type { ApiAttachmentRow, ApiEnvVarValue, ApiFixture, ApiStatus, ApiStep, ResultDetails } from "./api.js";

export interface AllureLabel {
  name: string;
  value: string;
}

export interface AllureLink {
  name?: string;
  url: string;
  type?: string;
}

export interface AllureParameter {
  name: string;
  value: string;
  excluded?: boolean;
  mode?: "hidden";
}

export interface AllureAttachment {
  name: string;
  type?: string;
  source: string;
}

export interface AllureStatusDetails {
  message?: string;
  trace?: string;
  flaky?: boolean;
  muted?: boolean;
  known?: boolean;
}

export interface AllureStep {
  name: string;
  status?: ApiStatus;
  statusDetails?: AllureStatusDetails;
  start?: number;
  stop?: number;
  parameters: AllureParameter[];
  steps: AllureStep[];
  attachments: AllureAttachment[];
}

export interface AllureResult extends AllureStep {
  uuid: string;
  historyId: string;
  testCaseId?: string;
  fullName?: string;
  description?: string;
  descriptionHtml?: string;
  labels: AllureLabel[];
  links: AllureLink[];
}

export interface AllureContainer {
  uuid: string;
  name?: string;
  children: string[];
  befores: AllureStep[];
  afters: AllureStep[];
}

/** Where an attachment comes from: test results and fixtures have separate attachment lists. */
export type AttachmentOwner = "result" | "fixture";

/** Gives the file name an attachment was saved under, or null when it was not exported. */
export type AttachmentSource = (owner: AttachmentOwner, row: ApiAttachmentRow) => string | null;

export interface ConvertContext {
  endpoint: string;
  projectId: number;
  attachment: AttachmentSource;
}

/**
 * Custom fields whose names match an Allure label (ignoring case, spaces,
 * dashes and underscores) become that label, so grouping by suites or
 * behaviours works in the report. Other fields keep their names.
 */
const KNOWN_LABELS = new Map(
  ["epic", "feature", "story", "suite", "parentSuite", "subSuite", "package", "severity", "owner", "framework", "language", "host", "thread", "testClass", "testMethod"].map(
    (name) => [labelKey(name), name],
  ),
);

function labelKey(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

export function labelName(customField: string): string {
  return KNOWN_LABELS.get(labelKey(customField)) ?? customField;
}

const text = (v: string | null | undefined): string | undefined => (v == null || v === "" ? undefined : v);
const time = (v: number | null | undefined): number | undefined => (v == null ? undefined : v);

function statusDetails(message?: string | null, trace?: string | null, flags: Omit<AllureStatusDetails, "message" | "trace"> = {}) {
  const details: AllureStatusDetails = { message: text(message), trace: text(trace), ...flags };
  for (const key of Object.keys(details) as (keyof AllureStatusDetails)[]) {
    if (details[key] === undefined || details[key] === false) delete details[key];
  }
  return Object.keys(details).length ? details : undefined;
}

const STATUS_ORDER: ApiStatus[] = ["failed", "broken", "unknown", "skipped", "passed"];

/** The most severe status of the steps, for a group step that has none of its own. */
function worstStatus(steps: AllureStep[]): ApiStatus | undefined {
  let worst: number | undefined;
  for (const s of steps) {
    if (!s.status) continue;
    const i = STATUS_ORDER.indexOf(s.status);
    worst = worst === undefined ? i : Math.min(worst, i);
  }
  return worst === undefined ? undefined : STATUS_ORDER[worst];
}

/** Steps of a scenario; attachment steps become attachments of their parent. */
function convertSteps(steps: ApiStep[] | null | undefined, owner: AttachmentOwner, ctx: ConvertContext): Pick<AllureStep, "steps" | "attachments"> {
  const out: Pick<AllureStep, "steps" | "attachments"> = { steps: [], attachments: [] };
  for (const step of steps ?? []) {
    if (step.type === "attachment") {
      const row = step.attachment;
      if (!row) continue;
      const source = ctx.attachment(owner, row);
      if (source) out.attachments.push({ name: row.name || `attachment ${row.id}`, type: text(row.contentType), source });
      continue;
    }
    const nested = step.type === "body" ? convertSteps(step.steps, owner, ctx) : { steps: [], attachments: [] };
    if (step.type === "body" && step.expectedResultSteps?.length) {
      const expected = convertSteps(step.expectedResultSteps, owner, ctx);
      nested.steps.push({ name: "Expected result", status: worstStatus(expected.steps), parameters: [], ...expected });
    }
    out.steps.push({
      name: step.body ?? "",
      status: step.status ?? undefined,
      statusDetails: statusDetails(step.message, step.type === "body" ? step.trace : undefined),
      start: time(step.start),
      stop: time(step.stop),
      parameters: step.type === "body" ? (step.parameters ?? []).map((p) => ({ name: p.name, value: p.value ?? "" })) : [],
      ...nested,
    });
  }
  return out;
}

function convertFixture(fixture: ApiFixture, ctx: ConvertContext): AllureStep {
  return {
    name: fixture.name ?? fixture.type,
    status: fixture.status ?? undefined,
    statusDetails: statusDetails(fixture.message, fixture.trace),
    start: time(fixture.start),
    stop: time(fixture.stop),
    parameters: [],
    ...convertSteps(fixture.scenario?.steps, "fixture", ctx),
  };
}

function description(r: ResultDetails["result"]): Pick<AllureResult, "description" | "descriptionHtml"> {
  const parts = [text(r.description), text(r.precondition) && `## Precondition\n\n${r.precondition}`, text(r.expectedResult) && `## Expected result\n\n${r.expectedResult}`];
  const markdown = parts.filter(Boolean).join("\n\n");
  if (markdown) return { description: markdown };
  return r.descriptionHtml ? { descriptionHtml: r.descriptionHtml } : {};
}

function labels(d: ResultDetails): AllureLabel[] {
  const r = d.result;
  const out: AllureLabel[] = [];
  for (const tag of r.tags ?? []) out.push({ name: "tag", value: tag.name });
  if (r.layer?.name) out.push({ name: "layer", value: r.layer.name });
  for (const cf of d.customFields) {
    for (const v of cf.values ?? []) out.push({ name: labelName(cf.customField.name), value: v.name });
  }
  for (const m of d.members) {
    if (m.role?.name) out.push({ name: labelName(m.role.name), value: m.name });
  }
  if (r.hostId) out.push({ name: "host", value: r.hostId });
  if (r.threadId) out.push({ name: "thread", value: r.threadId });
  if (r.testCaseId != null) out.push({ name: "ALLURE_ID", value: String(r.testCaseId) });
  const seen = new Set<string>();
  return out.filter((l) => {
    const key = `${l.name}\u0000${l.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function links(d: ResultDetails, ctx: ConvertContext): AllureLink[] {
  const out: AllureLink[] = [];
  for (const l of d.result.links ?? []) {
    if (l.url) out.push({ name: text(l.name), url: l.url, type: text(l.type) });
  }
  for (const issue of d.issues) {
    const url = issue.url || undefined;
    if (url && !out.some((l) => l.url === url)) out.push({ name: issue.name, url, type: "issue" });
  }
  if (d.result.testCaseId != null) {
    out.push({
      name: `Test case ${d.result.testCaseId}`,
      url: `${ctx.endpoint}/project/${ctx.projectId}/test-cases/${d.result.testCaseId}`,
      type: "tms",
    });
  }
  return out;
}

export interface ConvertedResult {
  result: AllureResult;
  container: AllureContainer | null;
}

export function convertResult(d: ResultDetails, ctx: ConvertContext): ConvertedResult {
  const r = d.result;
  const uuid = `testops-${r.id}`;
  const start = time(r.start);
  const stop = time(r.stop) ?? (start !== undefined && r.duration != null ? start + r.duration : undefined);
  const result: AllureResult = {
    uuid,
    historyId: r.historyKey || (r.testCaseId != null ? `testcase-${r.testCaseId}` : `result-${r.id}`),
    testCaseId: r.testCaseId != null ? String(r.testCaseId) : undefined,
    name: r.name,
    fullName: text(r.fullName),
    // A result still in progress has no status yet.
    status: r.status ?? "unknown",
    statusDetails: statusDetails(r.message, r.trace, { flaky: r.flaky, muted: r.muted, known: r.known }),
    start,
    stop,
    ...description(r),
    labels: labels(d),
    links: links(d, ctx),
    parameters: (r.parameters ?? []).map((p) => ({
      name: p.name,
      value: p.value ?? "",
      ...(p.excluded ? { excluded: true } : {}),
      ...(p.hidden ? { mode: "hidden" as const } : {}),
    })),
    ...convertSteps(d.scenario?.steps, "result", ctx),
  };
  const befores = d.fixtures.filter((f) => f.type === "before").map((f) => convertFixture(f, ctx));
  const afters = d.fixtures.filter((f) => f.type === "after").map((f) => convertFixture(f, ctx));
  const container = befores.length || afters.length ? { uuid: `${uuid}-fixtures`, name: r.name, children: [uuid], befores, afters } : null;
  return { result, container };
}

/** Every attachment referenced by a result, its steps and fixtures. */
export function attachmentRows(d: ResultDetails): { owner: AttachmentOwner; row: ApiAttachmentRow }[] {
  const out: { owner: AttachmentOwner; row: ApiAttachmentRow }[] = [];
  const walk = (steps: ApiStep[] | null | undefined, owner: AttachmentOwner) => {
    for (const s of steps ?? []) {
      if (s.type === "attachment" && s.attachment && !s.attachment.missed) out.push({ owner, row: s.attachment });
      if (s.type === "body") {
        walk(s.steps, owner);
        walk(s.expectedResultSteps, owner);
      }
    }
  };
  walk(d.scenario?.steps, "result");
  for (const f of d.fixtures) walk(f.scenario?.steps, "fixture");
  return out;
}

export type GroupBy = "auto" | "suites" | "behaviors" | "packages" | "none";

const GROUPS: Record<Exclude<GroupBy, "auto">, string[]> = {
  suites: ["parentSuite", "suite", "subSuite"],
  behaviors: ["epic", "feature", "story"],
  packages: ["package"],
  none: [],
};

/** "auto" picks the first of suites, behaviours and packages present in the results. */
export function groupByLabels(groupBy: GroupBy, results: AllureResult[]): string[] {
  if (groupBy !== "auto") return GROUPS[groupBy];
  const present = new Set(results.flatMap((r) => r.labels.map((l) => l.name)));
  for (const key of ["suites", "behaviors", "packages"] as const) {
    if (GROUPS[key].some((l) => present.has(l))) return GROUPS[key];
  }
  return [];
}

/** `environment.properties`: one line per variable, several values joined with commas. */
export function environmentProperties(env: ApiEnvVarValue[]): string {
  const byName = new Map<string, string[]>();
  for (const v of env) {
    const name = v.variable?.name ?? "environment";
    if (!byName.has(name)) byName.set(name, []);
    if (!byName.get(name)!.includes(v.name)) byName.get(name)!.push(v.name);
  }
  const escape = (s: string, key: boolean) =>
    s
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(key ? /[=: ]/g : /^ /, (c) => `\\${c}`);
  return [...byName].map(([name, values]) => `${escape(name, true)}=${escape(values.join(", "), false)}\n`).join("");
}

const EXTENSIONS: Record<string, string> = {
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "text/xml": ".xml",
  "application/xml": ".xml",
  "application/json": ".json",
  "application/yaml": ".yaml",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
};

/** File extension for an attachment: from its name, else from its content type. */
export function attachmentExtension(row: ApiAttachmentRow): string {
  const fromName = /\.([A-Za-z0-9]{1,10})$/.exec(row.name ?? "")?.[0];
  if (fromName) return fromName.toLowerCase();
  const type = (row.contentType ?? "").split(";")[0].trim().toLowerCase();
  return EXTENSIONS[type] ?? "";
}

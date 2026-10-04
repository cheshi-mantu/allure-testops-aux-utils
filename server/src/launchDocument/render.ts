/**
 * HTML of the launch document: one long page, readable in a browser and
 * printable to PDF. Collapsed sections open by themselves when printed.
 */
import type { ApiAttachmentRow, ApiEnvVarValue, ApiIssue, ApiJobRun, ApiLaunch, ApiLink, ApiStatus, ApiStep, ApiTestResult, ResultDetails } from "../launchReport/api.js";
import type { AttachmentOwner } from "../launchReport/convert.js";

export type StatusKey = ApiStatus | "in_progress";

/** Order of the status groups in the contents and in the list. */
export const STATUS_ORDER: StatusKey[] = ["failed", "broken", "unknown", "skipped", "passed", "in_progress"];

const STATUS_LABEL: Record<StatusKey, string> = {
  failed: "Failed",
  broken: "Broken",
  unknown: "Unknown",
  skipped: "Skipped",
  passed: "Passed",
  in_progress: "In progress",
};

export function statusKey(status: ApiStatus | null | undefined): StatusKey {
  return status ?? "in_progress";
}

/** An attachment as it goes into the document. */
export type Embedded =
  | { kind: "image"; dataUri: string }
  | { kind: "text"; text: string }
  /** Listed only, with the reason. */
  | { kind: "none"; reason: string };

export interface RenderContext {
  endpoint: string;
  projectId: number;
  attachment: (owner: AttachmentOwner, row: ApiAttachmentRow) => Embedded;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function link(url: string | null | undefined, text: string): string {
  if (!url || !/^https?:\/\//i.test(url)) return esc(text);
  return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}.${String(Math.floor((ms % 1000) / 100))} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function formatTime(ms: number | null | undefined): string {
  if (ms == null) return "";
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function badge(status: StatusKey): string {
  return `<span class="badge st-${status}">${STATUS_LABEL[status]}</span>`;
}

/** A small status mark for steps: badges there would be too loud. Shapes are defined once in `ICONS`. */
function statusIcon(status: StatusKey): string {
  const label = STATUS_LABEL[status];
  return `<svg class="si si-${status}" role="img" aria-label="${label}"><title>${label}</title><use href="#i-${status}"/></svg>`;
}

const ICONS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<symbol id="i-passed" viewBox="0 0 16 16"><path d="M3 8.5l3.5 3.5L13 4.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-failed" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></symbol>
<symbol id="i-broken" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></symbol>
<symbol id="i-unknown" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="currentColor"/></symbol>
<symbol id="i-skipped" viewBox="0 0 16 16"><path d="M3.5 8h9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></symbol>
<symbol id="i-in_progress" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.8" fill="none" stroke="currentColor" stroke-width="2"/></symbol>
</svg>`;

/**
 * Description HTML comes rendered by Allure TestOps; scripts, frames, event
 * handlers and javascript: links are removed, relative links point to the instance.
 */
export function sanitizeHtml(html: string, endpoint: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(script|style|iframe|object|embed|template|link|meta|base|form)\b[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*(["'])\/(?!\/)/gi, `$1=$2${endpoint}/`);
}

const UI = {
  launch: (endpoint: string, id: number) => `${endpoint}/launch/${id}`,
  testResult: (endpoint: string, id: number) => `${endpoint}/testresult/${id}`,
  testCase: (endpoint: string, projectId: number, id: number) => `${endpoint}/project/${projectId}/test-cases/${id}`,
};

const CSS = `
:root {
  --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --bg-soft: #f6f8fa; --red: #c62828; --red-bg: #fdecea;
  /* Status colours of Allure TestOps; broken and skipped are darker to stay visible on white and in print. */
  --passed: #78b63c; --failed: #ff2602; --broken: #f08c00; --skipped: #5f6368; --unknown: #bf34a6; --in_progress: #3f80cb;
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--fg); background: #fff; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 32px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 20px; margin: 40px 0 12px; padding-bottom: 4px; border-bottom: 2px solid var(--line); }
h3 { font-size: 17px; margin: 0; }
h4 { font-size: 14px; margin: 16px 0 6px; }
a { color: #0b57d0; }
pre { margin: 6px 0; padding: 8px 10px; background: var(--bg-soft); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; }
th, td { text-align: left; vertical-align: top; padding: 4px 8px; border: 1px solid var(--line); overflow-wrap: anywhere; }
th { width: 28%; background: var(--bg-soft); font-weight: 600; }
.muted, .id { color: var(--muted); }
.id { font-weight: normal; font-size: 0.85em; }
.meta { color: var(--muted); margin: 4px 0 0; }
.meta > span + span::before { content: " | "; color: var(--line); }
.chips span { display: inline-block; margin: 0 4px 4px 0; padding: 0 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg-soft); }
.badge { display: inline-block; padding: 0 7px; border-radius: 4px; font-size: 12px; font-weight: 600; color: #fff; vertical-align: 1px; }
.st-passed { background: var(--passed); } .st-failed { background: var(--failed); } .st-broken { background: var(--broken); }
.st-skipped { background: var(--skipped); } .st-unknown { background: var(--unknown); } .st-in_progress { background: var(--in_progress); }
.si { width: 14px; height: 14px; flex: none; align-self: center; }
.si-passed { color: var(--passed); } .si-failed { color: var(--failed); } .si-broken { color: var(--broken); }
.si-skipped { color: var(--skipped); } .si-unknown { color: var(--unknown); } .si-in_progress { color: var(--in_progress); }
.toolbar { position: sticky; top: 0; z-index: 1; display: flex; gap: 8px; justify-content: flex-end; padding: 8px 0; background: rgba(255,255,255,0.95); }
.toolbar button { font: inherit; padding: 2px 10px; border: 1px solid var(--line); border-radius: 6px; background: #fff; cursor: pointer; }
details > summary { cursor: pointer; }
.toc-group { margin: 6px 0; }
.toc-group > summary { font-weight: 600; }
ol.toc { margin: 4px 0 8px; padding-left: 28px; columns: 1; }
ol.toc li { margin: 1px 0; }
.result { margin: 28px 0 0; padding-top: 16px; border-top: 1px solid var(--line); }
/* Long documents: results off screen are not laid out until scrolled to. */
@media screen { .result { content-visibility: auto; contain-intrinsic-size: auto 400px; } }
.result-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.top { float: right; font-size: 12px; }
.error { margin: 8px 0; border-left: 3px solid var(--red); background: var(--red-bg); border-radius: 0 6px 6px 0; padding: 4px 10px; }
.error > summary { color: var(--red); font-weight: 600; overflow-wrap: anywhere; }
.error pre { background: #fff; }
ol.steps { margin: 4px 0; padding-left: 22px; }
ol.steps > li { margin: 4px 0; }
.step-head { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
.step-name { white-space: pre-wrap; overflow-wrap: anywhere; }
.step.bad > .step-head .step-name { font-weight: 600; }
.step.step-failed > .step-head .step-name { color: var(--failed); }
.step.step-broken > .step-head .step-name { color: #b35f00; }
.step .dur { color: var(--muted); font-size: 12px; }
.params { color: var(--muted); font-size: 12px; }
.expected-title { color: var(--muted); font-size: 12px; font-weight: 600; margin-top: 2px; }
.fixture-title { display: flex; gap: 6px; align-items: baseline; font-weight: 600; margin: 8px 0 0; }
.attachment { margin: 3px 0; }
.attachment > summary { color: #444; }
.attachment img { display: block; max-width: 100%; margin: 6px 0; border: 1px solid var(--line); }
.section > summary { font-weight: 600; margin: 12px 0 4px; }
.description { overflow-wrap: anywhere; }
.description img { max-width: 100%; }
@media print {
  /* Collapsed sections are printed open, also by converters that run no scripts. */
  details::details-content { content-visibility: visible; display: contents; }
  main { max-width: none; padding: 0; }
  .toolbar, .top { display: none; }
  a { color: inherit; }
  h2 { break-after: avoid; }
  .result-head, .step-head { break-after: avoid; }
  .result { break-before: auto; }
  .attachment img { max-height: 90vh; }
}
`;

const SCRIPT = `
(function () {
  function all(open) { document.querySelectorAll("details").forEach(function (d) { d.open = open; }); }
  document.getElementById("expand-all").onclick = function () { all(true); };
  document.getElementById("collapse-all").onclick = function () { all(false); };
  document.getElementById("print").onclick = function () { window.print(); };
  var closed = [];
  window.addEventListener("beforeprint", function () {
    closed = Array.prototype.filter.call(document.querySelectorAll("details"), function (d) { return !d.open; });
    closed.forEach(function (d) { d.open = true; });
  });
  window.addEventListener("afterprint", function () { closed.forEach(function (d) { d.open = false; }); closed = []; });
})();
`;

export function documentStart(launch: ApiLaunch, endpoint: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(launch.name)} (launch ${launch.id})</title>
<style>${CSS}</style>
</head>
<body>
${ICONS}
<main>
<div class="toolbar"><button id="expand-all" type="button">Expand all</button><button id="collapse-all" type="button">Collapse all</button><button id="print" type="button">Print / PDF</button></div>
<h1 id="top">${esc(launch.name)}</h1>
<p class="meta"><span>Launch ${launch.id}</span><span>${link(UI.launch(endpoint, launch.id), "Open in Allure TestOps")}</span><span>Exported ${esc(formatTime(Date.now()))}</span></p>
`;
}

export function documentEnd(): string {
  return `</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** Variable → values, in the order met. */
export type Environment = Map<string, string[]>;

export function addEnvironment(env: Environment, values: ApiEnvVarValue[]): void {
  for (const v of values) {
    const name = v.variable?.name ?? "environment";
    const list = env.get(name) ?? [];
    if (!list.includes(v.name)) list.push(v.name);
    env.set(name, list);
  }
}

function environmentTable(env: Environment): string {
  if (env.size === 0) return `<p class="muted">No environment variables.</p>`;
  const rows = [...env].map(([name, values]) => `<tr><th>${esc(name)}</th><td>${values.map(esc).join(", ")}</td></tr>`);
  return `<table>${rows.join("")}</table>`;
}

function linkList(links: ApiLink[]): string {
  const items = links.filter((l) => l.url || l.name).map((l) => `<li>${link(l.url, l.name || l.url || "")}${l.type ? ` <span class="muted">(${esc(l.type)})</span>` : ""}</li>`);
  return items.length ? `<ul>${items.join("")}</ul>` : `<p class="muted">No links.</p>`;
}

function issueList(issues: ApiIssue[]): string {
  const items = issues.map((i) => `<li>${link(i.url, i.name)}${i.summary ? ` ${esc(i.summary)}` : ""}</li>`);
  return items.length ? `<ul>${items.join("")}</ul>` : `<p class="muted">No issues.</p>`;
}

export interface JobRunGroup {
  jobRun: ApiJobRun | null;
  results: number;
  environment: Environment;
}

export interface Counts {
  byStatus: Map<StatusKey, number>;
  total: number;
}

export function attributesSection(o: {
  launch: ApiLaunch;
  projectName: string;
  launchEnvironment: Environment;
  jobRuns: JobRunGroup[];
  counts: Counts;
  omitted: string[];
}): string {
  const { launch } = o;
  const statusLine = STATUS_ORDER.filter((s) => o.counts.byStatus.get(s))
    .map((s) => `${badge(s)} ${o.counts.byStatus.get(s)}`)
    .join(" &nbsp; ");
  const rows = [
    ["Project", `${esc(o.projectName)} <span class="id">(${launch.projectId})</span>`],
    ["Created", `${esc(formatTime(launch.createdDate))}${launch.createdBy ? ` by ${esc(launch.createdBy)}` : ""}`],
    ["State", launch.closed ? "closed" : "open"],
    ["Test results in this document", `${o.counts.total} &nbsp; ${statusLine}`],
    ...(o.omitted.length ? [["Left out", o.omitted.map(esc).join("<br>")]] : []),
  ];
  let html = `<h2 id="attributes">Launch attributes</h2>
<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>
<h4>Tags</h4>
${launch.tags?.length ? `<div class="chips">${launch.tags.map((t) => `<span>${esc(t.name)}</span>`).join("")}</div>` : `<p class="muted">No tags.</p>`}
<h4>Links</h4>
${linkList(launch.links ?? [])}
<h4>Issues</h4>
${issueList(launch.issues ?? [])}
`;
  if (o.jobRuns.length > 1 || (o.jobRuns.length === 1 && o.jobRuns[0].jobRun)) {
    html += `<h4>Job runs</h4>`;
    for (const g of o.jobRuns) {
      const j = g.jobRun;
      const title = j ? [j.job?.name, j.name].filter(Boolean).join(" ") || `Job run ${j.id}` : "Without a job run";
      const meta = j
        ? [j.url ? link(j.url, "Open in CI") : "", j.stage ? `stage: ${esc(j.stage.toLowerCase())}` : "", j.status ? `status: ${esc(j.status.toLowerCase())}` : ""]
        : [];
      html += `<div class="jobrun"><p><strong>${esc(title)}</strong>${j ? ` <span class="id">(${j.id})</span>` : ""}</p>
<p class="meta">${[...meta.filter(Boolean), `${g.results} test results`].map((m) => `<span>${m}</span>`).join("")}</p>
${environmentTable(g.environment)}</div>`;
    }
  } else {
    html += `<h4>Environment</h4>
${environmentTable(o.launchEnvironment)}`;
  }
  return html;
}

export function contentsSection(results: ApiTestResult[]): string {
  const groups = new Map<StatusKey, ApiTestResult[]>();
  for (const r of results) {
    const key = statusKey(r.status);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  let html = `<h2 id="contents">Contents</h2>\n`;
  for (const status of STATUS_ORDER) {
    const list = groups.get(status);
    if (!list?.length) continue;
    html += `<details class="toc-group" open><summary>${badge(status)} ${list.length}</summary><ol class="toc">`;
    for (const r of list) html += `<li><a href="#tr-${r.id}">${esc(r.name)}</a> <span class="id">${r.id}</span></li>`;
    html += `</ol></details>\n`;
  }
  return `${html}<h2 id="results">Test results</h2>\n`;
}

function attachmentHtml(owner: AttachmentOwner, row: ApiAttachmentRow, ctx: RenderContext): string {
  const content = ctx.attachment(owner, row);
  const info = [row.contentType, formatSize(row.contentLength)].filter(Boolean).join(", ");
  const body =
    content.kind === "image"
      ? `<img src="${content.dataUri}" alt="${esc(row.name)}" loading="lazy">`
      : content.kind === "text"
        ? `<pre>${esc(content.text)}</pre>`
        : `<p class="muted">${esc(content.reason)}</p>`;
  return `<details class="attachment"><summary>Attachment: ${esc(row.name || `attachment ${row.id}`)}${info ? ` <span class="muted">(${esc(info)})</span>` : ""}</summary>${body}</details>`;
}

function errorHtml(message: string | null | undefined, trace: string | null | undefined): string {
  const text = [message, trace].filter(Boolean).join("\n\n");
  if (!text) return "";
  const first = (message || trace || "").split("\n")[0].slice(0, 200);
  return `<details class="error"><summary>Error: ${esc(first)}</summary><pre>${esc(text)}</pre></details>`;
}

const isBad = (s: ApiStatus | null | undefined) => s === "failed" || s === "broken";

function stepsHtml(steps: ApiStep[] | null | undefined, owner: AttachmentOwner, ctx: RenderContext): string {
  const items: string[] = [];
  for (const step of steps ?? []) {
    if (step.type === "attachment") {
      if (step.attachment && !step.attachment.missed) items.push(`<li class="step">${attachmentHtml(owner, step.attachment, ctx)}</li>`);
      continue;
    }
    const status = step.status ?? null;
    const params = step.type === "body" && step.parameters?.length ? `<div class="params">${step.parameters.map((p) => `${esc(p.name)} = ${esc(p.value ?? "")}`).join("; ")}</div>` : "";
    const error = isBad(status) ? errorHtml(step.message, step.type === "body" ? step.trace : null) : "";
    const nested = step.type === "body" ? stepsHtml(step.steps, owner, ctx) : "";
    const expected =
      step.type === "body" && step.expectedResultSteps?.length
        ? `<div class="expected-title">Expected result</div>${stepsHtml(step.expectedResultSteps, owner, ctx)}`
        : "";
    items.push(
      `<li class="step${isBad(status) ? ` bad step-${status}` : ""}"><div class="step-head">${status ? statusIcon(status) : ""}<span class="step-name">${esc(step.body ?? "")}</span><span class="dur">${esc(formatDuration(step.duration ?? (step.start != null && step.stop != null ? step.stop - step.start : null)))}</span></div>${params}${error}${nested}${expected}</li>`,
    );
  }
  return items.length ? `<ol class="steps">${items.join("")}</ol>` : "";
}

/** Body steps go to the scenario; attachments at the top level are the test's own. */
function splitTopLevel(steps: ApiStep[] | null | undefined): { steps: ApiStep[]; attachments: ApiAttachmentRow[] } {
  const out = { steps: [] as ApiStep[], attachments: [] as ApiAttachmentRow[] };
  for (const s of steps ?? []) {
    if (s.type === "attachment") {
      if (s.attachment && !s.attachment.missed) out.attachments.push(s.attachment);
    } else out.steps.push(s);
  }
  return out;
}

function attributesTable(d: ResultDetails): string {
  const r = d.result;
  const rows: [string, string][] = [];
  for (const cf of d.customFields) {
    const values = (cf.values ?? []).map((v) => esc(v.name)).join(", ");
    if (values) rows.push([esc(cf.customField.name), values]);
  }
  const roles = new Map<string, string[]>();
  for (const m of d.members) {
    const role = m.role?.name ?? "Member";
    roles.set(role, [...(roles.get(role) ?? []), m.name]);
  }
  for (const [role, names] of roles) rows.push([esc(role), names.map(esc).join(", ")]);
  if (r.layer?.name) rows.push(["Layer", esc(r.layer.name)]);
  if (r.tags?.length) rows.push(["Tags", r.tags.map((t) => esc(t.name)).join(", ")]);
  const params = (r.parameters ?? []).filter((p) => !p.hidden);
  if (params.length) rows.push(["Parameters", params.map((p) => `${esc(p.name)} = ${esc(p.value ?? "")}`).join("<br>")]);
  const env: Environment = new Map();
  addEnvironment(env, d.environment ?? []);
  if (env.size) rows.push(["Environment", [...env].map(([n, v]) => `${esc(n)}: ${v.map(esc).join(", ")}`).join("<br>")]);
  const links = [...(r.links ?? []).filter((l) => l.url).map((l) => link(l.url, l.name || l.url || "")), ...d.issues.map((i) => link(i.url, i.name))];
  if (links.length) rows.push(["Links", links.join("<br>")]);
  if (r.hostId || r.threadId) rows.push(["Host / thread", esc([r.hostId, r.threadId].filter(Boolean).join(" / "))]);
  const flags = [r.flaky && "flaky", r.muted && "muted", r.known && "known issue", r.hidden && "earlier retry"].filter(Boolean);
  if (flags.length) rows.push(["Flags", esc(flags.join(", "))]);
  if (rows.length === 0) return "";
  return `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>`;
}

function descriptionHtml(r: ApiTestResult, endpoint: string): string {
  const part = (title: string, html: string | null | undefined, text: string | null | undefined) => {
    if (html) return `<h4>${title}</h4><div class="description">${sanitizeHtml(html, endpoint)}</div>`;
    if (text) return `<h4>${title}</h4><div class="description"><pre>${esc(text)}</pre></div>`;
    return "";
  };
  return (
    part("Description", r.descriptionHtml, r.description) +
    part("Precondition", r.preconditionHtml, r.precondition) +
    part("Expected result", r.expectedResultHtml, r.expectedResult)
  );
}

export function resultSection(d: ResultDetails, ctx: RenderContext, jobRunName: string | null): string {
  const r = d.result;
  const status = statusKey(r.status);
  const meta = [
    r.testCaseId != null ? `Test case ${link(UI.testCase(ctx.endpoint, ctx.projectId, r.testCaseId), String(r.testCaseId))}` : "",
    link(UI.testResult(ctx.endpoint, r.id), "Open in Allure TestOps"),
    r.start != null ? esc(formatTime(r.start)) : "",
    r.duration != null ? esc(formatDuration(r.duration)) : "",
    jobRunName ? `Job run: ${esc(jobRunName)}` : "",
  ].filter(Boolean);
  const top = splitTopLevel(d.scenario?.steps);
  const before = d.fixtures.filter((f) => f.type === "before");
  const after = d.fixtures.filter((f) => f.type === "after");
  const fixtures = (title: string, list: typeof d.fixtures) =>
    list
      .map(
        (f) =>
          `<div class="fixture-title">${f.status ? statusIcon(f.status) : ""}<span>${title}: ${esc(f.name ?? "")}</span><span class="dur muted">${esc(formatDuration(f.start != null && f.stop != null ? f.stop - f.start : null))}</span></div>${isBad(f.status) ? errorHtml(f.message, f.trace) : ""}${stepsHtml(f.scenario?.steps, "fixture", ctx)}`,
      )
      .join("");
  const scenario = fixtures("Set up", before) + stepsHtml(top.steps, "result", ctx) + fixtures("Tear down", after);
  return `<section class="result" id="tr-${r.id}">
<a class="top" href="#contents">contents</a>
<div class="result-head">${badge(status)}<h3>${esc(r.name)} <span class="id">${r.id}</span></h3></div>
${r.fullName ? `<div class="muted">${esc(r.fullName)}</div>` : ""}
<p class="meta">${meta.map((m) => `<span>${m}</span>`).join("")}</p>
${errorHtml(r.message, r.trace)}
${attributesTable(d)}
${descriptionHtml(r, ctx.endpoint)}
${scenario ? `<details class="section" open><summary>Scenario</summary>${scenario}</details>` : ""}
${top.attachments.length ? `<details class="section"><summary>Attachments (${top.attachments.length})</summary>${top.attachments.map((a) => attachmentHtml("result", a, ctx)).join("")}</details>` : ""}
</section>
`;
}

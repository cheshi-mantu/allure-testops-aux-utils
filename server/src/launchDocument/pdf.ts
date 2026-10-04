/**
 * The launch document as a PDF, drawn directly with pdfkit: the same parts
 * as the HTML page, each test result on its own page, bookmarks for every
 * test result, links from the contents and page numbers. Pages are written
 * out after every test result, so memory does not grow with the launch.
 */
import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import PDFDocument from "pdfkit";
import type { ApiAttachmentRow, ApiFixture, ApiStep, ApiTestResult, ResultDetails } from "../launchReport/api.js";
import type { AttachmentOwner } from "../launchReport/convert.js";
import {
  addEnvironment,
  formatDuration,
  formatSize,
  formatTime,
  jobRunTitle,
  manualRows,
  showJobRuns,
  STATUS_LABEL,
  STATUS_ORDER,
  statusKey,
  UI,
  type AttributesInput,
  type Embedded,
  type Environment,
  type RenderContext,
  type StatusKey,
} from "./render.js";

const fontDir = join(dirname(createRequire(import.meta.url).resolve("dejavu-fonts-ttf/package.json")), "ttf");

const COLORS: Record<StatusKey, string> = {
  passed: "#78b63c",
  failed: "#ff2602",
  broken: "#f08c00",
  skipped: "#5f6368",
  unknown: "#bf34a6",
  in_progress: "#3f80cb",
};
const FG = "#1f2328";
const MUTED = "#656d76";
const LINE = "#d0d7de";
const SOFT = "#f6f8fa";
const LINK = "#0b57d0";
const RED = "#c62828";
const BROKEN_TEXT = "#b35f00";

const BASE = 9.5;
const SMALL = 8;
const MONO = 7.5;
const INDENT = 12;
/** Text attachments are cut to this in the PDF; the HTML document has them whole. */
const MAX_TEXT_LINES = 200;
const MAX_TEXT_CHARS = 20_000;
const MAX_IMAGE_HEIGHT = 520;

type Font = "sans" | "bold" | "mono";

const isBad = (s: StatusKey | null | undefined) => s === "failed" || s === "broken";

/** Text of HTML rendered by Allure TestOps, keeping paragraphs and list items. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|h[1-6]|tr|pre|blockquote|ul|ol|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (_, e: string) => {
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      if (e[0] !== "#") return named[e.toLowerCase()] ?? "";
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class PdfDocumentWriter {
  private readonly doc: PDFKit.PDFDocument;
  private readonly done: Promise<void>;
  private readonly left: number;
  private readonly width: number;
  private pageNumber = 0;
  private outlineGroups = new Map<StatusKey, PDFKit.PDFOutline>();

  constructor(
    path: string,
    private readonly title: string,
    private readonly ctx: RenderContext,
  ) {
    this.doc = new PDFDocument({
      size: "A4",
      margins: { top: 42, bottom: 50, left: 42, right: 42 },
      bufferPages: true,
      info: { Title: title, Creator: "Allure TestOps aux utils" },
      displayTitle: true,
    });
    this.doc.registerFont("sans", join(fontDir, "DejaVuSans.ttf"));
    this.doc.registerFont("bold", join(fontDir, "DejaVuSans-Bold.ttf"));
    this.doc.registerFont("mono", join(fontDir, "DejaVuSansMono.ttf"));
    this.left = this.doc.page.margins.left;
    this.width = this.doc.page.width - this.left - this.doc.page.margins.right;
    const out = createWriteStream(path);
    this.doc.pipe(out);
    this.done = finished(out);
    this.font("sans", BASE);
  }

  // ---------------------------------------------------------------- primitives

  private font(font: Font, size: number, color = FG): PDFKit.PDFDocument {
    return this.doc.font(font).fontSize(size).fillColor(color);
  }

  private get bottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  /** Starts a new page unless `height` still fits on this one. */
  private ensure(height: number): void {
    if (this.doc.y + height > this.bottom) this.doc.addPage();
  }

  private gap(points: number): void {
    this.doc.y += points;
  }

  private text(text: string, o: { font?: Font; size?: number; color?: string; indent?: number; link?: string; goTo?: string } = {}): void {
    const indent = o.indent ?? 0;
    // Fonts have no glyph for tabs, which stack traces are full of.
    text = text.replace(/\t/g, "    ");
    this.font(o.font ?? "sans", o.size ?? BASE, o.link || o.goTo ? LINK : (o.color ?? FG));
    this.ensure(this.doc.currentLineHeight(true));
    this.doc.text(text, this.left + indent, this.doc.y, { width: this.width - indent, link: o.link, goTo: o.goTo, underline: Boolean(o.link) });
  }

  /**
   * Short pieces on one line separated by bars, links among them; a piece
   * that does not fit goes to the next line whole.
   */
  private inline(parts: { text: string; link?: string }[], size = SMALL): void {
    const sep = "  |  ";
    this.font("sans", size, MUTED);
    const lineHeight = this.doc.currentLineHeight(true);
    this.ensure(lineHeight);
    let x = this.left;
    let y = this.doc.y;
    parts.forEach((p, i) => {
      const prefix = i === 0 ? "" : sep;
      const w = this.doc.widthOfString(prefix + p.text);
      if (i > 0 && x + w > this.left + this.width) {
        x = this.left;
        y += lineHeight;
      } else if (prefix) {
        this.doc.fillColor(MUTED).text(prefix, x, y, { lineBreak: false });
        x += this.doc.widthOfString(prefix);
      }
      this.doc.fillColor(p.link ? LINK : MUTED).text(p.text, x, y, { lineBreak: false, link: p.link, underline: Boolean(p.link) });
      x += this.doc.widthOfString(p.text);
    });
    this.doc.x = this.left;
    this.doc.y = y + lineHeight;
  }

  private heading(text: string, size: number, spaceBefore: number): void {
    this.gap(spaceBefore);
    // A heading at the very bottom of a page goes to the next one with what follows it.
    this.ensure(size * 3);
    this.text(text, { font: "bold", size });
    this.gap(3);
  }

  private h2(text: string): void {
    this.heading(text, 14, 14);
    this.doc.moveTo(this.left, this.doc.y).lineTo(this.left + this.width, this.doc.y).lineWidth(1).strokeColor(LINE).stroke();
    this.gap(6);
  }

  /** A status label in a coloured box; returns its width. */
  private badge(status: StatusKey, x: number, y: number): number {
    const label = STATUS_LABEL[status];
    this.font("bold", 7);
    const w = this.doc.widthOfString(label) + 8;
    this.doc.roundedRect(x, y, w, 11, 2).fill(COLORS[status]);
    this.doc.fillColor("#ffffff").text(label, x + 4, y + 2, { lineBreak: false });
    return w;
  }

  /** The small status marks of the scenario. */
  private icon(status: StatusKey, x: number, y: number): void {
    const d = this.doc;
    const c = COLORS[status];
    d.save().lineWidth(1.5).lineCap("round").lineJoin("round").strokeColor(c).fillColor(c);
    switch (status) {
      case "passed":
        d.moveTo(x + 1, y + 4.5).lineTo(x + 3.5, y + 7).lineTo(x + 8, y + 1.5).stroke();
        break;
      case "failed":
      case "broken":
        d.moveTo(x + 1.5, y + 1.5).lineTo(x + 7.5, y + 7.5).moveTo(x + 7.5, y + 1.5).lineTo(x + 1.5, y + 7.5).stroke();
        break;
      case "unknown":
        d.circle(x + 4.5, y + 4.5, 3.4).fill();
        break;
      case "skipped":
        d.moveTo(x + 1, y + 4.5).lineTo(x + 8, y + 4.5).stroke();
        break;
      case "in_progress":
        d.lineWidth(1.2).circle(x + 4.5, y + 4.5, 3.2).stroke();
        break;
    }
    d.restore();
  }

  /** Two columns with borders; a row taller than the rest of the page starts a new one. */
  private table(rows: [string, string][], keyShare = 0.3): void {
    if (rows.length === 0) return;
    const kw = this.width * keyShare;
    const vw = this.width - kw;
    const pad = 4;
    for (const [k, v] of rows) {
      this.font("bold", SMALL + 0.5);
      const kh = this.doc.heightOfString(k, { width: kw - pad * 2 });
      this.font("sans", SMALL + 0.5);
      const vh = this.doc.heightOfString(v || " ", { width: vw - pad * 2 });
      const h = Math.max(kh, vh) + pad * 2;
      if (h < this.bottom - this.doc.page.margins.top) this.ensure(h);
      const y = this.doc.y;
      this.doc.rect(this.left, y, kw, h).fillAndStroke(SOFT, LINE);
      this.doc.rect(this.left + kw, y, vw, h).lineWidth(0.6).stroke(LINE);
      this.font("bold", SMALL + 0.5).text(k, this.left + pad, y + pad, { width: kw - pad * 2 });
      this.font("sans", SMALL + 0.5).text(v, this.left + kw + pad, y + pad, { width: vw - pad * 2 });
      this.doc.y = Math.max(this.doc.y, y + h);
    }
    this.doc.x = this.left;
    this.gap(4);
  }

  /** An error message and trace, in full: a PDF has nothing to expand. */
  private error(message: string | null | undefined, trace: string | null | undefined, indent: number, status: StatusKey): void {
    const text = [message, trace].filter(Boolean).join("\n\n");
    if (!text) return;
    this.text("Error", { font: "bold", size: SMALL, color: status === "broken" ? BROKEN_TEXT : RED, indent });
    this.text(text, { font: "mono", size: MONO, color: "#5c1a1a", indent: indent + 6 });
    this.gap(3);
  }

  private attachment(owner: AttachmentOwner, row: ApiAttachmentRow, indent: number): void {
    const info = [row.contentType, formatSize(row.contentLength)].filter(Boolean).join(", ");
    this.text(`Attachment: ${row.name || `attachment ${row.id}`}${info ? ` (${info})` : ""}`, { size: SMALL, color: MUTED, indent });
    const content: Embedded = this.ctx.attachment(owner, row);
    if (content.kind === "text") {
      const lines = content.text.slice(0, MAX_TEXT_CHARS).split("\n");
      const cut = lines.length > MAX_TEXT_LINES || content.text.length > MAX_TEXT_CHARS;
      this.text(lines.slice(0, MAX_TEXT_LINES).join("\n"), { font: "mono", size: MONO, color: "#333333", indent: indent + 6 });
      if (cut) this.text("… cut here; the HTML document has the whole attachment.", { size: SMALL, color: MUTED, indent: indent + 6 });
    } else if (content.kind === "image") {
      this.image(content.data, indent + 6);
    } else {
      this.text(content.reason, { size: SMALL, color: MUTED, indent: indent + 6 });
    }
    this.gap(2);
  }

  private image(data: Buffer, indent: number): void {
    // pdfkit reads PNG and JPEG; its typings miss openImage.
    let img: { width: number; height: number };
    try {
      img = (this.doc as unknown as { openImage(src: Buffer): { width: number; height: number } }).openImage(data);
    } catch {
      this.text("This image format is not embedded in the PDF; the HTML document shows it.", { size: SMALL, color: MUTED, indent });
      return;
    }
    const maxW = this.width - indent;
    const scale = Math.min(1, maxW / img.width, MAX_IMAGE_HEIGHT / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    this.ensure(h + 4);
    this.doc.image(img as unknown as Buffer, this.left + indent, this.doc.y, { width: w, height: h });
    this.doc.rect(this.left + indent, this.doc.y, w, h).lineWidth(0.5).stroke(LINE);
    this.doc.y += h + 4;
    this.doc.x = this.left;
  }

  /** Writes page numbers on the pages done so far and sends them to the file. */
  private flush(): void {
    const range = this.doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      this.doc.switchToPage(i);
      const bottomMargin = this.doc.page.margins.bottom;
      this.doc.page.margins.bottom = 0;
      this.font("sans", 7, MUTED);
      this.doc.text(`${this.title}  |  ${i + 1}`, this.left, this.doc.page.height - 30, { width: this.width, align: "center", lineBreak: false });
      this.doc.page.margins.bottom = bottomMargin;
    }
    this.pageNumber = range.start + range.count;
    this.doc.flushPages();
    // pdfkit keeps every laid out word of every font for good; with ids, times
    // and traces all different that grows with the document, so it is emptied here.
    const families = (this.doc as unknown as { _fontFamilies?: Record<string, { layoutCache?: object }> })._fontFamilies ?? {};
    for (const font of Object.values(families)) if (font.layoutCache) font.layoutCache = Object.create(null);
  }

  // ---------------------------------------------------------------- document parts

  header(launchId: number, launchName: string): void {
    this.text(launchName, { font: "bold", size: 18 });
    this.gap(2);
    this.inline([{ text: `Launch ${launchId}` }, { text: "Open in Allure TestOps", link: UI.launch(this.ctx.endpoint, launchId) }, { text: `Exported ${formatTime(Date.now())}` }]);
    this.doc.outline.addItem(launchName);
  }

  attributes(o: AttributesInput): void {
    const { launch } = o;
    this.h2("Launch attributes");
    const counts = STATUS_ORDER.filter((s) => o.counts.byStatus.get(s))
      .map((s) => `${STATUS_LABEL[s]} ${o.counts.byStatus.get(s)}`)
      .join(", ");
    this.table([
      ["Project", `${o.projectName} (${launch.projectId})`],
      ["Created", `${formatTime(launch.createdDate)}${launch.createdBy ? ` by ${launch.createdBy}` : ""}`],
      ["State", launch.closed ? "closed" : "open"],
      ["Test results in this document", `${o.counts.total}: ${counts}`],
      ...(o.omitted.length ? ([["Left out", o.omitted.join("\n")]] as [string, string][]) : []),
    ]);
    this.heading("Tags", 10, 6);
    this.text(launch.tags?.length ? launch.tags.map((t) => t.name).join(", ") : "No tags.", { color: launch.tags?.length ? FG : MUTED });
    this.heading("Links", 10, 6);
    const links = (launch.links ?? []).filter((l) => l.url);
    if (links.length === 0) this.text("No links.", { color: MUTED });
    for (const l of links) this.text(`• ${l.name || l.url}`, { link: l.url ?? undefined });
    this.heading("Issues", 10, 6);
    const issues = launch.issues ?? [];
    if (issues.length === 0) this.text("No issues.", { color: MUTED });
    for (const i of issues) {
      this.text(`• ${i.name}${i.summary ? ` ${i.summary}` : ""}`, i.url ? { link: i.url } : {});
    }
    if (showJobRuns(o.jobRuns)) {
      this.heading("Job runs", 10, 6);
      for (const g of o.jobRuns) {
        const j = g.jobRun;
        this.ensure(60);
        this.text(`${jobRunTitle(j)}${j ? ` (${j.id})` : ""}`, { font: "bold" });
        const meta = [j?.stage ? `stage: ${j.stage.toLowerCase()}` : "", j?.status ? `status: ${j.status.toLowerCase()}` : "", `${g.results} test results`].filter(Boolean);
        this.text(meta.join("  |  "), { size: SMALL, color: MUTED });
        if (j?.url) this.text("Open in CI", { size: SMALL, link: j.url });
        this.gap(2);
        this.environment(g.environment);
      }
    } else {
      this.heading("Environment", 10, 6);
      this.environment(o.launchEnvironment);
    }
  }

  private environment(env: Environment): void {
    if (env.size === 0) this.text("No environment variables.", { color: MUTED });
    else this.table([...env].map(([k, v]) => [k, v.join(", ")]));
  }

  contents(results: ApiTestResult[]): void {
    this.h2("Contents");
    const groups = new Map<StatusKey, ApiTestResult[]>();
    for (const r of results) groups.set(statusKey(r.status), [...(groups.get(statusKey(r.status)) ?? []), r]);
    for (const status of STATUS_ORDER) {
      const list = groups.get(status);
      if (!list?.length) continue;
      this.gap(4);
      this.ensure(30);
      const y = this.doc.y;
      const w = this.badge(status, this.left, y);
      this.font("bold", BASE).text(String(list.length), this.left + w + 5, y + 0.5);
      this.doc.y = y + 15;
      for (const r of list) this.contentsEntry(r);
    }
    this.flush();
  }

  private contentsEntry(r: ApiTestResult): void {
    this.font("sans", SMALL + 0.5, LINK);
    this.ensure(this.doc.currentLineHeight(true));
    const y = this.doc.y;
    const name = this.doc.heightOfString(r.name, { width: this.width - INDENT - 60 }) > this.doc.currentLineHeight(true) * 1.5 ? `${r.name.slice(0, 120)}…` : r.name;
    this.doc.text(name, this.left + INDENT, y, { width: this.width - INDENT - 60, goTo: `tr-${r.id}` });
    const after = this.doc.y;
    this.doc.fillColor(MUTED).text(String(r.id), this.left + this.width - 55, y, { width: 55, align: "right", lineBreak: false });
    this.doc.x = this.left;
    this.doc.y = after;
  }

  result(d: ResultDetails, jobRunName: string | null): void {
    const r = d.result;
    const status = statusKey(r.status);
    this.doc.addPage();
    this.doc.addNamedDestination(`tr-${r.id}`);
    let group = this.outlineGroups.get(status);
    if (!group) {
      group = this.doc.outline.addItem(STATUS_LABEL[status]);
      this.outlineGroups.set(status, group);
    }
    group.addItem(`${r.name} (${r.id})`);

    const y = this.doc.y;
    const bw = this.badge(status, this.left, y + 2);
    this.font("bold", 12).text(r.name, this.left + bw + 6, y, { width: this.width - bw - 6, continued: true });
    this.doc.font("sans").fontSize(9).fillColor(MUTED).text(`  ${r.id}`);
    this.doc.x = this.left;
    this.gap(2);
    if (r.fullName) this.text(r.fullName, { size: SMALL, color: MUTED });
    this.gap(2);

    const links: { text: string; link?: string }[] = [];
    if (r.testCaseId != null) links.push({ text: `Test case ${r.testCaseId}`, link: UI.testCase(this.ctx.endpoint, this.ctx.projectId, r.testCaseId) });
    links.push({ text: "Open in Allure TestOps", link: UI.testResult(this.ctx.endpoint, r.id) });
    if (r.start != null) links.push({ text: formatTime(r.start) });
    if (r.duration != null) links.push({ text: formatDuration(r.duration) });
    if (jobRunName) links.push({ text: `Job run: ${jobRunName}` });
    this.inline(links);
    this.gap(6);

    if (isBad(status)) this.error(r.message, r.trace, 0, status);
    this.table(this.attributeRows(d));
    this.description(r);

    const top = { steps: [] as ApiStep[], attachments: [] as ApiAttachmentRow[] };
    for (const s of d.scenario?.steps ?? []) {
      if (s.type === "attachment") {
        if (s.attachment && !s.attachment.missed) top.attachments.push(s.attachment);
      } else top.steps.push(s);
    }
    const before = d.fixtures.filter((f) => f.type === "before");
    const after = d.fixtures.filter((f) => f.type === "after");
    if (this.ctx.sections.scenario && (before.length || top.steps.length || after.length)) {
      this.heading("Scenario", 10, 6);
      for (const f of before) this.fixture("Set up", f);
      this.steps(top.steps, "result", 0);
      for (const f of after) this.fixture("Tear down", f);
    }
    if (this.ctx.sections.attachments && top.attachments.length) {
      this.heading(`Attachments (${top.attachments.length})`, 10, 6);
      for (const a of top.attachments) this.attachment("result", a, 0);
    }
    this.flush();
  }

  private attributeRows(d: ResultDetails): [string, string][] {
    const r = d.result;
    const rows: [string, string][] = manualRows(r);
    const sections = this.ctx.sections;
    if (sections.customFields) {
      for (const cf of d.customFields) {
        const values = (cf.values ?? []).map((v) => v.name).join(", ");
        if (values) rows.push([cf.customField.name, values]);
      }
    }
    const roles = new Map<string, string[]>();
    for (const m of d.members) roles.set(m.role?.name ?? "Member", [...(roles.get(m.role?.name ?? "Member") ?? []), m.name]);
    for (const [role, names] of roles) rows.push([role, names.join(", ")]);
    if (r.layer?.name) rows.push(["Layer", r.layer.name]);
    if (r.tags?.length) rows.push(["Tags", r.tags.map((t) => t.name).join(", ")]);
    const params = (r.parameters ?? []).filter((p) => !p.hidden);
    if (params.length) rows.push(["Parameters", params.map((p) => `${p.name} = ${p.value ?? ""}`).join("\n")]);
    if (sections.environment) {
      const env: Environment = new Map();
      addEnvironment(env, d.environment ?? []);
      rows.push(["Environment", env.size ? [...env].map(([n, v]) => `${n}: ${v.join(", ")}`).join("\n") : "none"]);
    }
    const links = [...(r.links ?? []).filter((l) => l.url).map((l) => `${l.name || l.url}: ${l.url}`), ...d.issues.map((i) => (i.url ? `${i.name}: ${i.url}` : i.name))];
    if (links.length) rows.push(["Links", links.join("\n")]);
    if (r.hostId || r.threadId) rows.push(["Host / thread", [r.hostId, r.threadId].filter(Boolean).join(" / ")]);
    const flags = [r.flaky && "flaky", r.muted && "muted", r.known && "known issue", r.hidden && "earlier retry"].filter(Boolean);
    if (flags.length) rows.push(["Flags", flags.join(", ")]);
    return rows;
  }

  private description(r: ApiTestResult): void {
    const part = (title: string, html: string | null | undefined, text: string | null | undefined) => {
      const body = html ? htmlToText(html) : (text ?? "").trim();
      if (!body) return;
      this.heading(title, 10, 4);
      this.text(body);
    };
    part("Description", r.descriptionHtml, r.description);
    part("Precondition", r.preconditionHtml, r.precondition);
    part("Expected result", r.expectedResultHtml, r.expectedResult);
  }

  private fixture(title: string, f: ApiFixture): void {
    this.stepLine(f.status ? statusKey(f.status) : null, `${title}: ${f.name ?? ""}`, f.start != null && f.stop != null ? f.stop - f.start : null, 0, true);
    if (f.status && isBad(f.status)) this.error(f.message, f.trace, INDENT + 2, f.status);
    this.steps(f.scenario?.steps, "fixture", INDENT);
  }

  private stepLine(status: StatusKey | null, name: string, duration: number | null, indent: number, bold = false): void {
    const x = this.left + indent;
    this.font(bold || isBad(status) ? "bold" : "sans", BASE);
    this.ensure(this.doc.currentLineHeight(true));
    const y = this.doc.y;
    if (status) this.icon(status, x, y + 1.5);
    const color = status === "failed" ? COLORS.failed : status === "broken" ? BROKEN_TEXT : FG;
    this.doc.fillColor(color).text(name || " ", x + 13, y, { width: this.width - indent - 13, continued: duration != null });
    if (duration != null) this.doc.font("sans").fontSize(SMALL).fillColor(MUTED).text(`  ${formatDuration(duration)}`);
    this.doc.x = this.left;
  }

  private steps(steps: ApiStep[] | null | undefined, owner: AttachmentOwner, indent: number): void {
    for (const step of steps ?? []) {
      if (step.type === "attachment") {
        if (this.ctx.sections.attachments && step.attachment && !step.attachment.missed) this.attachment(owner, step.attachment, indent + 13);
        continue;
      }
      const status = step.status ? statusKey(step.status) : null;
      const duration = step.duration ?? (step.start != null && step.stop != null ? step.stop - step.start : null);
      this.stepLine(status, step.body ?? "", duration, indent);
      if (step.type === "body" && step.parameters?.length) {
        this.text(step.parameters.map((p) => `${p.name} = ${p.value ?? ""}`).join("; "), { size: SMALL, color: MUTED, indent: indent + 13 });
      }
      if (isBad(status)) this.error(step.message, step.type === "body" ? step.trace : null, indent + 13, status!);
      if (step.type === "body") {
        this.steps(step.steps, owner, indent + INDENT);
        if (step.expectedResultSteps?.length) {
          this.text("Expected result", { font: "bold", size: SMALL, color: MUTED, indent: indent + 13 });
          this.steps(step.expectedResultSteps, owner, indent + INDENT);
        }
      }
      this.gap(1);
    }
  }

  async close(): Promise<void> {
    this.flush();
    this.doc.end();
    await this.done;
  }

  get pages(): number {
    return this.pageNumber;
  }
}

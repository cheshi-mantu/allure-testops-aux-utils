import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobContext } from "../src/jobs.js";
import type { ApiLaunch, ResultDetails } from "../src/launchReport/api.js";
import { exportLaunchDocument } from "../src/launchDocument/export.js";
import { htmlToText } from "../src/launchDocument/pdf.js";
import { contentsSection, esc, formatDuration, resultSection, sanitizeHtml } from "../src/launchDocument/render.js";
import type { Page } from "../src/testops.js";
import { useMock } from "./mock.js";

const ALL = { scenario: true, customFields: true, environment: true, attachments: true };
const NONE = { scenario: false, customFields: false, environment: false, attachments: false };

const ctx = {
  endpoint: "https://testops.example.com",
  projectId: 3,
  sections: ALL,
  attachment: (_owner: "result" | "fixture", row: { id: number }) =>
    row.id === 1 ? ({ kind: "text", text: "<log>" } as const) : ({ kind: "none", reason: "Not embedded." } as const),
};

function details(overrides: Partial<ResultDetails> = {}): ResultDetails {
  return {
    result: { id: 7, name: "Login <works>", status: "failed", testCaseId: 42, duration: 1500, message: "boom", trace: "at x" },
    scenario: null,
    fixtures: [],
    customFields: [{ customField: { id: 1, name: "Epic" }, values: [{ name: "Auth" }] }],
    members: [{ name: "alice", role: { name: "Owner" } }],
    issues: [],
    ...overrides,
  };
}

describe("render", () => {
  it("escapes and sanitizes", () => {
    expect(esc(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
    const html = sanitizeHtml(`<p onclick="x()">hi<script>alert(1)</script><img src="/api/rs/a.png"><a href="javascript:evil()">l</a></p>`, "https://t.example");
    expect(html).toBe(`<p>hi<img src="https://t.example/api/rs/a.png"><a href="#">l</a></p>`);
  });

  it("turns description HTML into text for the PDF", () => {
    expect(htmlToText("<p>One &amp; <b>two</b></p><ul><li>a</li><li>b&#33;</li></ul>")).toBe("One & two\n\n• a\n• b!");
  });

  it("formats durations", () => {
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });

  it("renders a test result with its anchor, backlinks, fields and steps", () => {
    const html = resultSection(
      details({
        scenario: {
          steps: [
            { type: "body", body: "Open", status: "passed", steps: [{ type: "attachment", attachment: { id: 1, name: "log.txt", contentType: "text/plain", contentLength: 5 } }] },
            { type: "body", body: "Check", status: "failed", message: "Expected 1", trace: "at y" },
            { type: "attachment", attachment: { id: 2, name: "video.mp4", contentType: "video/mp4" } },
          ],
        },
      }),
      ctx,
      "web-tests #5",
    );
    expect(html).toContain('id="tr-7"');
    expect(html).toContain("Login &lt;works&gt;");
    expect(html).toContain('href="https://testops.example.com/project/3/test-cases/42"');
    expect(html).toContain('href="https://testops.example.com/testresult/7"');
    expect(html).toContain("<tr><th>Epic</th><td>Auth</td></tr>");
    expect(html).toContain("<tr><th>Owner</th><td>alice</td></tr>");
    expect(html).toContain("Job run: web-tests #5");
    // The failed step is marked and its error is collapsed.
    expect(html).toMatch(/<li class="step bad step-failed">.*Check.*<details class="error"><summary>Error: Expected 1<\/summary>/s);
    // Steps get status icons, not badges.
    expect(html).toContain('<use href="#i-passed"/>');
    expect(html).not.toMatch(/<li class="step[^"]*"><div class="step-head"><span class="badge/);
    // A step attachment is embedded; a test-level one is listed in the collapsed attachments section.
    expect(html).toContain("<pre>&lt;log&gt;</pre>");
    expect(html).toMatch(/<details class="section"><summary>Attachments \(1\)<\/summary>.*video\.mp4.*Not embedded\./s);
  });

  it("always shows the assignee of a manual test and leaves out switched off sections", () => {
    const d = details({
      result: { id: 9, name: "Manual", status: "passed", manual: true, assignee: "bob", assigneeUser: { username: "bob", firstName: "Bob", lastName: "Smith" } },
      scenario: { steps: [{ type: "body", body: "Do it", status: "passed" }, { type: "attachment", attachment: { id: 2, name: "photo.png", contentType: "image/png" } }] },
      environment: [{ name: "chrome", variable: { name: "browser" } }],
    });
    const full = resultSection(d, ctx, null);
    expect(full).toContain("<tr><th>Assignee</th><td>Bob Smith (bob)</td></tr>");
    expect(full).toContain("<tr><th>Epic</th>");
    expect(full).toContain("browser: chrome");
    expect(full).toContain("Do it");
    expect(full).toContain("photo.png");

    const bare = resultSection(d, { ...ctx, sections: NONE }, null);
    expect(bare).toContain("<tr><th>Assignee</th><td>Bob Smith (bob)</td></tr>");
    expect(bare).not.toContain("Epic");
    expect(bare).not.toContain("Environment");
    expect(bare).not.toContain("Scenario");
    expect(bare).not.toContain("photo.png");
    // Members are not a custom field and stay.
    expect(bare).toContain("<tr><th>Owner</th><td>alice</td></tr>");

    const unassigned = resultSection(details({ result: { id: 10, name: "M", status: null, manual: true } }), ctx, null);
    expect(unassigned).toContain("<tr><th>Assignee</th><td>not assigned</td></tr>");
  });

  it("groups the contents by status", () => {
    const html = contentsSection([
      { id: 1, name: "a", status: "passed" },
      { id: 2, name: "b", status: "failed" },
      { id: 3, name: "c", status: null },
    ]);
    expect(html.indexOf("Failed")).toBeLessThan(html.indexOf("Passed"));
    expect(html).toContain('<a href="#tr-3">c</a>');
    expect(html).toContain("In progress");
  });
});

const client = useMock();
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "launch-document-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function context(): JobContext & { warnings: string[] } {
  const warnings: string[] = [];
  return { dir, signal: new AbortController().signal, warnings, title: () => {}, summary: () => {}, phase: () => {}, advance: () => {}, log: () => {}, warn: (l) => warnings.push(l) };
}

describe("exportLaunchDocument", () => {
  it("writes the whole launch with job runs, contents and test results", async () => {
    const launches = await client().get<Page<ApiLaunch>>("/api/rs/launch", { projectId: "1", size: "10" });
    const launch = launches.content[0];
    const c = context();
    const [file, pdfFile] = await exportLaunchDocument(
      client(),
      { launchId: launch.id, statuses: [], includeRetries: false, embedAttachments: true, maxAttachmentMb: 2, maxTotalAttachmentMb: 200, pdf: true, sections: ALL },
      c,
    );
    expect(c.warnings).toEqual([]);
    expect(file.name).toMatch(/-document\.html$/);
    expect(pdfFile.name).toMatch(/-document\.pdf$/);
    const html = readFileSync(file.path, "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain(`<h1 id="top">${launch.name}</h1>`);
    expect(html).toContain("web-tests-chrome #200");
    expect(html).toContain("web-tests-firefox #201");
    expect(html).toContain("SHOP-700");
    expect(html.match(/<section class="result"/g)).toHaveLength(40);
    expect(html.indexOf('id="contents"')).toBeLessThan(html.indexOf('id="results"'));
    expect(html).toContain("data:image/png;base64,");
    // Printed, every test result starts a page.
    expect(html).toContain(".result + .result { break-before: page; }");

    const pdf = readFileSync(pdfFile.path).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    // Attributes and contents take two pages, then one page per test result.
    expect(pdf.match(/\/Type \/Page\b(?!s)/g)).toHaveLength(42);
    expect(pdf).toContain("/Outlines");
    expect(pdf).toContain("(tr-");
    // Every test result has its environment, and manual ones their assignee.
    expect(html.match(/<tr><th>Environment<\/th>/g)).toHaveLength(40);
    expect(html).toContain("<tr><th>Assignee</th><td>Bob Tester (bob)</td></tr>");
    expect(html).toContain("<tr><th>Assignee</th><td>not assigned</td></tr>");
  });

  it("leaves out the sections switched off", async () => {
    const launches = await client().get<Page<ApiLaunch>>("/api/rs/launch", { projectId: "1", size: "10" });
    const [file, pdfFile] = await exportLaunchDocument(
      client(),
      { launchId: launches.content[1].id, statuses: [], includeRetries: false, embedAttachments: true, maxAttachmentMb: 2, maxTotalAttachmentMb: 200, pdf: true, sections: NONE },
      context(),
    );
    const html = readFileSync(file.path, "utf8");
    expect(html).toContain("Not included: scenario, custom fields, environment variables, attachments");
    expect(html).not.toContain("<summary>Scenario</summary>");
    expect(html).not.toContain("Attachment:");
    expect(html).not.toContain("<tr><th>Suite</th>");
    expect(html).not.toContain("<tr><th>Environment</th>");
    expect(html).toContain("<tr><th>Assignee</th>");
    expect(readFileSync(pdfFile.path).toString("latin1").startsWith("%PDF-")).toBe(true);
  });

  it("keeps only the chosen statuses", async () => {
    const launches = await client().get<Page<ApiLaunch>>("/api/rs/launch", { projectId: "1", size: "10" });
    const c = context();
    const files = await exportLaunchDocument(
      client(),
      { launchId: launches.content[1].id, statuses: ["failed", "broken"], includeRetries: true, embedAttachments: false, maxAttachmentMb: 0, maxTotalAttachmentMb: 0, pdf: false, sections: ALL },
      c,
    );
    expect(files).toHaveLength(1);
    const [file] = files;
    const html = readFileSync(file.path, "utf8");
    const sections = html.match(/<section class="result"[\s\S]*?<\/section>/g) ?? [];
    expect(sections.length).toBeGreaterThan(0);
    for (const s of sections) expect(s).toMatch(/badge st-(failed|broken)/);
    expect(html).toContain("test results with other statuses");
    expect(html).not.toContain("data:image");
  });
});

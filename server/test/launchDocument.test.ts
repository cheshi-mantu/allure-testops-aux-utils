import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobContext } from "../src/jobs.js";
import type { ApiLaunch, ResultDetails } from "../src/launchReport/api.js";
import { exportLaunchDocument } from "../src/launchDocument/export.js";
import { contentsSection, esc, formatDuration, resultSection, sanitizeHtml } from "../src/launchDocument/render.js";
import type { Page } from "../src/testops.js";
import { useMock } from "./mock.js";

const ctx = {
  endpoint: "https://testops.example.com",
  projectId: 3,
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
  return { dir, signal: new AbortController().signal, warnings, title: () => {}, phase: () => {}, advance: () => {}, log: () => {}, warn: (l) => warnings.push(l) };
}

describe("exportLaunchDocument", () => {
  it("writes the whole launch with job runs, contents and test results", async () => {
    const launches = await client().get<Page<ApiLaunch>>("/api/rs/launch", { projectId: "1", size: "10" });
    const launch = launches.content[0];
    const c = context();
    const file = await exportLaunchDocument(
      client(),
      { launchId: launch.id, statuses: [], includeRetries: false, embedAttachments: true, maxAttachmentMb: 2, maxTotalAttachmentMb: 200 },
      c,
    );
    expect(c.warnings).toEqual([]);
    expect(file.name).toMatch(/-document\.html$/);
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
  });

  it("keeps only the chosen statuses", async () => {
    const launches = await client().get<Page<ApiLaunch>>("/api/rs/launch", { projectId: "1", size: "10" });
    const c = context();
    const file = await exportLaunchDocument(
      client(),
      { launchId: launches.content[1].id, statuses: ["failed", "broken"], includeRetries: true, embedAttachments: false, maxAttachmentMb: 0, maxTotalAttachmentMb: 0 },
      c,
    );
    const html = readFileSync(file.path, "utf8");
    const sections = html.match(/<section class="result"[\s\S]*?<\/section>/g) ?? [];
    expect(sections.length).toBeGreaterThan(0);
    for (const s of sections) expect(s).toMatch(/badge st-(failed|broken)/);
    expect(html).toContain("test results with other statuses");
    expect(html).not.toContain("data:image");
  });
});

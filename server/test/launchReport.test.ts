import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobContext } from "../src/jobs.js";
import type { ApiLaunch } from "../src/launchReport/api.js";
import { exportLaunchReport } from "../src/launchReport/export.js";
import type { Page } from "../src/testops.js";
import { useMock } from "./mock.js";

const client = useMock();
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "launch-report-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function context(): JobContext & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    dir,
    signal: new AbortController().signal,
    warnings,
    title: () => {},
    phase: () => {},
    advance: () => {},
    log: () => {},
    warn: (line) => warnings.push(line),
  };
}

describe("exportLaunchReport", () => {
  it("builds a single-file Allure report from a launch", async () => {
    const launches = await client().get<Page<ApiLaunch>>("/api/rs/launch", { projectId: "1", size: "10" });
    const launch = launches.content[0];
    const ctx = context();
    const file = await exportLaunchReport(
      client(),
      { launchId: launch.id, reportName: "", includeAttachments: true, maxAttachmentMb: 10, includeRetries: true, groupBy: "auto", theme: "auto" },
      ctx,
    );
    expect(file.name).toMatch(/^launch-\d+-Web-Shop-nightly-100\.html$/);
    const html = readFileSync(file.path, "utf8");
    expect(html.length).toBeGreaterThan(100_000);
    expect(html).toContain("Web Shop nightly #100");
    expect(ctx.warnings).toEqual([]);
  }, 120_000);
});

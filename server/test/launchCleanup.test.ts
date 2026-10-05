import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobContext } from "../src/jobs.js";
import { cleanupAql, countLaunches, deleteLaunches, scanLaunches, type CleanupOptions, type CleanupPlan, type DeleteSummary } from "../src/launchCleanup.js";
import { useMock } from "./mock.js";

const client = useMock();
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "launch-cleanup-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function context(): JobContext & { warnings: string[]; last: () => unknown } {
  const warnings: string[] = [];
  let summary: unknown = null;
  return {
    dir,
    signal: new AbortController().signal,
    warnings,
    last: () => summary,
    title: () => {},
    summary: (s) => (summary = structuredClone(s)),
    phase: () => {},
    advance: () => {},
    log: () => {},
    warn: (l) => warnings.push(l),
  };
}

// The mock has 12 launches per project, created 1, 3, 5 … 23 days ago; all but the newest are closed.
const options = (o: Partial<CleanupOptions> = {}): CleanupOptions => ({ projectId: 1, keepDays: 10, aql: "true", onlyClosed: true, threads: 4, ...o });

async function scan(o?: Partial<CleanupOptions>): Promise<{ plan: CleanupPlan; csv: string }> {
  const [json, table] = await scanLaunches(client(), options(o), context());
  return { plan: JSON.parse(readFileSync(json.path, "utf8")) as CleanupPlan, csv: readFileSync(table.path, "utf8") };
}

describe("launch cleanup", () => {
  it("builds the query from the days to keep, the filter and the closed flag", () => {
    expect(cleanupAql({ aql: 'tag = "nightly"', onlyClosed: true }, 1000)).toBe('(tag = "nightly") and createdDate < 1000 and closed = true');
    expect(cleanupAql({ aql: "", onlyClosed: false }, 1000)).toBe("(true) and createdDate < 1000");
  });

  it("counts the launches older than the days to keep", async () => {
    expect(await countLaunches(client(), options())).toBe(7);
    expect(await countLaunches(client(), options({ keepDays: 0 }))).toBe(11);
    expect(await countLaunches(client(), options({ keepDays: 0, onlyClosed: false }))).toBe(12);
    expect(await countLaunches(client(), options({ aql: 'tag = "ui"' }))).toBe(2);
    await expect(countLaunches(client(), options({ aql: "nonsense ==" }))).rejects.toThrow(/does not accept/);
  });

  it("lists the launches with their attributes in a dry run", async () => {
    const { plan, csv } = await scan();
    expect(plan.launches).toHaveLength(7);
    // Oldest first.
    expect(plan.launches.map((l) => l.createdDate)).toEqual([...plan.launches.map((l) => l.createdDate)].sort((a, b) => a! - b!));
    for (const l of plan.launches) {
      expect(l.closed).toBe(true);
      expect(l.createdDate).toBeLessThan(plan.before);
      expect(l.results).toBe(40);
      expect(l.tags.length).toBeGreaterThan(0);
      expect(l.env.some((e) => e.startsWith("browser="))).toBe(true);
      expect(l.url).toMatch(/\/launch\/\d+$/);
    }
    expect(csv.split("\n")[0]).toBe("id,name,created,created by,closed,tags,environment,results,passed,failed,broken,skipped,unknown,url");
    expect(csv.trim().split("\n")).toHaveLength(8);
  });

  it("deletes the chosen launches and leaves the rest", async () => {
    const { plan } = await scan({ aql: 'tag = "nightly" or tag = "smoke"' });
    expect(plan.launches.length).toBeGreaterThan(2);
    const [kept, gone, ...rest] = plan.launches;
    // One goes before the deletion: it is skipped, not counted as a failure.
    await client().delete(`/api/rs/launch/${gone.id}`).catch(() => {});
    const ctx = context();
    await deleteLaunches(client(), plan, [gone.id, ...rest.map((l) => l.id)], ctx);
    expect(ctx.last()).toMatchObject({ deleted: rest.length, skipped: 1, failed: 0 } satisfies Partial<DeleteSummary>);
    // The mock deletes some launches but answers 500: they are looked up and counted as deleted.
    const answered500 = rest.filter((l) => l.id % 7 === 0).length;
    expect(ctx.warnings.filter((w) => w.includes("though Allure TestOps answered"))).toHaveLength(answered500);
    const left = await scan({ aql: 'tag = "nightly" or tag = "smoke"' });
    expect(left.plan.launches.map((l) => l.id)).toEqual([kept.id]);
  });
});

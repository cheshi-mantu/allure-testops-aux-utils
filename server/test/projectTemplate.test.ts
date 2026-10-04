import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobContext } from "../src/jobs.js";
import { applyTemplate, previewTemplate, type TemplateSummary } from "../src/projectTemplate/run.js";
import { planKeyed, SECTION_KEYS, type CopyContext } from "../src/projectTemplate/sections.js";
import { useMock } from "./mock.js";

const client = useMock();
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "project-template-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function context(): JobContext & { warnings: string[]; last: () => TemplateSummary } {
  const warnings: string[] = [];
  let summary: unknown = null;
  return {
    dir,
    signal: new AbortController().signal,
    warnings,
    last: () => summary as TemplateSummary,
    title: () => {},
    summary: (s) => (summary = structuredClone(s)),
    phase: () => {},
    advance: () => {},
    log: () => {},
    warn: (l) => warnings.push(l),
  };
}

type Row = Record<string, unknown> & { projectId?: number | null };
type Config = Record<string, Row[]>;

async function config(): Promise<Config> {
  return client().get<Config>("/mock/config");
}

/** Rows of a project without ids and project ids, sorted, to compare two projects. */
function of(rows: Row[], projectId: number, drop: string[] = []): string[] {
  return rows
    .filter((r) => r.projectId === projectId)
    .map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !["id", "projectId", ...drop].includes(k)).sort(([a], [b]) => a.localeCompare(b)))))
    .sort();
}

const sections = [...SECTION_KEYS];

describe("project template", () => {
  let targetId = 0;

  it("previews a new project as a list of things to create", async () => {
    const preview = await previewTemplate(client(), { sourceProjectId: 1, target: { mode: "new", name: "Web Shop 2", abbr: "W2", description: "", isPublic: false }, sections });
    expect(preview.sections.map((s) => s.key)).toEqual(sections);
    expect(preview.sections.every((s) => s.error === null)).toBe(true);
    const all = preview.sections.flatMap((s) => s.actions);
    expect(all.some((a) => a.kind === "create" && a.name === "custom field Priority")).toBe(true);
    expect(all.some((a) => a.kind === "manual" && a.name === "integration secrets")).toBe(true);
    expect(preview.warnings.some((w) => w.includes("defaults"))).toBe(true);
  });

  it("creates a project with the configuration of the source", async () => {
    const ctx = context();
    const file = await applyTemplate(client(), { sourceProjectId: 1, target: { mode: "new", name: "Web Shop 2", abbr: "W2", description: "Copy", isPublic: false }, sections }, ctx);
    const summary = ctx.last();
    targetId = summary.targetProject!.id;
    expect(summary.sections.every((s) => s.failed === 0 && s.error === null)).toBe(true);
    expect(ctx.warnings.filter((w) => !w.includes("integration secrets"))).toEqual([]);
    expect(JSON.parse(readFileSync(file.path, "utf8")).actions.length).toBeGreaterThan(20);

    const c = await config();
    for (const table of ["cfProject", "cfschema", "evschema", "workflowschema", "testlayerschema", "roleschema", "issueschema", "testkeyschema", "testcaseupdateschema", "cleanerschema", "projectproperty", "labels", "labelValues", "exports", "webhooks", "trees", "groupAccess"]) {
      expect(of(c[table], targetId), table).toEqual(of(c[table], 1));
    }
    expect(of(c.releaseStatus, targetId)).toEqual(of(c.releaseStatus, 1));
    expect(of(c.releaseWorkflow, targetId, ["statusIds"])).toEqual(of(c.releaseWorkflow, 1, ["statusIds"]));
    expect(of(c.projectIntegrations, targetId)).toEqual(of(c.projectIntegrations, 1));
    // Project settings are kept in the properties compared above.
    // Only shared filters; the source's own category and matcher are recreated, the shared category attached.
    expect(of(c.filters, targetId)).toEqual(of(c.filters.filter((f) => f.shared), 1));
    expect(of(c.categories, targetId)).toEqual(of(c.categories, 1));
    expect(c.projectCategories.filter((r) => r.projectId === targetId)).toHaveLength(1);
    expect(of(c.matchers, targetId, ["categoryId"])).toEqual(of(c.matchers, 1, ["categoryId"]));
    expect(of(c.dashboards, targetId)).toEqual(of(c.dashboards, 1));
    // CI jobs are not copied.
    expect(of(c.jobs, 1)).toHaveLength(1);
    expect(of(c.jobs, targetId)).toEqual([]);
    // The token owner keeps the access they got with the new project; the others are copied.
    expect(c.collaborators.filter((r) => r.projectId === targetId).map((r) => r.username).sort()).toEqual(["alice", "mock"]);
  });

  it("finds nothing left to do on a second run", async () => {
    const preview = await previewTemplate(client(), { sourceProjectId: 1, target: { mode: "existing", projectId: targetId }, sections });
    const todo = preview.sections.flatMap((s) => s.actions.filter((a) => a.kind !== "skip" && a.kind !== "manual").map((a) => `${s.key}: ${a.kind} ${a.name} ${a.detail ?? ""}`));
    expect(todo).toEqual([]);
  });

  it("adds to an existing project without removing anything", async () => {
    const preview = await previewTemplate(client(), { sourceProjectId: 1, target: { mode: "existing", projectId: 2 }, sections: ["customFields", "environments"] });
    const actions = preview.sections.flatMap((s) => s.actions);
    expect(actions.some((a) => a.kind === "remove")).toBe(false);
    expect(actions.some((a) => a.kind === "create" && a.name === "environment mapping stand")).toBe(true);
  });

  it("refuses a name another project has", async () => {
    await expect(
      previewTemplate(client(), { sourceProjectId: 1, target: { mode: "new", name: "web shop", abbr: "", description: "", isPublic: false }, sections }),
    ).rejects.toThrow(/exists already/);
  });

  it("leaves a default field a tree still uses to be removed by hand", async () => {
    const ctx = context();
    await applyTemplate(client(), { sourceProjectId: 1, target: { mode: "new", name: "Fields only", abbr: "", description: "", isPublic: false }, sections: ["customFields"] }, ctx);
    const summary = ctx.last();
    expect(summary.sections[0].failed).toBe(0);
    expect(summary.sections[0].counts.manual).toBe(1);
    // The default tree "Features" of the new project keeps Story in it.
    expect(ctx.warnings.some((w) => w.includes("custom field Story") && w.includes("Features"))).toBe(true);
    const c = await config();
    const linked = (p: number) => c.cfProject.filter((r) => r.projectId === p).length;
    expect(linked(summary.targetProject!.id)).toBe(linked(1) + 1);
  });

  it("refuses to copy a project into itself", async () => {
    await expect(previewTemplate(client(), { sourceProjectId: 1, target: { mode: "existing", projectId: 1 }, sections })).rejects.toThrow(/same project/);
  });
});

describe("planKeyed", () => {
  const c = { target: 5, fresh: false } as CopyContext;
  type P = { id: number; name: string; value: string };

  it("updates an entry Allure TestOps created by itself in the meantime instead of failing", async () => {
    const calls: string[] = [];
    let target: P[] = [];
    const [action] = planKeyed<P, P>(c, {
      what: "property",
      source: [{ id: 1, name: "launch.run.timeout", value: "60" }],
      target,
      reload: async () => target,
      sourceKey: (p) => p.name,
      targetKey: (p) => p.name,
      fields: (p) => ({ value: p.value }),
      targetFields: (p) => ({ value: p.value }),
      create: async () => {
        // The server made the entry by itself and refuses a second one.
        target = [{ id: 9, name: "launch.run.timeout", value: "604800" }];
        calls.push("create");
        throw new Error("500 Internal Server Error: duplicate");
      },
      update: async (_s, t) => {
        calls.push(`update ${t.id}`);
      },
    });
    expect(action.kind).toBe("create");
    await action.run!();
    expect(calls).toEqual(["create", "update 9"]);
  });

  it("still fails when the entry is not there after all", async () => {
    const [action] = planKeyed<P, P>(c, {
      what: "property",
      source: [{ id: 1, name: "x", value: "1" }],
      target: [],
      reload: async () => [],
      sourceKey: (p) => p.name,
      targetKey: (p) => p.name,
      fields: (p) => ({ value: p.value }),
      targetFields: (p) => ({ value: p.value }),
      create: async () => {
        throw new Error("boom");
      },
    });
    await expect(action.run!()).rejects.toThrow("boom");
  });
});

/**
 * Copying the configuration of one Allure TestOps project into another.
 * Every section reads the source and the target and plans actions; running
 * the actions makes the target match the source. Entries are matched by name
 * or key, so a second run only does what the first one left undone.
 */
import type { TestOpsClient } from "../testops.js";

export type ActionKind = "create" | "update" | "remove" | "skip" | "manual";

export interface PlannedAction {
  kind: ActionKind;
  /** What the action is about, e.g. "custom field Epic". */
  name: string;
  detail?: string;
  /** Absent for skip and manual. */
  run?: () => Promise<unknown>;
}

export interface CopyContext {
  client: TestOpsClient;
  source: number;
  /** null while previewing a project that does not exist yet. */
  target: number | null;
  /** The target was just created: defaults Allure TestOps put there and the source lacks are removed. */
  fresh: boolean;
  /** Login of the API token owner. */
  me: string;
  /** Ids of entries created during this run, by kind, source id → target id. */
  ids: Map<string, Map<number, number>>;
}

export interface Section {
  key: SectionKey;
  label: string;
  description: string;
  plan(c: CopyContext): Promise<PlannedAction[]>;
}

export const SECTION_KEYS = [
  "settings",
  "trees",
  "customFields",
  "environments",
  "workflows",
  "testLayers",
  "roles",
  "categories",
  "integrations",
  "webhooks",
  "filters",
  "dashboards",
  "access",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

// ---------------------------------------------------------------- helpers

type Obj = Record<string, unknown>;

async function list<T>(c: CopyContext, path: string, params: Record<string, string> = {}): Promise<T[]> {
  return c.client.all<T>(path, params);
}

/** Lists of the target; empty for a project not created yet. */
async function targetList<T>(c: CopyContext, path: (target: number) => string, params: (target: number) => Record<string, string> = () => ({})): Promise<T[]> {
  return c.target === null ? [] : list<T>(c, path(c.target), params(c.target));
}

function tgt(c: CopyContext): number {
  if (c.target === null) throw new Error("No target project");
  return c.target;
}

function idMap(c: CopyContext, kind: string): Map<number, number> {
  if (!c.ids.has(kind)) c.ids.set(kind, new Map());
  return c.ids.get(kind)!;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields of `want` that differ in `have`, for a short note. */
function differences(want: Obj, have: Obj): string[] {
  return Object.keys(want).filter((k) => !same(want[k], have[k]));
}

/**
 * Plans keyed entries: create the missing ones, update those that differ,
 * remove the target's extras when the target is a fresh project.
 */
export function planKeyed<S, T>(
  c: CopyContext,
  o: {
    what: string;
    source: S[];
    target: T[];
    /** Reads the target again after a failed create. */
    reload?: () => Promise<T[]>;
    sourceKey: (s: S) => string;
    targetKey: (t: T) => string;
    /** Fields to compare and write. */
    fields: (s: S) => Obj;
    targetFields: (t: T) => Obj;
    create: (s: S) => Promise<unknown>;
    update?: (s: S, t: T) => Promise<unknown>;
    remove?: (t: T) => Promise<unknown>;
    /** Entries Allure TestOps will not let go, e.g. system ones. */
    keep?: (t: T) => boolean;
  },
): PlannedAction[] {
  const actions: PlannedAction[] = [];
  const byKey = new Map(o.target.map((t) => [o.targetKey(t), t]));
  const sourceKeys = new Set(o.source.map(o.sourceKey));
  for (const s of o.source) {
    const key = o.sourceKey(s);
    const t = byKey.get(key);
    if (!t) {
      actions.push({
        kind: "create",
        name: `${o.what} ${key}`,
        run: async () => {
          try {
            await o.create(s);
          } catch (e) {
            // Allure TestOps creates some entries by itself, e.g. writing a
            // project setting creates project properties. A failed create is
            // not repeated: the target is read again, and an entry that is
            // there by now is updated instead.
            const now = (await o.reload?.().catch(() => null))?.find((x) => o.targetKey(x) === key);
            if (!now) throw e;
            if (o.update && differences(o.fields(s), o.targetFields(now)).length) await o.update(s, now);
          }
        },
      });
      continue;
    }
    const diff = differences(o.fields(s), o.targetFields(t));
    if (diff.length === 0 || !o.update) {
      actions.push({ kind: "skip", name: `${o.what} ${key}`, detail: diff.length ? `differs in ${diff.join(", ")}, cannot be changed` : "already the same" });
    } else {
      actions.push({ kind: "update", name: `${o.what} ${key}`, detail: diff.join(", "), run: () => o.update!(s, t).then(() => undefined) });
    }
  }
  if (c.fresh && o.remove) {
    for (const t of o.target) {
      const key = o.targetKey(t);
      if (sourceKeys.has(key) || o.keep?.(t)) continue;
      actions.push({ kind: "remove", name: `${o.what} ${key}`, detail: "default of a new project, not in the source", run: () => o.remove!(t).then(() => undefined) });
    }
  }
  return actions;
}

// ---------------------------------------------------------------- sections

interface Settings {
  projectId?: number;
  [k: string]: unknown;
}
interface Property {
  id: number;
  name: string;
  value: string;
}
interface Label {
  name: string;
}
interface LabelValue {
  name: string;
  value: string;
}
interface ReleaseStatus {
  id: number;
  code: string;
  category: string;
  color?: string | null;
  isActive?: boolean;
  isSystem?: boolean;
  translations?: Record<string, string> | null;
}
interface ReleaseWorkflow {
  id: number;
  name: string;
  isDefault?: boolean;
  statuses?: { id: number; code?: string }[];
}
interface CleanerRule {
  id: number;
  status: string;
  target: string;
  delay?: number | null;
}
interface UpdatePolicy {
  id: number;
  field: string;
  policy: string;
}

const PROJECT_SETTINGS = ["launchclose", "launchlivedoc", "user-display-mode"] as const;

const settings: Section = {
  key: "settings",
  label: "Project settings",
  description: "Launch auto close and live doc settings, user display mode, project properties, labels, release statuses and workflows, cleanup rules, test case update policy",
  async plan(c) {
    const actions: PlannedAction[] = [];
    actions.push(
      ...planKeyed(c, {
        what: "property",
        source: await list<Property>(c, "/api/rs/projectproperty", { projectId: String(c.source) }),
        target: await targetList<Property>(c, () => "/api/rs/projectproperty", (t) => ({ projectId: String(t) })),
        reload: () => targetList<Property>(c, () => "/api/rs/projectproperty", (t) => ({ projectId: String(t) })),
        sourceKey: (p) => p.name,
        targetKey: (p) => p.name,
        fields: (p) => ({ value: p.value }),
        targetFields: (p) => ({ value: p.value }),
        create: (p) => c.client.post("/api/rs/projectproperty", { projectId: tgt(c), name: p.name, value: p.value }),
        update: (p, t) => c.client.patch(`/api/rs/projectproperty/${t.id}`, { value: p.value }),
      }),
    );

    // Project settings are kept as project properties too: with the properties
    // copied first, writing the settings only rewrites the same values.
    for (const name of PROJECT_SETTINGS) {
      const path = `/api/rs/projectsettings/${name}`;
      const src = await c.client.get<Settings>(path, { projectId: String(c.source) });
      const { projectId: _s, ...want } = src;
      const have = c.target === null ? null : await c.client.get<Settings>(path, { projectId: String(c.target) });
      const diff = have ? differences(want, have) : Object.keys(want);
      if (have && diff.length === 0) actions.push({ kind: "skip", name: `setting ${name}`, detail: "already the same" });
      else actions.push({ kind: "update", name: `setting ${name}`, detail: diff.join(", "), run: () => c.client.patch(path, { ...want, projectId: tgt(c) }) });
    }

    const labels = await list<Label>(c, `/api/rs/project/${c.source}/label`);
    const targetLabels = new Set((await targetList<Label>(c, (t) => `/api/rs/project/${t}/label`)).map((l) => l.name));
    for (const l of labels) {
      const values = await list<LabelValue>(c, `/api/rs/project/${c.source}/label/value`, { name: l.name });
      const have = targetLabels.has(l.name) ? await targetList<LabelValue>(c, (t) => `/api/rs/project/${t}/label/value`, () => ({ name: l.name })) : [];
      const missing = values.filter((v) => !have.some((h) => h.value === v.value));
      if (targetLabels.has(l.name) && missing.length === 0) {
        actions.push({ kind: "skip", name: `label ${l.name}`, detail: "already the same" });
        continue;
      }
      actions.push({
        kind: targetLabels.has(l.name) ? "update" : "create",
        name: `label ${l.name}`,
        detail: missing.length ? `values: ${missing.map((v) => v.value).join(", ")}` : undefined,
        run: async () => {
          if (!targetLabels.has(l.name)) await c.client.post(`/api/rs/project/${tgt(c)}/label`, { name: l.name });
          for (const v of missing) await c.client.post(`/api/rs/project/${tgt(c)}/label/value`, { name: l.name, value: v.value });
        },
      });
    }

    // Release statuses first: workflows refer to them.
    const statuses = await list<ReleaseStatus>(c, "/api/rs/project/release-status", { projectId: String(c.source), activeOnly: "false" });
    const targetStatuses = await targetList<ReleaseStatus>(c, () => "/api/rs/project/release-status", (t) => ({ projectId: String(t), activeOnly: "false" }));
    const statusIds = idMap(c, "releaseStatus");
    for (const s of statuses) {
      const t = targetStatuses.find((x) => x.code === s.code);
      if (t) statusIds.set(s.id, t.id);
    }
    const statusFields = (s: ReleaseStatus) => ({ category: s.category, color: s.color ?? null, isActive: s.isActive ?? true, translations: s.translations ?? {} });
    actions.push(
      ...planKeyed(c, {
        what: "release status",
        source: statuses,
        target: targetStatuses,
        reload: () => targetList<ReleaseStatus>(c, () => "/api/rs/project/release-status", (t) => ({ projectId: String(t), activeOnly: "false" })),
        sourceKey: (s) => s.code,
        targetKey: (s) => s.code,
        fields: statusFields,
        targetFields: statusFields,
        create: async (s) => {
          const created = await c.client.post<ReleaseStatus>("/api/rs/project/release-status", { projectId: tgt(c), code: s.code, ...statusFields(s) });
          if (created) statusIds.set(s.id, created.id);
        },
        update: (s, t) => c.client.patch(`/api/rs/project/release-status/${t.id}`, statusFields(s)),
        remove: (t) => c.client.delete(`/api/rs/project/release-status/${t.id}`),
        keep: (t) => Boolean(t.isSystem),
      }),
    );

    const workflows = await list<ReleaseWorkflow>(c, "/api/rs/project/release-workflow", { projectId: String(c.source) });
    const targetWorkflows = await targetList<ReleaseWorkflow>(c, () => "/api/rs/project/release-workflow", (t) => ({ projectId: String(t) }));
    const codes = (w: ReleaseWorkflow) => (w.statuses ?? []).map((s) => s.code ?? String(s.id));
    const mapped = (w: ReleaseWorkflow) => (w.statuses ?? []).map((s) => statusIds.get(s.id) ?? s.id);
    actions.push(
      ...planKeyed(c, {
        what: "release workflow",
        source: workflows,
        target: targetWorkflows,
        reload: () => targetList<ReleaseWorkflow>(c, () => "/api/rs/project/release-workflow", (t) => ({ projectId: String(t) })),
        sourceKey: (w) => w.name,
        targetKey: (w) => w.name,
        fields: (w) => ({ statuses: codes(w), isDefault: Boolean(w.isDefault) }),
        targetFields: (w) => ({ statuses: codes(w), isDefault: Boolean(w.isDefault) }),
        create: async (w) => {
          const created = await c.client.post<ReleaseWorkflow>("/api/rs/project/release-workflow", { projectId: tgt(c), name: w.name, statuses: mapped(w) });
          if (created && w.isDefault) await c.client.post(`/api/rs/project/release-workflow/${created.id}/default`, {});
        },
        update: async (w, t) => {
          await c.client.patch(`/api/rs/project/release-workflow/${t.id}`, { statuses: mapped(w) });
          if (w.isDefault && !t.isDefault) await c.client.post(`/api/rs/project/release-workflow/${t.id}/default`, {});
        },
        // The default one goes once the source's default has taken its place.
        remove: (t) => c.client.delete(`/api/rs/project/release-workflow/${t.id}`),
        keep: (t) => Boolean(t.isDefault) && !workflows.some((w) => w.isDefault),
      }),
    );
    // Removals go last: a default workflow goes once the new default is set,
    // and workflows go before statuses, since a removed status silently leaves the workflows using it.
    const rank = (a: PlannedAction) => (a.kind !== "remove" ? 0 : a.name.startsWith("release workflow") ? 1 : 2);
    actions.sort((a, b) => rank(a) - rank(b));

    actions.push(
      ...planKeyed(c, {
        what: "cleanup rule",
        source: await list<CleanerRule>(c, "/api/rs/cleanerschema", { projectId: String(c.source) }),
        target: await targetList<CleanerRule>(c, () => "/api/rs/cleanerschema", (t) => ({ projectId: String(t) })),
        reload: () => targetList<CleanerRule>(c, () => "/api/rs/cleanerschema", (t) => ({ projectId: String(t) })),
        sourceKey: (r) => `${r.target}/${r.status}`,
        targetKey: (r) => `${r.target}/${r.status}`,
        fields: (r) => ({ delay: r.delay ?? null }),
        targetFields: (r) => ({ delay: r.delay ?? null }),
        create: (r) => c.client.post("/api/rs/cleanerschema", { projectId: tgt(c), status: r.status, target: r.target, delay: r.delay }),
        update: (r, t) => c.client.patch(`/api/rs/cleanerschema/${t.id}`, { delay: r.delay }),
      }),
      ...planKeyed(c, {
        what: "test case update policy",
        source: await list<UpdatePolicy>(c, "/api/rs/testcaseupdateschema", { projectId: String(c.source) }),
        target: await targetList<UpdatePolicy>(c, () => "/api/rs/testcaseupdateschema", (t) => ({ projectId: String(t) })),
        reload: () => targetList<UpdatePolicy>(c, () => "/api/rs/testcaseupdateschema", (t) => ({ projectId: String(t) })),
        sourceKey: (p) => p.field,
        targetKey: (p) => p.field,
        fields: (p) => ({ policy: p.policy }),
        targetFields: (p) => ({ policy: p.policy }),
        create: (p) => c.client.post("/api/rs/testcaseupdateschema", { projectId: tgt(c), field: p.field, policy: p.policy }),
        update: (p, t) => c.client.patch(`/api/rs/testcaseupdateschema/${t.id}`, { policy: p.policy }),
      }),
    );
    return actions;
  },
};

interface ProjectCustomField {
  required?: boolean;
  locked?: boolean;
  defaultCustomFieldValueId?: number | null;
  /** `required`, `locked` and the default value here are global: they hold in every project. */
  customField: { id: number; name: string; required?: boolean; locked?: boolean; defaultCustomFieldValueId?: number | null };
}
interface CustomFieldValue {
  id: number;
  name: string;
  global?: boolean;
}
interface Schema {
  id: number;
  key: string;
  [ref: string]: unknown;
}

const customFields: Section = {
  key: "customFields",
  label: "Custom fields",
  description: "Custom fields of the project with their project values, required, locked and default value, and the mapping of result labels to custom fields",
  async plan(c) {
    const actions: PlannedAction[] = [];
    const source = await list<ProjectCustomField>(c, `/api/rs/project/${c.source}/cf`);
    const target = await targetList<ProjectCustomField>(c, (t) => `/api/rs/project/${t}/cf`);
    const linked = new Set(target.map((f) => f.customField.id));
    for (const f of source) {
      const name = `custom field ${f.customField.name}`;
      const values = await list<CustomFieldValue>(c, `/api/rs/project/${c.source}/cfv`, { customFieldId: String(f.customField.id), global: "false" });
      const have = linked.has(f.customField.id)
        ? await targetList<CustomFieldValue>(c, (t) => `/api/rs/project/${t}/cfv`, () => ({ customFieldId: String(f.customField.id), global: "false" }))
        : [];
      const missing = values.filter((v) => !have.some((h) => h.name === v.name));
      const t = target.find((x) => x.customField.id === f.customField.id);

      // Only what differs is sent, never a null: the API takes no nulls here.
      // Linking a field gives it its global required flag and default value,
      // and links its global values; it starts unlocked.
      const patch: Obj = {};
      const byHand: string[] = [];
      const want = { required: Boolean(f.required), locked: Boolean(f.locked), defaultValue: f.defaultCustomFieldValueId ?? null };
      const now = t
        ? { required: Boolean(t.required), locked: Boolean(t.locked), defaultValue: t.defaultCustomFieldValueId ?? null }
        : { required: Boolean(f.customField.required), locked: false, defaultValue: f.customField.defaultCustomFieldValueId ?? null };
      // Globally required or locked fields are so in every project.
      if (!f.customField.required && want.required !== now.required) patch.required = want.required;
      if (want.defaultValue !== now.defaultValue) {
        if (want.defaultValue === null) byHand.push("the target has a default value and the source has none: clear it in the project's custom field settings");
        else patch.defaultCustomFieldValueId = want.defaultValue;
      }
      if (!f.customField.locked && want.locked !== now.locked) {
        // A field can be locked only when it has values in the project.
        if (want.locked && values.length + have.length === 0) byHand.push("locked in the source; it can be locked in the target once it has values there");
        else patch.locked = want.locked;
      }
      for (const why of byHand) actions.push({ kind: "manual", name, detail: why });

      const changes = Object.keys(patch);
      if (t && missing.length === 0 && changes.length === 0) {
        if (byHand.length === 0) actions.push({ kind: "skip", name, detail: "already the same" });
        continue;
      }
      const detail = [missing.length ? `${missing.length} values` : "", changes.join(", ")].filter(Boolean).join("; ");
      actions.push({
        kind: t ? "update" : "create",
        name,
        detail: detail || undefined,
        run: async () => {
          const p = tgt(c);
          if (!linked.has(f.customField.id)) await c.client.post(`/api/rs/cfproject/add-to-project?projectId=${p}`, { inverted: false, ids: [f.customField.id] });
          // A project value is the same entry in every project it is used in, so its id carries over.
          // Values go first: a default value and locking need them.
          for (const v of missing) await c.client.post(`/api/rs/project/${p}/cfv`, { name: v.name, customField: { id: f.customField.id } });
          if (changes.length) await c.client.patch(`/api/rs/project/${p}/cf/${f.customField.id}`, patch);
        },
      });
    }
    if (c.fresh) {
      // A field a tree of the project uses cannot leave the project.
      const trees = await targetList<Tree>(c, () => "/api/rs/tree", (p) => ({ projectId: String(p) }));
      for (const t of target) {
        if (source.some((f) => f.customField.id === t.customField.id)) continue;
        const usedBy = trees.filter((tree) => (tree.fields ?? []).some((f) => f.id === t.customField.id)).map((tree) => tree.name);
        if (usedBy.length) {
          actions.push({ kind: "manual", name: `custom field ${t.customField.name}`, detail: `default of a new project, not in the source, but used by the tree ${usedBy.join(", ")}: remove it by hand if not needed` });
          continue;
        }
        actions.push({
          kind: "remove",
          name: `custom field ${t.customField.name}`,
          detail: "default of a new project, not in the source",
          run: () => c.client.delete(`/api/rs/cfproject/remove?customFieldId=${t.customField.id}&projectId=${tgt(c)}`),
        });
      }
    }
    actions.push(...(await planSchema(c, { what: "label mapping", path: "/api/rs/cfschema", ref: "customField", refId: "customFieldId" })));
    return actions;
  },
};

/** The per-project key → entity mappings: custom field, environment, layer, role, issue and test key schemas. */
async function planSchema(c: CopyContext, o: { what: string; path: string; ref: string; refId: string; flatRef?: boolean }): Promise<PlannedAction[]> {
  const refOf = (s: Schema) => (o.flatRef ? (s[o.refId] as number) : ((s[o.ref] as { id: number } | undefined)?.id ?? null));
  return planKeyed(c, {
    what: o.what,
    source: await list<Schema>(c, o.path, { projectId: String(c.source) }),
    target: await targetList<Schema>(c, () => o.path, (t) => ({ projectId: String(t) })),
    reload: () => targetList<Schema>(c, () => o.path, (t) => ({ projectId: String(t) })),
    sourceKey: (s) => s.key,
    targetKey: (s) => s.key,
    fields: (s) => ({ [o.refId]: refOf(s) }),
    targetFields: (s) => ({ [o.refId]: refOf(s) }),
    create: (s) => c.client.post(o.path, { projectId: tgt(c), key: s.key, [o.refId]: refOf(s) }),
    update: (s, t) => c.client.patch(`${o.path}/${t.id}`, { [o.refId]: refOf(s) }),
    remove: (t) => c.client.delete(`${o.path}/${t.id}`),
  });
}

const environments: Section = {
  key: "environments",
  label: "Environments",
  description: "Mapping of result environment keys to environment variables",
  plan: (c) => planSchema(c, { what: "environment mapping", path: "/api/rs/evschema", ref: "envVar", refId: "envVarId" }),
};

interface WorkflowSchema {
  id: number;
  type: string;
  workflow: { id: number; name?: string };
}

const workflows: Section = {
  key: "workflows",
  label: "Workflows",
  description: "Workflows of manual and automated test cases",
  async plan(c) {
    return planKeyed(c, {
      what: "workflow for",
      source: await list<WorkflowSchema>(c, "/api/rs/workflowschema", { projectId: String(c.source) }),
      target: await targetList<WorkflowSchema>(c, () => "/api/rs/workflowschema", (t) => ({ projectId: String(t) })),
      reload: () => targetList<WorkflowSchema>(c, () => "/api/rs/workflowschema", (t) => ({ projectId: String(t) })),
      sourceKey: (w) => w.type,
      targetKey: (w) => w.type,
      fields: (w) => ({ workflowId: w.workflow.id }),
      targetFields: (w) => ({ workflowId: w.workflow.id }),
      create: (w) => c.client.post("/api/rs/workflowschema", { projectId: tgt(c), type: w.type, workflowId: w.workflow.id }),
      update: (w, t) => c.client.patch(`/api/rs/workflowschema/${t.id}`, { workflowId: w.workflow.id }),
    });
  },
};

const testLayers: Section = {
  key: "testLayers",
  label: "Test layers",
  description: "Mapping of result layer keys to test layers",
  plan: (c) => planSchema(c, { what: "layer mapping", path: "/api/rs/testlayerschema", ref: "testLayer", refId: "testLayerId" }),
};

const roles: Section = {
  key: "roles",
  label: "Roles",
  description: "Mapping of result member keys to roles",
  plan: (c) => planSchema(c, { what: "role mapping", path: "/api/rs/roleschema", ref: "role", refId: "roleId" }),
};

interface Category {
  id: number;
  projectId?: number | null;
  name: string;
  color?: string;
  description?: string | null;
}
interface CategoryMatcher {
  id: number;
  projectId?: number | null;
  name: string;
  category: { id: number; name?: string };
  messageRegex?: string | null;
  traceRegex?: string | null;
}

const categories: Section = {
  key: "categories",
  label: "Defect categories",
  description: "Categories and their matchers: shared ones are attached, the project's own are recreated",
  async plan(c) {
    const actions: PlannedAction[] = [];
    const source = await list<Category>(c, `/api/rs/project/${c.source}/category`);
    const target = await targetList<Category>(c, (t) => `/api/rs/project/${t}/category`);
    const catIds = idMap(c, "category");
    for (const cat of source) {
      const shared = cat.projectId == null;
      const t = shared ? target.find((x) => x.id === cat.id) : target.find((x) => x.projectId != null && x.name === cat.name);
      if (t) {
        catIds.set(cat.id, t.id);
        actions.push({ kind: "skip", name: `category ${cat.name}`, detail: "already there" });
        continue;
      }
      actions.push({
        kind: "create",
        name: `category ${cat.name}`,
        detail: shared ? "shared category attached" : "project category",
        run: async () => {
          if (shared) {
            await c.client.post(`/api/rs/project/${tgt(c)}/category`, { categoryId: cat.id });
            catIds.set(cat.id, cat.id);
          } else {
            const created = await c.client.post<Category>("/api/rs/category", { projectId: tgt(c), name: cat.name, color: cat.color, description: cat.description });
            if (created) catIds.set(cat.id, created.id);
          }
        },
      });
    }
    const matchers = await list<CategoryMatcher>(c, `/api/rs/project/${c.source}/categorymatcher`);
    const targetMatchers = await targetList<CategoryMatcher>(c, (t) => `/api/rs/project/${t}/categorymatcher`);
    for (const m of matchers) {
      const shared = m.projectId == null;
      const exists = shared ? targetMatchers.some((x) => x.id === m.id) : targetMatchers.some((x) => x.projectId != null && x.name === m.name);
      if (exists) {
        actions.push({ kind: "skip", name: `category matcher ${m.name}`, detail: "already there" });
        continue;
      }
      actions.push({
        kind: "create",
        name: `category matcher ${m.name}`,
        detail: shared ? "shared matcher attached" : `category ${m.category.name ?? m.category.id}`,
        run: async () => {
          if (shared) await c.client.post(`/api/rs/project/${tgt(c)}/categorymatcher`, { matcherId: m.id });
          else
            await c.client.post("/api/rs/categorymatcher", {
              projectId: tgt(c),
              name: m.name,
              category: { id: catIds.get(m.category.id) ?? m.category.id },
              messageRegex: m.messageRegex,
              traceRegex: m.traceRegex,
            });
        },
      });
    }
    return actions;
  },
};

interface ProjectIntegration {
  id: number;
  name?: string;
  disabled?: boolean;
  settings?: Obj | null;
}
interface IntegrationExport {
  id: number;
  integrationId: number;
  [k: string]: unknown;
}

const EXPORT_FIELDS = ["disabled", "disableTcCreate", "disableLaunchSync", "projectKey", "tcAql", "launchAql", "syncDelaySec", "notificationEmail", "settings"];

const integrations: Section = {
  key: "integrations",
  label: "Integrations",
  description: "Integrations linked to the project with their project settings, issue and test key mappings and export settings. Project-level secrets cannot be read: the integration's default secret is used",
  async plan(c) {
    const actions: PlannedAction[] = [];
    const source = await list<ProjectIntegration>(c, `/api/rs/integration/project/${c.source}`);
    const target = await targetList<ProjectIntegration>(c, (t) => `/api/rs/integration/project/${t}`);
    const fields = (i: ProjectIntegration) => ({ settings: i.settings ?? {}, disabled: Boolean(i.disabled) });
    actions.push(
      ...planKeyed(c, {
        what: "integration",
        source,
        target,
        reload: () => targetList<ProjectIntegration>(c, (t) => `/api/rs/integration/project/${t}`),
        sourceKey: (i) => i.name ?? String(i.id),
        targetKey: (i) => i.name ?? String(i.id),
        fields,
        targetFields: fields,
        create: async (i) => {
          await c.client.post("/api/rs/integration/project", { projectId: tgt(c), integrationId: i.id, settings: i.settings ?? {} });
          if (i.disabled) await c.client.patch(`/api/rs/integration/${i.id}/project/${tgt(c)}`, { disabled: true });
        },
        update: (i) => c.client.patch(`/api/rs/integration/${i.id}/project/${tgt(c)}`, fields(i)),
      }),
    );
    if (source.length) {
      actions.push({ kind: "manual", name: "integration secrets", detail: "Allure TestOps does not give out project-level secrets: set them in the target project if the integration's default secret is not the right one" });
    }
    actions.push(
      ...(await planSchema(c, { what: "issue mapping", path: "/api/rs/issueschema", ref: "integration", refId: "integrationId", flatRef: true })),
      ...(await planSchema(c, { what: "test key mapping", path: "/api/rs/testkeyschema", ref: "integration", refId: "integrationId", flatRef: true })),
    );
    for (const i of source) {
      const exports = await list<IntegrationExport>(c, "/api/rs/integration/export", { integrationId: String(i.id), projectId: String(c.source) });
      const have = await targetList<IntegrationExport>(c, () => "/api/rs/integration/export", (t) => ({ integrationId: String(i.id), projectId: String(t) }));
      const pick = (e: IntegrationExport) => Object.fromEntries(EXPORT_FIELDS.map((k) => [k, e[k] ?? null]));
      // Unset fields are left out of writes: several of them take no null.
      const body = (e: IntegrationExport) => Object.fromEntries(Object.entries(pick(e)).filter(([, v]) => v !== null));
      exports.forEach((e, n) => {
        const t = have[n];
        const name = `export to ${i.name ?? i.id}${exports.length > 1 ? ` #${n + 1}` : ""}`;
        if (!t) actions.push({ kind: "create", name, run: () => c.client.post("/api/rs/integration/export", { ...body(e), integrationId: i.id, projectId: tgt(c) }) });
        else if (same(pick(e), pick(t))) actions.push({ kind: "skip", name, detail: "already the same" });
        else actions.push({ kind: "update", name, detail: differences(pick(e), pick(t)).join(", "), run: () => c.client.patch(`/api/rs/integration/export/${t.id}`, body(e)) });
      });
    }
    return actions;
  },
};

interface Webhook {
  id: number;
  name: string;
  endpoint: string;
  enabled?: boolean;
  settings?: Obj | null;
}

const webhooks: Section = {
  key: "webhooks",
  label: "Webhooks",
  description: "Notification webhooks with their headers and events",
  async plan(c) {
    const fields = (w: Webhook) => ({ endpoint: w.endpoint, settings: w.settings ?? null, enabled: w.enabled !== false });
    const setEnabled = async (id: number, w: Webhook) => {
      await c.client.post(`/api/rs/notification/webhook/${id}/${w.enabled === false ? "disable" : "enable"}`, {});
    };
    return planKeyed(c, {
      what: "webhook",
      source: await list<Webhook>(c, "/api/rs/notification/webhook", { projectId: String(c.source) }),
      target: await targetList<Webhook>(c, () => "/api/rs/notification/webhook", (t) => ({ projectId: String(t) })),
      reload: () => targetList<Webhook>(c, () => "/api/rs/notification/webhook", (t) => ({ projectId: String(t) })),
      sourceKey: (w) => w.name,
      targetKey: (w) => w.name,
      fields,
      targetFields: fields,
      create: async (w) => {
        const created = await c.client.post<Webhook>("/api/rs/notification/webhook", { projectId: tgt(c), name: w.name, endpoint: w.endpoint, ...(w.settings ? { settings: w.settings } : {}) });
        if (created && (created.enabled !== false) !== (w.enabled !== false)) await setEnabled(created.id, w);
      },
      update: async (w, t) => {
        await c.client.patch(`/api/rs/notification/webhook/${t.id}`, { endpoint: w.endpoint, ...(w.settings ? { settings: w.settings } : {}) });
        if ((t.enabled !== false) !== (w.enabled !== false)) await setEnabled(t.id, w);
      },
    });
  },
};

interface Tree {
  id: number;
  name: string;
  fields?: { id: number; name?: string }[];
}

const trees: Section = {
  key: "trees",
  label: "Test case trees",
  description: "Trees of test cases by custom fields",
  async plan(c) {
    const fields = (t: Tree) => ({ fields: (t.fields ?? []).map((f) => f.id) });
    return planKeyed(c, {
      what: "tree",
      source: await list<Tree>(c, "/api/rs/tree", { projectId: String(c.source) }),
      target: await targetList<Tree>(c, () => "/api/rs/tree", (t) => ({ projectId: String(t) })),
      reload: () => targetList<Tree>(c, () => "/api/rs/tree", (t) => ({ projectId: String(t) })),
      sourceKey: (t) => t.name,
      targetKey: (t) => t.name,
      fields,
      targetFields: fields,
      create: (t) => c.client.post("/api/rs/tree", { projectId: tgt(c), name: t.name, fields: (t.fields ?? []).map((f) => ({ id: f.id })) }),
      update: (t, have) => c.client.patch(`/api/rs/tree/${have.id}`, { fields: (t.fields ?? []).map((f) => ({ id: f.id })) }),
      remove: (t) => c.client.delete(`/api/rs/tree/${t.id}`),
    });
  },
};

interface Filter {
  id: number;
  name: string;
  body?: string | null;
  shared?: boolean;
  type: string;
}

const FILTER_TYPES = ["TEST_CASE", "LAUNCH", "TEST_RESULT"];

const filters: Section = {
  key: "filters",
  label: "Shared filters",
  description: "Filters of test cases, launches and test results shared with the project; private filters of other users cannot be read",
  async plan(c) {
    const actions: PlannedAction[] = [];
    for (const type of FILTER_TYPES) {
      const source = (await list<Filter>(c, "/api/rs/filter", { projectId: String(c.source), type })).filter((f) => f.shared);
      const target = await targetList<Filter>(c, () => "/api/rs/filter", (t) => ({ projectId: String(t), type }));
      const what = `${type.toLowerCase().replace("_", " ")} filter`;
      actions.push(
        ...planKeyed(c, {
          what,
          source,
          target,
          reload: () => targetList<Filter>(c, () => "/api/rs/filter", (t) => ({ projectId: String(t), type })),
          sourceKey: (f) => f.name,
          targetKey: (f) => f.name,
          fields: (f) => ({ body: f.body ?? null, shared: true }),
          targetFields: (f) => ({ body: f.body ?? null, shared: Boolean(f.shared) }),
          create: (f) => c.client.post("/api/rs/filter", { projectId: tgt(c), name: f.name, body: f.body, shared: true, base: false, type }),
          update: (f, t) => c.client.patch(`/api/rs/filter/${t.id}`, { ...(f.body ? { body: f.body } : {}), shared: true }),
        }),
      );
    }
    return actions;
  },
};

interface Dashboard {
  id: number;
  name: string;
}

const dashboards: Section = {
  key: "dashboards",
  label: "Dashboards",
  description: "Dashboards with their widgets, copied by Allure TestOps itself; an existing dashboard of the same name is left as it is",
  async plan(c) {
    const source = await list<Dashboard>(c, "/api/rs/dashboard", { projectId: String(c.source) });
    const target = new Set((await targetList<Dashboard>(c, () => "/api/rs/dashboard", (t) => ({ projectId: String(t) }))).map((d) => d.name));
    return source.map((d): PlannedAction =>
      target.has(d.name)
        ? { kind: "skip", name: `dashboard ${d.name}`, detail: "a dashboard of this name is there" }
        : { kind: "create", name: `dashboard ${d.name}`, run: () => c.client.post(`/api/rs/dashboard/${d.id}/copy`, { name: d.name, projectId: tgt(c), preserveWidgetAql: true }) },
    );
  },
};

interface GroupAccess {
  group: { id: number; name?: string };
  permissionSetId: number;
  permissionSetName?: string;
}
interface Collaborator {
  username: string;
  permissionSetId: number;
  permissionSetName?: string;
}

const access: Section = {
  key: "access",
  label: "Access",
  description: "Groups and users with their permission sets. The API token owner keeps the access they have",
  async plan(c) {
    const actions: PlannedAction[] = [];
    const groups = await list<GroupAccess>(c, `/api/rs/project/access/${c.source}/group`);
    const targetGroups = await targetList<GroupAccess>(c, (t) => `/api/rs/project/access/${t}/group`);
    for (const g of groups) {
      const t = targetGroups.find((x) => x.group.id === g.group.id);
      const name = `group ${g.group.name ?? g.group.id}`;
      if (t && t.permissionSetId === g.permissionSetId) actions.push({ kind: "skip", name, detail: "already the same" });
      else
        actions.push({
          kind: t ? "update" : "create",
          name,
          detail: g.permissionSetName,
          run: () => c.client.post(`/api/rs/project/access/${tgt(c)}/group`, { groups: [{ groupId: g.group.id, permissionSetId: g.permissionSetId }] }),
        });
    }
    const users = await list<Collaborator>(c, `/api/rs/project/access/${c.source}/collaborator`);
    const targetUsers = await targetList<Collaborator>(c, (t) => `/api/rs/project/access/${t}/collaborator`);
    for (const u of users) {
      const name = `user ${u.username}`;
      if (u.username === c.me) {
        actions.push({ kind: "skip", name, detail: "the API token owner keeps their access" });
        continue;
      }
      const t = targetUsers.find((x) => x.username === u.username);
      if (t && t.permissionSetId === u.permissionSetId) actions.push({ kind: "skip", name, detail: "already the same" });
      else
        actions.push({
          kind: t ? "update" : "create",
          name,
          detail: u.permissionSetName,
          run: () => c.client.post(`/api/rs/project/access/${tgt(c)}/collaborator`, { collaborators: [{ username: u.username, permissionSetId: u.permissionSetId }] }),
        });
    }
    return actions;
  },
};

/** In the order they are applied: later sections may refer to what earlier ones created. */
export const SECTIONS: Section[] = [settings, trees, customFields, environments, workflows, testLayers, roles, categories, integrations, webhooks, filters, dashboards, access];

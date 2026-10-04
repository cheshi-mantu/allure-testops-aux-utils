// Project configuration of the mock Allure TestOps: custom fields, schemas,
// settings, integrations, access and the rest, in memory, readable and
// writable the way the project template tool uses them.

let seq = 90_000;
const id = () => seq++;

// ---------------------------------------------------------------- shared entities

// `required`, `locked` and the default value here are global: a project gets them when it links the field.
const customFields = ["Epic", "Feature", "Story", "Component", "Suite", "Parent Suite", "Sub Suite", "Priority", "Team"].map((name) => ({
  id: id(),
  name,
  singleSelect: name === "Priority",
  required: false,
  locked: false,
  defaultCustomFieldValueId: null,
}));
const cf = (name) => customFields.find((f) => f.name === name);
/** Values: global ones are in every project, the others are linked to projects. */
const cfValues = [];
const cfValueProjects = new Set(); // `${valueId}:${projectId}`
function cfValue(fieldName, name, global = false) {
  let v = cfValues.find((x) => x.customFieldId === cf(fieldName).id && x.name === name);
  if (!v) cfValues.push((v = { id: id(), customFieldId: cf(fieldName).id, name, global }));
  return v;
}
for (const p of ["High", "Medium", "Low"]) cfValue("Priority", p, true);
cf("Priority").defaultCustomFieldValueId = cfValue("Priority", "Medium", true).id;

/** Linking a field to a project, as Allure TestOps does it. */
function linkField(projectId, fieldId) {
  if (t.cfProject.some((r) => r.projectId === projectId && r.customFieldId === fieldId)) return;
  const field = customFields.find((f) => f.id === fieldId);
  if (!field) return;
  t.cfProject.push({ projectId, customFieldId: fieldId, required: field.required, locked: false, defaultCustomFieldValueId: field.defaultCustomFieldValueId });
}

const envVarsById = new Map([
  [1, "browser"],
  [2, "stand"],
  [3, "os"],
]);
const testLayers = ["UI", "API", "Unit"].map((name) => ({ id: id(), name }));
const roles = ["Owner", "Lead", "Reviewer"].map((name) => ({ id: id(), name }));
const workflows = ["Manual default", "Automated default", "Strict review"].map((name) => ({ id: id(), name }));
const integrations = [
  { id: id(), name: "Jira Cloud", info: { type: "jira" } },
  { id: id(), name: "GitHub Actions", info: { type: "github" } },
];
const permissionSets = ["Project Owner", "Project Developer", "Project Viewer"].map((name) => ({ id: id(), name }));
const groups = ["QA team", "Developers"].map((name) => ({ id: id(), name }));

// ---------------------------------------------------------------- project-scoped tables

const t = {
  cfProject: [], // { projectId, customFieldId, required, locked, defaultCustomFieldValueId }
  cfschema: [],
  evschema: [],
  workflowschema: [],
  testlayerschema: [],
  roleschema: [],
  issueschema: [],
  testkeyschema: [],
  testcaseupdateschema: [],
  cleanerschema: [],
  projectproperty: [],
  labels: [],
  labelValues: [],
  releaseStatus: [],
  releaseWorkflow: [],
  categories: [], // projectId null = shared
  projectCategories: [], // { projectId, categoryId } for shared ones
  matchers: [],
  projectMatchers: [],
  projectIntegrations: [],
  exports: [],
  jobs: [],
  webhooks: [],
  trees: [],
  filters: [],
  dashboards: [],
  groupAccess: [],
  collaborators: [],
};

const add = (table, row) => {
  const r = { id: id(), ...row };
  t[table].push(r);
  return r;
};

/** What Allure TestOps puts into a new project. */
export function projectDefaults(projectId, owner) {
  for (const name of ["Epic", "Feature", "Story", "Component", "Suite"]) linkField(projectId, cf(name).id);
  for (const [key, name] of [["epic", "Epic"], ["feature", "Feature"], ["story", "Story"], ["suite", "Suite"]]) add("cfschema", { projectId, key, customFieldId: cf(name).id });
  add("evschema", { projectId, key: "browser", envVarId: 1 });
  add("evschema", { projectId, key: "os", envVarId: 3 });
  add("workflowschema", { projectId, type: "manual", workflowId: workflows[0].id });
  add("workflowschema", { projectId, type: "automated", workflowId: workflows[1].id });
  add("roleschema", { projectId, key: "owner", roleId: roles[0].id });
  add("trees", { projectId, name: "Features", fieldIds: [cf("Feature").id, cf("Story").id] });
  add("trees", { projectId, name: "Suites", fieldIds: [cf("Suite").id] });
  const statuses = ["DRAFT", "PUBLISHED", "REVERTED"].map((code) =>
    add("releaseStatus", { projectId, code, category: code === "DRAFT" ? "DRAFT" : "DONE", color: null, isActive: true, isSystem: false, translations: {} }),
  );
  add("releaseWorkflow", { projectId, name: "Default", isDefault: true, statusIds: statuses.map((s) => s.id) });
  t.collaborators.push({ projectId, username: owner, permissionSetId: permissionSets[0].id });
}

/** The first project gets a configuration worth copying. */
export function seedConfig(projects, owner) {
  for (const p of projects) projectDefaults(p.id, owner);
  const src = projects[0].id;
  const second = projects[1].id;
  linkField(src, cf("Priority").id);
  t.cfProject.find((r) => r.projectId === src && r.customFieldId === cf("Priority").id).required = true;
  linkField(src, cf("Team").id);
  t.cfProject.find((r) => r.projectId === src && r.customFieldId === cf("Team").id).locked = true;
  for (const team of ["Checkout squad", "Search squad"]) cfValueProjects.add(`${cfValue("Team", team).id}:${src}`);
  cfValueProjects.add(`${cfValue("Team", "Platform").id}:${second}`);
  for (const comp of ["Cart-svc", "Search-svc"]) cfValueProjects.add(`${cfValue("Component", comp).id}:${src}`);
  // The source dropped one default (its tree first: a field a tree uses stays) and has its own mappings.
  t.trees.find((r) => r.projectId === src && r.name === "Features").fieldIds = [cf("Feature").id];
  t.cfProject = t.cfProject.filter((r) => !(r.projectId === src && r.customFieldId === cf("Story").id));
  t.cfschema = t.cfschema.filter((r) => !(r.projectId === src && r.key === "story"));
  add("cfschema", { projectId: src, key: "team", customFieldId: cf("Team").id });
  add("cfschema", { projectId: src, key: "priority", customFieldId: cf("Priority").id });
  t.evschema = t.evschema.filter((r) => !(r.projectId === src && r.key === "os"));
  add("evschema", { projectId: src, key: "stand", envVarId: 2 });
  t.workflowschema.find((w) => w.projectId === src && w.type === "manual").workflowId = workflows[2].id;
  add("testlayerschema", { projectId: src, key: "ui", testLayerId: testLayers[0].id });
  add("testlayerschema", { projectId: src, key: "api", testLayerId: testLayers[1].id });
  add("roleschema", { projectId: src, key: "lead", roleId: roles[1].id });
  add("testcaseupdateschema", { projectId: src, field: "description", policy: "from_test_case" });
  add("cleanerschema", { projectId: src, status: "passed", target: "attachment", delay: 7 * 86_400_000 });
  add("projectproperty", { projectId: src, name: "owner.team", value: "QA" });
  add("labels", { projectId: src, name: "area" });
  for (const v of ["web", "mobile"]) add("labelValues", { projectId: src, name: "area", value: v });
  const rc = add("releaseStatus", { projectId: src, code: "RC", category: "DRAFT", color: "#ff9900", isActive: true, isSystem: false, translations: { en: "Release candidate" } });
  const sysIds = ["DRAFT", "PUBLISHED"].map((code) => t.releaseStatus.find((s) => s.projectId === src && s.code === code).id);
  add("releaseWorkflow", { projectId: src, name: "With RC", isDefault: false, statusIds: [sysIds[0], rc.id, sysIds[1]] });
  writeSettings(src, "launchclose", { autoCloseFilter: "true", timeoutForFinishedLaunches: 3600, timeoutForInProgressLaunches: 86_400 });
  writeSettings(src, "launchlivedoc", { filter: "tag = \"live\"" });
  writeSettings(src, "user-display-mode", { mode: "FULL_NAME" });
  const shared = add("categories", { projectId: null, name: "Product defects", color: "#ff0000", description: null });
  t.projectCategories.push({ projectId: src, categoryId: shared.id });
  const local = add("categories", { projectId: src, name: "Flaky infrastructure", color: "#888888", description: "Timeouts of the test stand" });
  add("matchers", { projectId: src, name: "Stand timeouts", categoryId: local.id, messageRegex: ".*Timeout.*", traceRegex: null });
  t.projectIntegrations.push({ projectId: src, integrationId: integrations[0].id, settings: { projectKey: "SHOP" }, disabled: false });
  t.projectIntegrations.push({ projectId: src, integrationId: integrations[1].id, settings: { repository: "example/web-shop" }, disabled: false });
  add("issueschema", { projectId: src, key: "jira", integrationId: integrations[0].id });
  add("testkeyschema", { projectId: src, key: "jira-tc", integrationId: integrations[0].id });
  add("exports", { projectId: src, integrationId: integrations[0].id, disabled: false, disableTcCreate: true, disableLaunchSync: false, projectKey: "SHOP", tcAql: "true", launchAql: null, syncDelaySec: 60, notificationEmail: null, settings: null });
  // A CI job: the template leaves jobs out.
  add("jobs", { projectId: src, integrationId: integrations[1].id, externalId: "web-tests.yml", name: "Web tests", canRun: true, parameters: [{ name: "BROWSER", value: "chrome" }] });
  add("webhooks", { projectId: src, name: "Slack", endpoint: "https://hooks.example.com/slack", enabled: true, settings: { type: "settings", headers: { "X-Token": "abc" }, subjects: [] } });
  add("trees", { projectId: src, name: "Teams", fieldIds: [cf("Team").id, cf("Component").id] });
  add("filters", { projectId: src, name: "High priority", body: JSON.stringify({ cf: cf("Priority").id }), shared: true, type: "TEST_CASE", base: false });
  add("filters", { projectId: src, name: "My drafts", body: "{}", shared: false, type: "TEST_CASE", base: false });
  add("dashboards", { projectId: src, name: "Release health" });
  t.groupAccess.push({ projectId: src, groupId: groups[0].id, permissionSetId: permissionSets[1].id });
  t.collaborators.push({ projectId: src, username: "alice", permissionSetId: permissionSets[2].id });
}

// ---------------------------------------------------------------- project settings

/**
 * Project settings are kept as project properties, the way Allure TestOps
 * does it: writing a setting creates or replaces properties of these names.
 */
const SETTINGS = {
  launchclose: [
    ["autoCloseFilter", "launch.autoclose.rql", null],
    ["timeoutForFinishedLaunches", "launch.review.timeout", 86_400],
    ["timeoutForInProgressLaunches", "launch.run.timeout", 604_800],
  ],
  launchlivedoc: [["filter", "testcase.update.launch.rql", null]],
  "user-display-mode": [["mode", "USER_DISPLAY_MODE", "USERNAME"]],
};

function readSettings(projectId, kind) {
  const out = { projectId };
  for (const [field, property, fallback] of SETTINGS[kind]) {
    const p = t.projectproperty.find((r) => r.projectId === projectId && r.name === property);
    out[field] = p ? (typeof fallback === "number" ? Number(p.value) : p.value) : fallback;
  }
  return out;
}

function writeSettings(projectId, kind, values) {
  for (const [field, property] of SETTINGS[kind]) {
    if (!(field in values)) continue;
    t.projectproperty = t.projectproperty.filter((r) => !(r.projectId === projectId && r.name === property));
    if (values[field] != null) add("projectproperty", { projectId, name: property, value: String(values[field]) });
  }
}

// ---------------------------------------------------------------- views

const ref = (list, refId) => {
  const e = list.find((x) => x.id === refId);
  return e ? { id: e.id, name: e.name } : { id: refId };
};
const views = {
  cfschema: (r) => ({ id: r.id, projectId: r.projectId, key: r.key, customField: ref(customFields, r.customFieldId) }),
  evschema: (r) => ({ id: r.id, projectId: r.projectId, key: r.key, envVar: { id: r.envVarId, name: envVarsById.get(r.envVarId) } }),
  testlayerschema: (r) => ({ id: r.id, projectId: r.projectId, key: r.key, testLayer: ref(testLayers, r.testLayerId) }),
  roleschema: (r) => ({ id: r.id, projectId: r.projectId, key: r.key, role: ref(roles, r.roleId) }),
  workflowschema: (r) => ({ id: r.id, projectId: r.projectId, type: r.type, workflow: ref(workflows, r.workflowId) }),
  issueschema: (r) => r,
  testkeyschema: (r) => ({ ...r, integrationName: ref(integrations, r.integrationId).name }),
  testcaseupdateschema: (r) => r,
  cleanerschema: (r) => r,
  projectproperty: (r) => r,
  filters: (r) => ({ ...r, editable: true }),
  jobs: (r) => ({ ...r, type: "github", url: `https://ci.example.com/${r.externalId}` }),
  webhooks: (r) => r,
  exports: (r) => r,
};

/** Simple tables: list by project, create, patch, delete. */
const crud = {
  "/api/rs/cfschema": "cfschema",
  "/api/rs/evschema": "evschema",
  "/api/rs/testlayerschema": "testlayerschema",
  "/api/rs/roleschema": "roleschema",
  "/api/rs/workflowschema": "workflowschema",
  "/api/rs/issueschema": "issueschema",
  "/api/rs/testkeyschema": "testkeyschema",
  "/api/rs/testcaseupdateschema": "testcaseupdateschema",
  "/api/rs/cleanerschema": "cleanerschema",
  "/api/rs/projectproperty": "projectproperty",
  "/api/rs/job": "jobs",
  "/api/rs/notification/webhook": "webhooks",
};
/** Tables that keep a key unique per project. */
const uniqueKey = { cfschema: "key", evschema: "key", testlayerschema: "key", roleschema: "key", issueschema: "key", testkeyschema: "key", workflowschema: "type", testcaseupdateschema: "field", projectproperty: "name" };

/**
 * Serves a configuration request; returns false when the path is not one of
 * these. `body` is the parsed JSON body of writes.
 */
export function handleConfig(req, url, body, h) {
  const { send, page } = h;
  const path = url.pathname;
  const q = (name) => url.searchParams.get(name);
  const pid = () => Number(q("projectId"));
  const method = req.method;
  let m;

  for (const [base, table] of Object.entries(crud)) {
    const v = views[table];
    if (path === base && method === "GET") return send(200, page(t[table].filter((r) => r.projectId === pid()).map(v))), true;
    if (path === base && method === "POST") {
      const key = uniqueKey[table];
      // Allure TestOps answers a duplicate with a server error.
      if (key && t[table].some((r) => r.projectId === body.projectId && r[key] === body[key])) return send(500, { message: `duplicate ${key} ${body[key]} in the project` }), true;
      // A new webhook starts enabled.
      return send(200, v(add(table, table === "webhooks" ? { enabled: true, ...body } : body))), true;
    }
    if ((m = new RegExp(`^${base.replace(/\//g, "\\/")}\\/(\\d+)(\\/(enable|disable))?$`).exec(path))) {
      const row = t[table].find((r) => r.id === Number(m[1]));
      if (!row) return send(404, { message: "Not found" }), true;
      if (m[3]) return (row.enabled = m[3] === "enable"), send(200, v(row)), true;
      if (method === "PATCH" && Object.values(body).some((x) => x === null)) return send(409, { message: "Validation error" }), true;
      if (method === "PATCH") return Object.assign(row, body), send(200, v(row)), true;
      if (method === "DELETE") return (t[table] = t[table].filter((r) => r !== row)), send(204, null), true;
      if (method === "GET") return send(200, v(row)), true;
    }
  }

  if ((m = /^\/api\/rs\/projectsettings\/(launchclose|launchlivedoc|user-display-mode)$/.exec(path))) {
    const projectId = method === "GET" ? pid() : body.projectId;
    if (method === "PATCH") writeSettings(projectId, m[1], body);
    return send(200, readSettings(projectId, m[1])), true;
  }

  if ((m = /^\/api\/rs\/project\/(\d+)\/cf(\/(\d+))?$/.exec(path))) {
    const projectId = Number(m[1]);
    if (method === "GET" && !m[2])
      return send(200, page(t.cfProject.filter((r) => r.projectId === projectId).map((r) => ({ projectId, required: r.required, locked: r.locked, defaultCustomFieldValueId: r.defaultCustomFieldValueId, customField: ref(customFields, r.customFieldId) })))), true;
    if (method === "PATCH" && m[2]) {
      const row = t.cfProject.find((r) => r.projectId === projectId && r.customFieldId === Number(m[3]));
      if (!row) return send(404, { message: "The custom field is not in the project" }), true;
      // As in Allure TestOps: no nulls, and a field is locked only with values in the project.
      if (Object.values(body).some((v) => v === null)) return send(409, { message: "Validation error" }), true;
      if (body.locked === true && !cfValues.some((v) => v.customFieldId === row.customFieldId && cfValueProjects.has(`${v.id}:${projectId}`)))
        return send(400, { message: "Cannot lock custom field which has no values" }), true;
      Object.assign(row, body);
      return send(204, null), true;
    }
  }
  if (path === "/api/rs/cfproject/add-to-project" && method === "POST") {
    const projectId = pid();
    if (!body.ids?.length) return send(400, { message: "No custom fields" }), true;
    for (const cfId of body.ids) linkField(projectId, cfId);
    return send(202, null), true;
  }
  if (path === "/api/rs/cfproject/remove" && method === "DELETE") {
    if (t.trees.some((r) => r.projectId === pid() && r.fieldIds.includes(Number(q("customFieldId"))))) return send(400, { message: "custom-field.in-use.tree" }), true;
    t.cfProject = t.cfProject.filter((r) => !(r.projectId === pid() && r.customFieldId === Number(q("customFieldId"))));
    return send(204, null), true;
  }
  if ((m = /^\/api\/rs\/project\/(\d+)\/cfv$/.exec(path))) {
    const projectId = Number(m[1]);
    if (method === "GET") {
      const fieldId = Number(q("customFieldId"));
      const globalOnly = q("global");
      const list = cfValues.filter((v) => v.customFieldId === fieldId && (v.global || cfValueProjects.has(`${v.id}:${projectId}`)) && (globalOnly === null || String(v.global) === globalOnly));
      return send(200, page(list.map((v) => ({ id: v.id, name: v.name, global: v.global, customField: ref(customFields, v.customFieldId) })))), true;
    }
    if (method === "POST") {
      const field = customFields.find((f) => f.id === body.customField?.id);
      if (!field) return send(400, { message: "Unknown custom field" }), true;
      if (cfValues.some((x) => x.customFieldId === field.id && x.name === body.name && x.global)) return send(400, { message: `Global custom field value with name ${body.name} already exists` }), true;
      const v = cfValue(field.name, body.name);
      if (cfValueProjects.has(`${v.id}:${projectId}`)) return send(400, { message: `Custom field value with name ${body.name} already exists` }), true;
      cfValueProjects.add(`${v.id}:${projectId}`);
      return send(200, { id: v.id, name: v.name, global: false, customField: ref(customFields, v.customFieldId) }), true;
    }
  }

  if ((m = /^\/api\/rs\/project\/(\d+)\/label(\/value)?$/.exec(path))) {
    const projectId = Number(m[1]);
    if (!m[2] && method === "GET") return send(200, t.labels.filter((l) => l.projectId === projectId).map(({ projectId: p, name }) => ({ projectId: p, name }))), true;
    if (!m[2] && method === "POST") return send(200, add("labels", { projectId, name: body.name })), true;
    if (m[2] && method === "GET") return send(200, t.labelValues.filter((l) => l.projectId === projectId && l.name === q("name")).map(({ projectId: p, name, value }) => ({ projectId: p, name, value }))), true;
    if (m[2] && method === "POST") return send(200, add("labelValues", { projectId, name: body.name, value: body.value })), true;
  }

  const statusView = (s) => ({ id: s.id, projectId: s.projectId, code: s.code, category: s.category, color: s.color, isActive: s.isActive, isSystem: s.isSystem, translations: s.translations });
  if (path === "/api/rs/project/release-status") {
    if (method === "GET") return send(200, page(t.releaseStatus.filter((s) => s.projectId === pid() && (q("activeOnly") === "false" || s.isActive)).map(statusView))), true;
    if (method === "POST") return send(200, statusView(add("releaseStatus", { isSystem: false, isActive: true, ...body }))), true;
  }
  if ((m = /^\/api\/rs\/project\/release-status\/(\d+)$/.exec(path))) {
    const s = t.releaseStatus.find((x) => x.id === Number(m[1]));
    if (!s) return send(404, { message: "Not found" }), true;
    if (method === "PATCH") return Object.assign(s, body), send(200, statusView(s)), true;
    if (method === "DELETE") {
      if (s.isSystem) return send(400, { message: "A system status cannot be deleted" }), true;
      t.releaseStatus = t.releaseStatus.filter((x) => x !== s);
      return send(204, null), true;
    }
  }
  const workflowView = (w) => ({ id: w.id, projectId: w.projectId, name: w.name, isDefault: w.isDefault, statuses: w.statusIds.map((sid) => ({ id: sid, code: t.releaseStatus.find((s) => s.id === sid)?.code })) });
  if (path === "/api/rs/project/release-workflow") {
    if (method === "GET") return send(200, page(t.releaseWorkflow.filter((w) => w.projectId === pid()).map(workflowView))), true;
    if (method === "POST") return send(200, workflowView(add("releaseWorkflow", { projectId: body.projectId, name: body.name, isDefault: false, statusIds: body.statuses ?? [] }))), true;
  }
  if ((m = /^\/api\/rs\/project\/release-workflow\/(\d+)(\/default)?$/.exec(path))) {
    const w = t.releaseWorkflow.find((x) => x.id === Number(m[1]));
    if (!w) return send(404, { message: "Not found" }), true;
    if (m[2]) {
      for (const x of t.releaseWorkflow) if (x.projectId === w.projectId) x.isDefault = x === w;
      return send(204, null), true;
    }
    if (method === "PATCH") return (w.name = body.name ?? w.name), body.statuses && (w.statusIds = body.statuses), send(200, workflowView(w)), true;
    if (method === "DELETE") {
      if (w.isDefault) return send(400, { message: "The default workflow cannot be deleted" }), true;
      t.releaseWorkflow = t.releaseWorkflow.filter((x) => x !== w);
      return send(204, null), true;
    }
  }

  const categoryView = (c) => ({ id: c.id, projectId: c.projectId, name: c.name, color: c.color, description: c.description });
  if ((m = /^\/api\/rs\/project\/(\d+)\/category$/.exec(path))) {
    const projectId = Number(m[1]);
    if (method === "GET")
      return send(200, page(t.categories.filter((c) => c.projectId === projectId || (c.projectId === null && t.projectCategories.some((x) => x.projectId === projectId && x.categoryId === c.id))).map(categoryView))), true;
    if (method === "POST") return t.projectCategories.push({ projectId, categoryId: body.categoryId }), send(200, null), true;
  }
  if (path === "/api/rs/category" && method === "POST") return send(200, categoryView(add("categories", { projectId: body.projectId ?? null, name: body.name, color: body.color, description: body.description ?? null }))), true;
  const matcherView = (x) => ({ id: x.id, projectId: x.projectId, name: x.name, category: ref(t.categories, x.categoryId), messageRegex: x.messageRegex, traceRegex: x.traceRegex });
  if ((m = /^\/api\/rs\/project\/(\d+)\/categorymatcher$/.exec(path))) {
    const projectId = Number(m[1]);
    if (method === "GET")
      return send(200, page(t.matchers.filter((x) => x.projectId === projectId || (x.projectId === null && t.projectMatchers.some((p) => p.projectId === projectId && p.matcherId === x.id))).map(matcherView))), true;
    if (method === "POST") return t.projectMatchers.push({ projectId, matcherId: body.matcherId }), send(200, null), true;
  }
  if (path === "/api/rs/categorymatcher" && method === "POST") {
    const cat = t.categories.find((c) => c.id === body.category?.id);
    const inProject = cat && (cat.projectId === body.projectId || t.projectCategories.some((x) => x.projectId === body.projectId && x.categoryId === cat.id));
    if (body.projectId != null && !inProject) return send(409, { message: "Validation error" }), true;
    return send(200, matcherView(add("matchers", { projectId: body.projectId ?? null, name: body.name, categoryId: body.category?.id, messageRegex: body.messageRegex ?? null, traceRegex: body.traceRegex ?? null }))), true;
  }

  const integrationView = (r) => ({ id: r.integrationId, projectId: r.projectId, name: ref(integrations, r.integrationId).name, info: integrations.find((i) => i.id === r.integrationId)?.info, disabled: r.disabled, settings: r.settings });
  if ((m = /^\/api\/rs\/integration\/project\/(\d+)$/.exec(path)) && method === "GET") return send(200, page(t.projectIntegrations.filter((r) => r.projectId === Number(m[1])).map(integrationView))), true;
  if (path === "/api/rs/integration/project" && method === "POST") {
    if (t.projectIntegrations.some((r) => r.projectId === body.projectId && r.integrationId === body.integrationId)) return send(409, { message: "Already linked" }), true;
    const row = { projectId: body.projectId, integrationId: body.integrationId, settings: body.settings ?? {}, disabled: false };
    t.projectIntegrations.push(row);
    return send(200, integrationView(row)), true;
  }
  if ((m = /^\/api\/rs\/integration\/(\d+)\/project\/(\d+)$/.exec(path)) && method === "PATCH") {
    const row = t.projectIntegrations.find((r) => r.integrationId === Number(m[1]) && r.projectId === Number(m[2]));
    if (!row) return send(404, { message: "Not linked" }), true;
    Object.assign(row, body);
    return send(200, integrationView(row)), true;
  }
  const exportNulls = (b) => ["disabled", "disableTcCreate", "disableLaunchSync", "syncDelaySec"].some((k) => k in b && b[k] === null);
  if (path === "/api/rs/integration/export") {
    if (method !== "GET" && exportNulls(body)) return send(500, { message: "null value in a not null column" }), true;
    if (method !== "GET" && "projectKey" in body && !body.projectKey) return send(409, { message: "Validation error" }), true;
    if (method === "GET") return send(200, page(t.exports.filter((r) => r.projectId === pid() && r.integrationId === Number(q("integrationId"))))), true;
    // Fields left out get the server's defaults.
    if (method === "POST")
      return send(200, add("exports", { disabled: false, disableTcCreate: false, disableLaunchSync: false, projectKey: null, tcAql: null, launchAql: null, syncDelaySec: 0, notificationEmail: null, settings: null, ...body })), true;
  }
  if ((m = /^\/api\/rs\/integration\/export\/(\d+)$/.exec(path)) && method === "PATCH") {
    if (exportNulls(body)) return send(500, { message: "null value in a not null column" }), true;
    const row = t.exports.find((r) => r.id === Number(m[1]));
    return row ? (Object.assign(row, body), send(200, row), true) : (send(404, { message: "Not found" }), true);
  }

  const treeView = (r) => ({ id: r.id, projectId: r.projectId, name: r.name, fields: r.fieldIds.map((f) => ref(customFields, f)) });
  if (path === "/api/rs/tree") {
    if (method === "GET") return send(200, page(t.trees.filter((r) => r.projectId === pid()).map(treeView))), true;
    if (method === "POST") return send(200, treeView(add("trees", { projectId: body.projectId, name: body.name, fieldIds: (body.fields ?? []).map((f) => f.id) }))), true;
  }
  if ((m = /^\/api\/rs\/tree\/(\d+)$/.exec(path))) {
    const row = t.trees.find((r) => r.id === Number(m[1]));
    if (!row) return send(404, { message: "Not found" }), true;
    if (method === "PATCH") return body.name && (row.name = body.name), body.fields && (row.fieldIds = body.fields.map((f) => f.id)), send(200, treeView(row)), true;
    if (method === "DELETE") return (t.trees = t.trees.filter((r) => r !== row)), send(204, null), true;
  }

  if (path === "/api/rs/filter") {
    if (method === "GET") return send(200, page(t.filters.filter((r) => r.projectId === pid() && r.type === (q("type") ?? "TEST_CASE")).map(views.filters))), true;
    if (method === "POST") return send(200, views.filters(add("filters", { type: "TEST_CASE", ...body }))), true;
  }
  if ((m = /^\/api\/rs\/filter\/(\d+)$/.exec(path)) && method === "PATCH") {
    const row = t.filters.find((r) => r.id === Number(m[1]));
    return row ? (Object.assign(row, body), send(200, views.filters(row)), true) : (send(404, { message: "Not found" }), true);
  }

  if (path === "/api/rs/dashboard" && method === "GET") return send(200, page(t.dashboards.filter((r) => r.projectId === pid()))), true;
  if ((m = /^\/api\/rs\/dashboard\/(\d+)\/copy$/.exec(path)) && method === "POST") {
    const d = t.dashboards.find((r) => r.id === Number(m[1]));
    return d ? (send(200, add("dashboards", { projectId: body.projectId, name: body.name ?? d.name })), true) : (send(404, { message: "Not found" }), true);
  }

  const setName = (sid) => permissionSets.find((s) => s.id === sid)?.name;
  if ((m = /^\/api\/rs\/project\/access\/(\d+)\/(group|collaborator)$/.exec(path))) {
    const projectId = Number(m[1]);
    if (m[2] === "group") {
      if (method === "GET") return send(200, page(t.groupAccess.filter((r) => r.projectId === projectId).map((r) => ({ group: ref(groups, r.groupId), permissionSetId: r.permissionSetId, permissionSetName: setName(r.permissionSetId) })))), true;
      for (const g of body.groups ?? []) {
        t.groupAccess = t.groupAccess.filter((r) => !(r.projectId === projectId && r.groupId === g.groupId));
        t.groupAccess.push({ projectId, groupId: g.groupId, permissionSetId: g.permissionSetId });
      }
      return send(200, null), true;
    }
    if (method === "GET") return send(200, page(t.collaborators.filter((r) => r.projectId === projectId).map((r) => ({ username: r.username, permissionSetId: r.permissionSetId, permissionSetName: setName(r.permissionSetId) })))), true;
    for (const u of body.collaborators ?? []) {
      t.collaborators = t.collaborators.filter((r) => !(r.projectId === projectId && r.username === u.username));
      t.collaborators.push({ projectId, username: u.username, permissionSetId: u.permissionSetId });
    }
    return send(200, null), true;
  }

  if (path === "/mock/config") return send(200, t), true;
  return false;
}

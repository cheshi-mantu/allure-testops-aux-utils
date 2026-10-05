// Test cases of the mock Allure TestOps with their change log, for the
// rollback tool: overview, change log, search, PATCH and the lookups by id.
// Every change is logged the way Allure TestOps logs it.

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = Date.now();
/** Points in time of the seeded history; the tests roll back to `ROLLBACK_TO`. */
export const T = { created: now - 10 * DAY, before: now - 5 * DAY, after: now - DAY };
export const ROLLBACK_TO = now - 3 * DAY;

const statuses = [
  { id: 1, name: "Draft" },
  { id: 2, name: "Active" },
  { id: 3, name: "Outdated" },
];
const workflows = [{ id: 11, name: "Manual", statuses }];
const layers = [
  { id: 21, name: "UI" },
  { id: 22, name: "API" },
];
const tags = ["smoke", "regression", "nightly", "legacy"].map((name, i) => ({ id: 31 + i, name }));
const priority = { id: 401, name: "Priority" };
const component = { id: 402, name: "Component" };
const cfValues = [
  { id: 41, name: "High", customField: priority },
  { id: 42, name: "Low", customField: priority },
  { id: 43, name: "Checkout", customField: component },
];
const owner = { id: 61, name: "Owner" };
const lead = { id: 62, name: "Lead" };
const members = [
  { id: 51, name: "alice", role: owner },
  { id: 52, name: "bob", role: owner },
  { id: 53, name: "carol", role: lead },
];
const issues = [
  { id: 71, name: "SHOP-1", integrationId: 1 },
  { id: 72, name: "SHOP-2", integrationId: 1 },
];

const SCALAR = ["name", "fullName", "description", "precondition", "expectedResult", "automated", "statusId", "workflowId", "testLayerId"];
const LIST_TYPE = { tags: "test_case_test_tag", customFields: "test_case_custom_field", members: "test_case_members", issues: "test_case_issue" };

const testCases = [];
const audit = [];
let auditSeq = 1;

function log(tc, user, ts, actionType, data) {
  audit.push({ id: auditSeq++, testCaseId: tc.id, timestamp: ts, username: user, actionType, data });
}

/**
 * Changes a test case and logs it: scalars as one update, each list as
 * removals and additions. Some changes of Allure TestOps, custom fields among
 * them, are logged without moving the modification date: `touch: false`.
 */
function change(tc, user, ts, values, touch = true) {
  const before = audit.length;
  const diff = {};
  for (const k of SCALAR) {
    if (!(k in values) || values[k] === tc[k]) continue;
    diff[k] = { oldValue: tc[k], newValue: values[k] };
    tc[k] = values[k];
  }
  if (Object.keys(diff).length) log(tc, user, ts, "update", [{ type: "test_case", diff }]);
  for (const [list, type] of Object.entries(LIST_TYPE)) {
    if (!(list in values)) continue;
    const next = [...new Set(values[list])];
    const removed = tc[list].filter((id) => !next.includes(id));
    const added = next.filter((id) => !tc[list].includes(id));
    if (removed.length) log(tc, user, ts, "delete", [{ type, diff: { ids: { oldValue: removed, newValue: null } } }]);
    if (added.length) log(tc, user, ts, "insert", [{ type, diff: { ids: { oldValue: null, newValue: added } } }]);
    tc[list] = next;
  }
  if (touch && audit.length > before) tc.lastModifiedDate = Math.max(tc.lastModifiedDate, ts);
}

function create(projectId, id, user, ts, values) {
  const tc = {
    id,
    projectId,
    name: values.name,
    fullName: null,
    description: null,
    precondition: null,
    expectedResult: null,
    automated: false,
    statusId: 1,
    workflowId: 11,
    testLayerId: null,
    tags: [],
    customFields: [],
    members: [],
    issues: [],
    createdDate: ts,
    lastModifiedDate: ts,
  };
  testCases.push(tc);
  const diff = Object.fromEntries(SCALAR.map((k) => [k, { oldValue: null, newValue: tc[k] }]));
  log(tc, user, ts, "insert", [{ type: "test_case", diff }]);
  const rest = { ...values };
  delete rest.name;
  change(tc, user, ts, rest);
  return tc;
}

/** Seeds the history of project 1: changes before and after `ROLLBACK_TO`. */
export function seedTestCases(projectId) {
  const login = create(projectId, 9001, "alice", T.created, { name: "Login with a valid password", tags: [31, 32], customFields: [41], members: [51] });
  change(login, "alice", T.before, { description: "Enter the user name and the password" });
  change(login, "bob", T.after, { name: "Login works", description: "Rewritten by an import", statusId: 2, tags: [32, 34], customFields: [42] });

  const checkout = create(projectId, 9002, "alice", T.created, { name: "Checkout total", testLayerId: 21, members: [51], issues: [71] });
  change(checkout, "alice", T.after, { testLayerId: 22, members: [51, 53], issues: [71, 72], precondition: "The cart is full" });

  const search = create(projectId, 9003, "alice", T.created, { name: "Search by name" });
  change(search, "bob", T.before, { tags: [33] });

  create(projectId, 9004, "bob", T.after, { name: "New reporting" });

  const refund = create(projectId, 9005, "alice", T.created, { name: "Payment refund", customFields: [43, 44] });
  change(refund, "bob", T.after, { automated: true, customFields: [43] });

  const profile = create(projectId, 9006, "alice", T.created, { name: "Profile edit" });
  change(profile, "bob", T.after, { name: "Profile edit (draft)" });
  change(profile, "bob", T.after + HOUR, { name: "Profile edit" });

  const issue = create(projectId, 9007, "alice", T.created, { name: "Closing an issue", customFields: [41] });
  change(issue, "bob", T.after, { customFields: [42] }, false);
}

const byId = (list, id) => list.find((x) => x.id === id);

function overview(tc) {
  return {
    id: tc.id,
    projectId: tc.projectId,
    name: tc.name,
    fullName: tc.fullName,
    description: tc.description,
    precondition: tc.precondition,
    expectedResult: tc.expectedResult,
    automated: tc.automated,
    status: byId(statuses, tc.statusId) ?? null,
    workflow: byId(workflows, tc.workflowId) ? { id: tc.workflowId, name: byId(workflows, tc.workflowId).name } : null,
    layer: byId(layers, tc.testLayerId) ?? null,
    tags: tc.tags.map((id) => byId(tags, id)).filter(Boolean),
    customFields: tc.customFields.map((id) => byId(cfValues, id)).filter(Boolean),
    members: tc.members.map((id) => byId(members, id)).filter(Boolean),
    issues: tc.issues.map((id) => byId(issues, id)).filter(Boolean),
    lastModifiedDate: tc.lastModifiedDate,
  };
}

/** The AQL the mock understands: `true`, `tag = "x"`, `name ~= "x"`, `id in [..]`, optionally `(…) and lastModifiedDate > N`. */
function matcher(rql) {
  let after = null;
  let m = /^\((.*)\) and lastModifiedDate > (\d+)$/.exec(rql.trim());
  if (m) {
    rql = m[1];
    after = Number(m[2]);
  }
  rql = rql.trim();
  let test;
  if (rql === "true") test = () => true;
  else if ((m = /^tag = "([^"]*)"$/.exec(rql))) test = (tc) => tc.tags.some((id) => byId(tags, id)?.name === m[1]);
  else if ((m = /^name ~= "([^"]*)"$/.exec(rql))) test = (tc) => tc.name.toLowerCase().includes(m[1].toLowerCase());
  else if ((m = /^id in \[([\d,\s]*)\]$/.exec(rql))) {
    const ids = m[1].split(",").map(Number);
    test = (tc) => ids.includes(tc.id);
  } else return null;
  return (tc) => test(tc) && (after === null || tc.lastModifiedDate > after);
}

function valid(list, ids) {
  return (ids ?? []).every((x) => byId(list, x.id));
}

export function handleTestCases(req, url, body, h) {
  const { send, page } = h;
  const path = url.pathname;
  const q = (name) => url.searchParams.get(name);
  const method = req.method;
  let m;

  if (method === "GET" && path === "/api/rs/status") return send(200, statuses), true;
  if (method === "GET" && path === "/api/rs/workflow") return send(200, page(workflows)), true;
  if (method === "GET" && path === "/api/rs/testlayer") return send(200, page(layers)), true;
  if (method === "GET" && (m = /^\/api\/rs\/(tag|cfv|member|issue)\/(\d+)$/.exec(path))) {
    const list = { tag: tags, cfv: cfValues, member: members, issue: issues }[m[1]];
    const x = byId(list, Number(m[2]));
    return x ? send(200, x) : send(404, { message: "Not found" }), true;
  }

  if (method === "GET" && (path === "/api/rs/testcase/__search" || path === "/api/rs/testcase/query/validate")) {
    const rql = q("rql") ?? "";
    // Custom field queries are answered with the project configuration.
    if (rql.startsWith("cf[")) return false;
    const match = matcher(rql);
    const projectId = Number(q("projectId"));
    const found = match ? testCases.filter((tc) => tc.projectId === projectId && match(tc)) : [];
    if (path.endsWith("validate")) return send(200, match ? { valid: true, count: found.length } : { valid: false }), true;
    if (!match) return send(400, { message: "Invalid AQL" }), true;
    return send(200, page(found.map((tc) => ({ id: tc.id, name: tc.name, lastModifiedDate: tc.lastModifiedDate })))), true;
  }

  if (method === "GET" && path === "/api/rs/testcase/audit") {
    const entries = audit
      .filter((e) => e.testCaseId === Number(q("testCaseId")))
      .sort((a, b) => b.timestamp - a.timestamp || b.id - a.id)
      .map(({ testCaseId, ...e }) => e);
    return send(200, page(entries)), true;
  }

  if ((m = /^\/api\/rs\/testcase\/(\d+)(\/overview|\/issue)?$/.exec(path))) {
    const tc = byId(testCases, Number(m[1]));
    if (!tc) return false;
    if (method === "GET" && m[2] === "/overview") return send(200, overview(tc)), true;
    if (method === "POST" && m[2] === "/issue") {
      if (!valid(issues, body)) return send(400, { message: "Unknown issue" }), true;
      change(tc, "mock", Date.now(), { issues: body.map((x) => x.id) });
      return send(200, overview(tc).issues), true;
    }
    if (method === "PATCH" && !m[2] && q("v2") !== null) {
      if ("name" in body && !String(body.name ?? "").trim()) return send(400, { message: "name must not be blank" }), true;
      if (("statusId" in body && body.statusId === null) || ("workflowId" in body && body.workflowId === null)) return send(400, { message: "Validation error" }), true;
      if ("statusId" in body && !byId(statuses, body.statusId)) return send(400, { message: "Unknown status" }), true;
      if (!valid(tags, body.tags) || !valid(members, body.members) || !valid(cfValues, body.customFields)) return send(400, { message: "Unknown entity" }), true;
      const values = {};
      for (const k of SCALAR) if (k in body) values[k] = body[k];
      for (const k of ["tags", "customFields", "members"]) if (k in body) values[k] = body[k].map((x) => x.id);
      change(tc, "mock", Date.now(), values);
      return send(200, overview(tc)), true;
    }
  }
  return false;
}

export function testCasesDump() {
  return { testCases, audit };
}

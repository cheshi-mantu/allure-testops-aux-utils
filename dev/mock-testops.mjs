// Tiny stand-in for Allure TestOps to try the tools without a real instance:
//   node dev/mock-testops.mjs   → http://localhost:9090, API token "mock-token"
//
// MOCK_FAILURE_RATE=0.1 makes that share of reads fail with a 500 or an HTML
// page instead of JSON, the way an overloaded server sometimes answers.
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 9090);
const TOKEN = process.env.MOCK_TOKEN ?? "mock-token";
const JWT = "mock-jwt";
const FAILURE_RATE = Number(process.env.MOCK_FAILURE_RATE ?? 0);

const DAY = 86_400_000;
const now = Date.now();
const users = ["alice", "bob", "carol"];
const statuses = ["passed", "passed", "passed", "failed", "broken", "skipped", "passed", "unknown"];
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// Environment variables and their values, shared by all projects as in Allure TestOps.
const envVars = [
  { id: 1, name: "browser", values: ["chrome", "firefox", "safari"] },
  { id: 2, name: "stand", values: ["stage", "prod"] },
  { id: 3, name: "os", values: ["linux", "macos"] },
];
const envValueIds = new Map();
for (const v of envVars) v.values.forEach((value, k) => envValueIds.set(`${v.id}:${value}`, v.id * 100 + k));
const envValue = (varId, value) => ({ id: envValueIds.get(`${varId}:${value}`), name: value, variable: { id: varId, name: envVars.find((v) => v.id === varId).name } });

const kinds = ["nightly", "smoke", "release", "regress"];
let tagSeq = 1;
const tagIds = new Map();
const launchTag = (name) => {
  if (!tagIds.has(name)) tagIds.set(name, tagSeq++);
  return { id: tagIds.get(name), name };
};

const projects = [
  { id: 1, name: "Web Shop" },
  { id: 2, name: "Mobile App" },
];

let seq = 1000;
const launches = [];
const results = new Map(); // launchId → result[]
const details = new Map(); // resultId → { scenario, fixtures, cfv, members, issues }
const attachments = new Map(); // "result:id" | "fixture:id" → { contentType, body }

function attachment(owner, name, contentType, body) {
  const id = seq++;
  attachments.set(`${owner}:${id}`, { contentType, body });
  return { id, name, contentType, contentLength: body.length, missed: false };
}

function attachmentStep(owner, name, contentType, body, start) {
  const row = attachment(owner, name, contentType, body);
  return { type: "attachment", attachmentId: row.id, attachment: row, start, stop: start, duration: 0 };
}

function cf(id, name, ...values) {
  return { customField: { id, name }, values: values.map((v, i) => ({ id: id * 100 + i, name: v })) };
}

// Twelve small launches per project; MOCK_LARGE_LAUNCH=20000 adds a big one to "Mobile App".
const specs = projects.flatMap((p) => Array.from({ length: 12 }, (_, l) => ({ p, l, count: 40, name: null })));
const LARGE_LAUNCH = Number(process.env.MOCK_LARGE_LAUNCH ?? 0);
if (LARGE_LAUNCH > 0) specs.push({ p: projects[1], l: 12, count: LARGE_LAUNCH, name: `${projects[1].name} load #1` });

const jobRuns = new Map(); // launchId → job runs
const resultEnv = new Map(); // resultId → environment values

for (const { p, l, count, name } of specs) {
  const launchId = seq++;
  // The last launch of each project uses behaviours instead of suites.
  const behaviours = l % 3 === 2;
  const created = now - (l * 2 + 1) * DAY;
  launches.push({
    id: launchId,
    name: name ?? `${p.name} ${kinds[l % 4]} #${100 - l}`,
    projectId: p.id,
    closed: l > 0,
    createdBy: users[l % 3],
    createdDate: created,
    tags: [kinds[l % 4], ...(l % 3 === 0 ? ["ui"] : ["api"]), ...(l % 5 === 0 ? ["release-candidate"] : [])].map(launchTag),
    // Some launches run in two browsers; some have no OS.
    env: [
      envValue(1, ["chrome", "firefox", "safari"][l % 3]),
      ...(l % 4 === 0 && l % 3 !== 1 ? [envValue(1, "firefox")] : []),
      envValue(2, l % 2 ? "prod" : "stage"),
      ...(l % 5 === 4 ? [] : [envValue(3, l % 2 ? "macos" : "linux")]),
    ],
  });
  const launch = launches.at(-1);
  if (l % 3 === 0) {
    launch.links = [{ name: "CI pipeline", url: `https://ci.example.com/pipelines/${launchId}`, type: "link" }];
    launch.issues = [{ id: 700 + l, name: `SHOP-${700 + l}`, url: `https://jira.example.com/browse/SHOP-${700 + l}`, summary: "Release checklist" }];
  }
  // Even launches come from two CI job runs, one per browser.
  const runs =
    l % 2 === 0
      ? ["chrome", "firefox"].map((browser, k) => ({
          id: launchId * 10 + k,
          name: `#${200 + l * 2 + k}`,
          url: `https://ci.example.com/job/web-tests-${browser}/${200 + l * 2 + k}`,
          stage: "DONE",
          status: k === 0 ? "SUCCESS" : "FAILURE",
          job: { id: 50 + k, name: `web-tests-${browser}`, url: `https://ci.example.com/job/web-tests-${browser}` },
          launchId,
          browser,
        }))
      : [];
  jobRuns.set(launchId, runs.map(({ browser: _browser, ...run }) => run));
  const list = [];
  for (let i = 0; i < count; i++) {
    const id = seq++;
    const start = created + i * 7000;
    const status = i === 39 ? null : statuses[(i + l) % statuses.length];
    const feature = ["Cart", "Checkout", "Login", "Search"][i % 4];
    const testCaseId = p.id * 1_000_000 + i;
    const run = runs.length ? runs[i % runs.length] : null;
    const failed = status === "failed" || status === "broken";
    const result = {
      id,
      projectId: p.id,
      launchId,
      testCaseId,
      historyKey: `hk-${p.id}-${i}`,
      name: `${feature}: scenario ${i}`,
      fullName: `com.example.${feature.toLowerCase()}.Scenario${i}Test`,
      description: i % 3 === 0 ? `Checks **${feature.toLowerCase()}** behaviour, case ${i}.` : null,
      descriptionHtml: i % 3 === 0 ? `<p>Checks <strong>${feature.toLowerCase()}</strong> behaviour, case ${i}.</p>` : null,
      precondition: i % 5 === 0 ? "User is logged in" : null,
      preconditionHtml: i % 5 === 0 ? "<p>User is logged in</p>" : null,
      expectedResult: i % 5 === 0 ? "The page opens" : null,
      expectedResultHtml: i % 5 === 0 ? "<p>The page opens</p>" : null,
      jobRun: run ? { id: run.id, name: run.name, url: run.url } : null,
      start,
      stop: start + 1500 + i * 30,
      duration: 1500 + i * 30,
      status,
      layer: { id: 1, name: i % 2 ? "UI" : "API" },
      message: failed ? `Expected: 200\nActual: ${status === "failed" ? 500 : 404}` : null,
      trace: failed ? `java.lang.AssertionError: boom\n\tat com.example.${feature}Test.run(${feature}Test.java:${10 + i})` : null,
      // Every tenth test is manual; half of them have an assignee.
      manual: i % 10 === 7,
      assignee: i % 20 === 7 ? users[i % 3] : null,
      assigneeUser: i % 20 === 7 ? { username: users[i % 3], firstName: users[i % 3][0].toUpperCase() + users[i % 3].slice(1), lastName: "Tester" } : null,
      testedBy: i % 10 === 7 && status ? users[(i + 1) % 3] : null,
      testedByUser: i % 10 === 7 && status ? { username: users[(i + 1) % 3], firstName: null, lastName: null } : null,
      hostId: `agent-${i % 2}`,
      threadId: `worker-${i % 4}`,
      flaky: i % 11 === 3,
      muted: i % 13 === 4,
      known: false,
      hidden: false,
      parameters: i % 4 === 0 ? [{ name: "browser", value: "chrome", hidden: false, excluded: false }, { name: "secret", value: "s3cr3t", hidden: true, excluded: false }] : [],
      tags: [{ id: 1, name: i % 2 ? "ui" : "api" }, ...(i % 6 === 0 ? [{ id: 2, name: "smoke" }] : [])],
      links: i % 7 === 0 ? [{ name: "Spec", url: `https://wiki.example.com/spec/${i}`, type: "link" }] : [],
    };
    list.push(result);
    resultEnv.set(id, run ? [envValue(1, run.browser), ...launch.env.filter((v) => v.variable.id !== 1)] : launch.env);

    const inner = [
      { type: "body", body: `Fill the ${feature.toLowerCase()} form`, status: "passed", start: start + 10, stop: start + 200, duration: 190, parameters: [{ name: "field", value: "email" }], steps: [] },
      attachmentStep("result", "request.json", "application/json", Buffer.from(JSON.stringify({ case: i, feature }, null, 2)), start + 220),
    ];
    details.set(id, {
      scenario: {
        steps: [
          { type: "body", body: `Open ${feature} page`, status: "passed", start, stop: start + 300, duration: 300, steps: inner, expectedResultSteps: i % 5 === 0 ? [{ type: "expected_body", body: "Page is shown", status: "passed" }] : [] },
          {
            type: "body",
            body: "Check the result",
            status: status ?? "unknown",
            start: start + 300,
            stop: start + 1400,
            duration: 1100,
            message: failed ? result.message : null,
            trace: failed ? result.trace : null,
            steps: [],
          },
          attachmentStep("result", "log.txt", "text/plain", Buffer.from(`log of ${result.name}\nline 2\n`), start + 1400),
          ...(failed ? [attachmentStep("result", "screenshot.png", "image/png", PNG, start + 1450)] : []),
        ],
      },
      fixtures:
        i % 3 === 0
          ? [
              { id: seq++, type: "before", name: "start browser", start: start - 500, stop: start, status: "passed", scenario: { steps: [attachmentStep("fixture", "browser.log", "text/plain", Buffer.from("browser started\n"), start - 10)] } },
              { id: seq++, type: "after", name: "close browser", start: start + 1600, stop: start + 1700, status: "passed", scenario: { steps: [] } },
            ]
          : [],
      cfv: behaviours
        ? [cf(1, "Epic", "Shop"), cf(2, "Feature", feature), cf(3, "Story", `${feature} story ${i % 3}`)]
        : [cf(4, "Parent Suite", p.name), cf(5, "Suite", feature), cf(6, "Sub Suite", i % 2 ? "UI" : "API"), cf(7, "Component", `${feature}-svc`)],
      members: [{ id: 1, name: users[i % 3], role: { id: 1, name: "Owner" } }, { id: 2, name: users[(i + 1) % 3], role: { id: 2, name: "Lead" } }],
      issues: i % 9 === 0 ? [{ id: 900 + i, name: `SHOP-${100 + i}`, url: `https://jira.example.com/browse/SHOP-${100 + i}` }] : [],
    });

    // Every eighth test was retried: the earlier attempt is a hidden result.
    if (i % 8 === 5) {
      const retryId = seq++;
      list.push({
        ...result,
        id: retryId,
        start: start - 3000,
        stop: start - 1500,
        duration: 1500,
        status: "failed",
        message: "Flaky timeout",
        trace: "java.util.concurrent.TimeoutException",
        hidden: true,
      });
      details.set(retryId, { scenario: { steps: [] }, fixtures: [], cfv: details.get(id).cfv, members: [], issues: [] });
    }
  }
  results.set(launchId, list);
}

// A small AQL interpreter for launches: and, or, not, brackets, =, !=, ~=, >,
// >=, <, <=, in, null; attributes id, name, createdBy, createdDate, closed,
// tag and ev["variable"].
function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:("(?:[^"\\]|\\.)*")|(-?\d+)|(!=|~=|>=|<=|=|>|<|\(|\)|\[|\]|,)|([A-Za-z_][A-Za-z0-9_]*))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error(`Unexpected input at ${pos}`);
    pos = re.lastIndex;
    if (m[1]) tokens.push({ t: "str", v: m[1].slice(1, -1).replace(/\\(.)/g, "$1") });
    else if (m[2]) tokens.push({ t: "num", v: Number(m[2]) });
    else if (m[3]) tokens.push({ t: m[3] });
    else {
      const w = m[4].toLowerCase();
      if (["and", "or", "not", "in", "null", "empty", "true", "false", "is"].includes(w)) tokens.push({ t: w === "empty" ? "null" : w === "is" ? "=" : w });
      else tokens.push({ t: "id", v: m[4] });
    }
  }
  return tokens;
}

function parseAql(src) {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i]?.t;
  const take = (t) => {
    if (peek() !== t) throw new Error(`Expected ${t} at token ${i}`);
    return tokens[i++];
  };
  const value = () => {
    const tok = tokens[i++];
    if (!tok) throw new Error("Value expected");
    if (tok.t === "str" || tok.t === "num") return tok.v;
    if (tok.t === "null") return null;
    if (tok.t === "true" || tok.t === "false") return tok.t === "true";
    throw new Error(`Value expected at token ${i - 1}`);
  };
  const condition = () => {
    const attr = take("id").v;
    let key = null;
    if (peek() === "[") {
      take("[");
      key = value();
      take("]");
    }
    if (!["id", "name", "createdBy", "createdDate", "closed", "tag", "ev"].includes(attr)) throw new Error(`Unknown attribute ${attr}`);
    if (attr === "ev" && typeof key !== "string") throw new Error("ev needs a variable name");
    if (peek() === "in") {
      take("in");
      take("[");
      const list = [value()];
      while (peek() === ",") {
        take(",");
        list.push(value());
      }
      take("]");
      return { attr, key, op: "in", value: list };
    }
    const op = tokens[i++]?.t;
    if (!["=", "!=", "~=", ">", ">=", "<", "<="].includes(op)) throw new Error("Operator expected");
    return { attr, key, op, value: value() };
  };
  const unary = () => {
    if (peek() === "not") {
      take("not");
      return { not: unary() };
    }
    if (peek() === "(") {
      take("(");
      const e = or();
      take(")");
      return e;
    }
    return condition();
  };
  const and = () => {
    let e = unary();
    while (peek() === "and") {
      take("and");
      e = { and: [e, unary()] };
    }
    return e;
  };
  const or = () => {
    let e = and();
    while (peek() === "or") {
      take("or");
      e = { or: [e, and()] };
    }
    return e;
  };
  if (tokens.length === 0) return null;
  const e = or();
  if (i !== tokens.length) throw new Error(`Unexpected token ${i}`);
  return e;
}

function matches(e, l) {
  if (!e) return true;
  if (e.not) return !matches(e.not, l);
  if (e.and) return e.and.every((x) => matches(x, l));
  if (e.or) return e.or.some((x) => matches(x, l));
  const many = e.attr === "tag" ? l.tags.map((t) => t.name) : e.attr === "ev" ? l.env.filter((v) => v.variable.name === e.key).map((v) => v.name) : null;
  if (many) {
    switch (e.op) {
      case "=":
        return e.value === null ? many.length === 0 : many.includes(e.value);
      case "!=":
        return e.value === null ? many.length > 0 : !many.includes(e.value);
      case "in":
        return many.some((v) => e.value.includes(v));
      case "~=":
        return many.some((v) => v.toLowerCase().includes(String(e.value).toLowerCase()));
      default:
        return false;
    }
  }
  const actual = l[e.attr];
  switch (e.op) {
    case "=":
      return actual === e.value;
    case "!=":
      return actual !== e.value;
    case "in":
      return e.value.includes(actual);
    case "~=":
      return String(actual).toLowerCase().includes(String(e.value).toLowerCase());
    case ">":
      return actual > e.value;
    case ">=":
      return actual >= e.value;
    case "<":
      return actual < e.value;
    case "<=":
      return actual <= e.value;
  }
}

function suggest(names, url) {
  const q = (url.searchParams.get("query") ?? "").toLowerCase();
  return page(names.filter((x) => x.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)), url);
}

function statistic(launchId) {
  const counts = new Map();
  for (const r of results.get(launchId) ?? []) if (!r.hidden) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return [...counts].map(([status, count]) => ({ status, count }));
}

function launchDto(l) {
  const { env: _env, ...rest } = l;
  return { ...rest, statistic: statistic(l.id) };
}

function page(items, url) {
  const size = Number(url.searchParams.get("size") ?? 20);
  const number = Number(url.searchParams.get("page") ?? 0);
  const content = items.slice(number * size, number * size + size);
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  return { content, number, size, totalElements: items.length, totalPages, last: number + 1 >= totalPages };
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const authorized = (req) => {
  const h = req.headers.authorization ?? "";
  return h === `Bearer ${JWT}` || h === `Api-Token ${TOKEN}`;
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  let m;

  if (req.method === "POST" && path === "/api/uaa/oauth/token") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    if (form.get("token") !== TOKEN) return send(res, 401, { error: "invalid_token", error_description: "Bad token" });
    return send(res, 200, { access_token: JWT, token_type: "bearer", expires_in: 3600 });
  }
  if (!authorized(req)) return send(res, 401, { message: "Unauthorized" });

  if (req.method === "GET" && FAILURE_RATE > 0 && Math.random() < FAILURE_RATE) {
    if (Math.random() < 0.5) return send(res, 500, { message: "An unexpected error occurred" });
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end("<!doctype html><html><script>window.__APP__={}</script></html>");
  }

  if (path === "/api/uaa/account/me") return send(res, 200, { username: "mock" });
  if (path === "/api/rs/project") return send(res, 200, page(projects, url));
  if ((m = /^\/api\/rs\/project\/(\d+)$/.exec(path))) {
    const p = projects.find((x) => x.id === Number(m[1]));
    return p ? send(res, 200, p) : send(res, 404, { message: "Project not found" });
  }
  if (path === "/api/rs/launch/tag/suggest") {
    const projectId = Number(url.searchParams.get("projectId"));
    const used = new Map(launches.filter((l) => !projectId || l.projectId === projectId).flatMap((l) => l.tags.map((t) => [t.id, t])));
    return send(res, 200, suggest([...used.values()], url));
  }
  if (path === "/api/rs/ev/suggest") return send(res, 200, suggest(envVars.map(({ id, name }) => ({ id, name })), url));
  if (path === "/api/rs/evv/suggest") {
    const v = envVars.find((x) => x.id === Number(url.searchParams.get("envVarId")));
    return send(res, 200, suggest(v ? v.values.map((name) => ({ id: envValueIds.get(`${v.id}:${name}`), name })) : [], url));
  }
  if (path === "/api/rs/launch" || path === "/api/rs/launch/__search" || path === "/api/rs/launch/query/validate") {
    const projectId = Number(url.searchParams.get("projectId"));
    let list = launches.filter((l) => l.projectId === projectId);
    const rql = url.searchParams.get("rql");
    if (rql !== null) {
      let expr;
      try {
        expr = parseAql(rql);
      } catch (e) {
        if (path.endsWith("/validate")) return send(res, 200, { valid: false });
        return send(res, 400, { message: `Invalid AQL: ${e.message}` });
      }
      list = list.filter((l) => matches(expr, l));
    }
    if (path.endsWith("/validate")) return send(res, 200, { valid: true, count: list.length });
    const preview = url.searchParams.get("preview") === "true";
    return send(res, 200, page(list.sort((a, b) => b.createdDate - a.createdDate).map((l) => (preview ? { ...launchDto(l), environment: l.env } : launchDto(l))), url));
  }
  if ((m = /^\/api\/rs\/launch\/(\d+)\/statistic$/.exec(path))) {
    const l = launches.find((x) => x.id === Number(m[1]));
    return l ? send(res, 200, statistic(l.id)) : send(res, 404, { message: "Launch not found" });
  }
  if ((m = /^\/api\/rs\/launch\/(\d+)(\/env)?$/.exec(path))) {
    const l = launches.find((x) => x.id === Number(m[1]));
    if (!l) return send(res, 404, { message: "Launch not found" });
    return send(res, 200, m[2] ? l.env : launchDto(l));
  }
  if (path === "/api/rs/testresult") {
    const list = results.get(Number(url.searchParams.get("launchId"))) ?? [];
    return send(res, 200, page(list, url));
  }
  if ((m = /^\/api\/rs\/launch\/(\d+)\/job$/.exec(path))) return send(res, 200, jobRuns.get(Number(m[1])) ?? []);
  if ((m = /^\/api\/rs\/testresult\/(\d+)\/evv$/.exec(path))) return send(res, 200, resultEnv.get(Number(m[1])) ?? []);
  if ((m = /^\/api\/rs\/testresult\/(\d+)\/(execution|fixture|cfv|members|issue)$/.exec(path))) {
    const d = details.get(Number(m[1]));
    if (!d) return send(res, 404, { message: "Test result not found" });
    const part = { execution: d.scenario, fixture: d.fixtures, cfv: d.cfv, members: d.members, issue: d.issues }[m[2]];
    return send(res, 200, part);
  }
  if ((m = /^\/api\/rs\/(testresult|testfixtureresult)\/attachment\/(\d+)\/content$/.exec(path))) {
    const a = attachments.get(`${m[1] === "testresult" ? "result" : "fixture"}:${m[2]}`);
    if (!a) return send(res, 404, { message: "Attachment not found" });
    res.writeHead(200, { "Content-Type": a.contentType, "Content-Length": a.body.length });
    return res.end(a.body);
  }
  send(res, 404, { message: `Mock has no ${req.method} ${path}` });
}).listen(PORT, () => {
  console.log(`Mock Allure TestOps on http://localhost:${PORT}, API token "${TOKEN}"${FAILURE_RATE ? `, failure rate ${FAILURE_RATE}` : ""}`);
});

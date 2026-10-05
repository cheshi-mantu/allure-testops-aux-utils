import { useEffect, useMemo, useState } from "react";
import { ExportOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Checkbox, DatePicker, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import {
  api,
  errorText,
  type Job,
  type Project,
  type RollbackApplySummary,
  type RollbackAttribute,
  type RollbackPlan,
  type RollbackScanInput,
  type RollbackScanSummary,
  type RollbackTestCase,
} from "./api";
import { JobList } from "./JobPanel";

const ATTRIBUTES: { key: RollbackAttribute; label: string; hint?: string }[] = [
  { key: "name", label: "Name" },
  { key: "description", label: "Description" },
  { key: "precondition", label: "Precondition" },
  { key: "expectedResult", label: "Expected result" },
  { key: "automated", label: "Automated" },
  { key: "workflow", label: "Workflow" },
  { key: "status", label: "Status" },
  { key: "layer", label: "Layer" },
  { key: "tags", label: "Tags" },
  { key: "customFields", label: "Custom fields" },
  { key: "members", label: "Members" },
  { key: "issues", label: "Issues" },
  { key: "fullName", label: "Full name", hint: "ties a test case to its automated results" },
];
const DEFAULT_ATTRIBUTES = ATTRIBUTES.map((a) => a.key).filter((k) => k !== "fullName");
const MAX_THREADS = 32;

function ScanJobSummary({ job, onShow }: { job: Job; onShow: (job: Job) => void }) {
  const s = job.summary as RollbackScanSummary | null;
  if (!s) return null;
  return (
    <Space wrap>
      <Typography.Text>
        {s.project.name}: {s.scanned} of {s.matched} test cases read, {s.logEntries ?? "?"} changes after the date, {s.toRollBack} test cases to roll back ({s.attributes} attributes)
      </Typography.Text>
      {job.state === "done" && (
        <Button size="small" onClick={() => onShow(job)}>
          Show
        </Button>
      )}
    </Space>
  );
}

function ApplyJobSummary({ job }: { job: Job }) {
  const s = job.summary as RollbackApplySummary | null;
  if (!s) return null;
  return (
    <Space wrap>
      <Typography.Text>{s.project.name}:</Typography.Text>
      <Tag color="green">rolled back {s.rolledBack}</Tag>
      {s.skipped > 0 && <Tag color="orange">skipped {s.skipped}</Tag>}
      {s.failed > 0 && <Tag color="red">failed {s.failed}</Tag>}
    </Space>
  );
}

/** A value of an attribute; long texts are cut and can be expanded. */
function Value({ text, strong, strike }: { text: string; strong?: boolean; strike?: boolean }) {
  const empty = text === "(empty)" || text === "(none)" || text === "(nothing)";
  return (
    <Typography.Paragraph
      type={empty ? "secondary" : undefined}
      strong={strong && !empty}
      delete={strike && !empty}
      ellipsis={{ rows: 3, expandable: "collapsible" }}
      style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}
    >
      {text}
    </Typography.Paragraph>
  );
}

function Changes({ t }: { t: RollbackTestCase }) {
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      {t.notes.map((n) => (
        <Alert key={n} type="warning" showIcon title={n} />
      ))}
      {t.changes.length > 0 && (
        <Table
          size="small"
          rowKey="key"
          pagination={false}
          dataSource={t.changes}
          columns={[
            {
              title: "Attribute",
              width: 170,
              render: (_, c) => (
                <>
                  {c.label}
                  {c.unchanged !== undefined && (
                    <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                      only what changes{c.unchanged ? `, ${c.unchanged} more stay` : ""}
                    </Typography.Text>
                  )}
                </>
              ),
            },
            { title: "Current value", dataIndex: "current", render: (v: string, c) => <Value text={v} strike={c.unchanged !== undefined} /> },
            { title: "Restored to", dataIndex: "target", render: (v: string) => <Value text={v} strong /> },
          ]}
        />
      )}
    </Space>
  );
}

export function TestCaseRollbackPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [aql, setAql] = useState("true");
  const [after, setAfter] = useState<Dayjs | null>(null);
  const [attributes, setAttributes] = useState<RollbackAttribute[]>(DEFAULT_ATTRIBUTES);
  const [onlyModified, setOnlyModified] = useState(false);
  const [threads, setThreads] = useState(8);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState<"count" | "scan" | "plan" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanAdded, setScanAdded] = useState<Job | null>(null);
  const [applyAdded, setApplyAdded] = useState<Job | null>(null);
  const [plan, setPlan] = useState<{ jobId: string; plan: RollbackPlan } | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api.projects().then(setProjects, (e: unknown) => setError(errorText(e)));
    api.getConfig().then((c) => setEndpoint(c.endpoint), (e: unknown) => setError(errorText(e)));
  }, []);

  const input = useMemo(
    (): RollbackScanInput | null => (projectId && after && attributes.length ? { projectId, aql, after: after.valueOf(), attributes, onlyModified, threads } : null),
    [projectId, aql, after, attributes, onlyModified, threads],
  );
  useEffect(() => setCount(null), [input]);

  const run = async (what: "count" | "scan" | "plan" | "apply", fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const showPlan = (job: Job) =>
    run("plan", async () => {
      const p = await api.rollbackPlan(job.id);
      setPlan({ jobId: job.id, plan: p });
      setSelected(p.testCases.filter((t) => t.changes.length).map((t) => t.id));
      setQuery("");
    });

  const rows = useMemo(() => {
    const all = plan?.plan.testCases ?? [];
    const q = query.trim().toLowerCase();
    return q ? all.filter((t) => t.name.toLowerCase().includes(q) || String(t.id) === q) : all;
  }, [plan, query]);
  const withChanges = (plan?.plan.testCases ?? []).filter((t) => t.changes.length);

  const apply = () => {
    if (!plan) return;
    const ids = selected.filter((id) => withChanges.some((t) => t.id === id));
    const attrs = withChanges.filter((t) => ids.includes(t.id)).reduce((n, t) => n + t.changes.length, 0);
    Modal.confirm({
      title: "Roll the test cases back?",
      content: `${ids.length} test cases of "${plan.plan.project.name}" get ${attrs} attribute values back as previewed. A test case changed since the preview is skipped. This is done on behalf of the API token owner and shows in the change log of the test cases.`,
      okText: `Roll back ${ids.length}`,
      okButtonProps: { danger: true },
      onOk: () => run("apply", async () => setApplyAdded(await api.rollbackApply(plan.jobId, ids))),
    });
  };

  const project = projects?.find((p) => p.id === projectId);

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%", maxWidth: 1200 }}>
      <div>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          Rollback of test case changes
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ maxWidth: 860 }}>
          Takes test cases back to how they were at a point in time, from their change log: name, texts, status, layer, tags, custom fields, members
          and issues. First the changes are found and shown, current value against the value to restore; then the chosen test cases are rolled back.
          Scenarios, attachments and links are not in the change log and stay as they are.
        </Typography.Paragraph>
      </div>

      {error && <Alert type="error" showIcon closable onClose={() => setError(null)} title={error} />}

      <Card title="1. Test cases and the date">
        <Space orientation="vertical" size="middle" style={{ width: "100%", maxWidth: 820 }}>
          <div>
            <Typography.Text strong>Project</Typography.Text>
            <Select<number>
              showSearch={{ optionFilterProp: "label" }}
              placeholder="Project"
              loading={!projects}
              value={projectId ?? undefined}
              onChange={setProjectId}
              options={(projects ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.id})` }))}
              style={{ width: "100%", marginTop: 4 }}
            />
            {projectId && endpoint && (
              <Typography.Link href={`${endpoint}/project/${projectId}`} target="_blank" rel="noopener">
                <ExportOutlined /> Open {project?.name ?? `project ${projectId}`} in Allure TestOps
              </Typography.Link>
            )}
          </div>
          <div>
            <Typography.Text strong>Test cases (AQL)</Typography.Text>
            <Input.TextArea value={aql} onChange={(e) => setAql(e.target.value)} autoSize={{ minRows: 1, maxRows: 4 }} placeholder="true" style={{ marginTop: 4, fontFamily: "monospace" }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              The filter of the test case list in Allure TestOps, for example <code>tag = "smoke"</code>, <code>cf["Team"] = "Search"</code>,{" "}
              <code>id in [12, 15]</code>, <code>lastModifiedBy = "jane"</code>; <code>true</code> takes all.
            </Typography.Text>
          </div>
          <div>
            <Typography.Text strong>Roll back the changes made after</Typography.Text>
            <br />
            <Space wrap style={{ marginTop: 4 }}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" value={after} onChange={setAfter} disabledDate={(d) => d.isAfter(dayjs())} />
              <Typography.Text type="secondary">local time of this browser</Typography.Text>
            </Space>
          </div>
          <div>
            <Space style={{ marginBottom: 4 }}>
              <Typography.Text strong>Attributes</Typography.Text>
              <Button size="small" onClick={() => setAttributes(ATTRIBUTES.map((a) => a.key))}>
                All
              </Button>
              <Button size="small" onClick={() => setAttributes([])}>
                None
              </Button>
            </Space>
            <Checkbox.Group value={attributes} onChange={(v) => setAttributes(v as RollbackAttribute[])} style={{ width: "100%" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 4 }}>
                {ATTRIBUTES.map((a) => (
                  <Checkbox key={a.key} value={a.key} title={a.hint}>
                    {a.label}
                    {a.hint && <Typography.Text type="secondary"> *</Typography.Text>}
                  </Checkbox>
                ))}
              </div>
            </Checkbox.Group>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              * The full name ties a test case to its automated results; it is off unless chosen.
            </Typography.Text>
          </div>
          <Space>
            <Switch checked={onlyModified} onChange={setOnlyModified} />
            <Typography.Text>Only test cases modified after the date</Typography.Text>
            <Typography.Text type="secondary">
              (faster on a large project, but some changes, custom field ones among them, do not move the modification date of a test case and are missed)
            </Typography.Text>
          </Space>
          <Space wrap>
            <Typography.Text strong>Threads</Typography.Text>
            <InputNumber min={1} max={MAX_THREADS} precision={0} value={threads} onChange={(v) => setThreads(v ?? 8)} style={{ width: 80 }} />
            <Typography.Text type="secondary">
              test cases read at a time, 1 to {MAX_THREADS}; more is faster and loads Allure TestOps more, 8 suits most instances
            </Typography.Text>
          </Space>
          <Space wrap>
            <Button onClick={() => input && run("count", async () => setCount((await api.rollbackCount(input)).count))} loading={busy === "count"} disabled={!input}>
              Count test cases
            </Button>
            <Button type="primary" onClick={() => input && run("scan", async () => setScanAdded(await api.rollbackScan(input)))} loading={busy === "scan"} disabled={!input}>
              Find changes
            </Button>
            <Typography.Text type="secondary">
              {!input ? "Choose the project, the date and at least one attribute" : count !== null ? `${count} test cases to look at` : "Finding changes reads, it changes nothing"}
            </Typography.Text>
          </Space>
        </Space>
      </Card>

      <JobList
        kind="testcase-rollback-scan"
        added={scanAdded}
        summary={(job) => <ScanJobSummary job={job} onShow={showPlan} />}
        onFinished={(job) => {
          if (job.state === "done" && job.id === scanAdded?.id) showPlan(job);
        }}
      />

      {plan && (
        <Card
          title={`2. Review: ${plan.plan.project.name}, changes after ${dayjs(plan.plan.options.after).format("YYYY-MM-DD HH:mm")}`}
          extra={<Input.Search allowClear placeholder="Name or ID" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 240 }} />}
        >
          <Space orientation="vertical" style={{ width: "100%" }}>
            <Space wrap>
              <Button type="primary" danger onClick={apply} loading={busy === "apply"} disabled={selected.length === 0}>
                Roll back {selected.length} test cases…
              </Button>
              <Button size="small" onClick={() => setSelected(withChanges.map((t) => t.id))}>
                Select all
              </Button>
              <Button size="small" onClick={() => setSelected([])}>
                Select none
              </Button>
              <Typography.Text type="secondary">
                {plan.plan.matched} test cases looked at, {withChanges.length} with changes to roll back; unchecked ones are left as they are
              </Typography.Text>
            </Space>
            <Table<RollbackTestCase>
              size="small"
              rowKey="id"
              dataSource={rows}
              loading={busy === "plan"}
              pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [50, 100, 500] }}
              locale={{ emptyText: "No changes after the date" }}
              rowSelection={{
                selectedRowKeys: selected,
                onChange: (keys) => setSelected(keys as number[]),
                getCheckboxProps: (t) => ({ disabled: t.changes.length === 0 }),
                preserveSelectedRowKeys: true,
              }}
              expandable={{ expandedRowRender: (t) => <Changes t={t} />, rowExpandable: (t) => t.changes.length + t.notes.length > 0 }}
              columns={[
                {
                  title: "ID",
                  dataIndex: "id",
                  width: 90,
                  render: (id: number, t) => (
                    <a href={t.url} target="_blank" rel="noopener">
                      {id}
                    </a>
                  ),
                },
                { title: "Name", dataIndex: "name" },
                {
                  title: "To restore",
                  render: (_, t) =>
                    t.changes.length ? (
                      <Space size={2} wrap>
                        {t.changes.map((c) => (
                          <Tag key={c.key} style={{ marginInlineEnd: 0 }}>
                            {c.label}
                          </Tag>
                        ))}
                      </Space>
                    ) : (
                      <Typography.Text type="secondary">nothing</Typography.Text>
                    ),
                },
                {
                  title: "Changed by",
                  width: 180,
                  render: (_, t) => (
                    <Typography.Text type="secondary">
                      {Object.entries(t.authors)
                        .map(([who, n]) => `${who} (${n})`)
                        .join(", ")}
                    </Typography.Text>
                  ),
                },
                { title: "Notes", width: 90, render: (_, t) => (t.notes.length ? <Tag color="orange">{t.notes.length}</Tag> : null) },
              ]}
            />
          </Space>
        </Card>
      )}

      <JobList kind="testcase-rollback" added={applyAdded} summary={(job) => <ApplyJobSummary job={job} />} />
    </Space>
  );
}

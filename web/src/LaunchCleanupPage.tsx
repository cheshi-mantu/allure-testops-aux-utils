import { useEffect, useMemo, useState } from "react";
import { ExportOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Checkbox, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import {
  api,
  errorText,
  type CleanupLaunch,
  type Job,
  type LaunchCleanupDeleteSummary,
  type LaunchCleanupInput,
  type LaunchCleanupPlan,
  type LaunchCleanupScanSummary,
  type Project,
  type ResultStatus,
} from "./api";
import { JobList } from "./JobPanel";
import { LaunchFilter } from "./LaunchFilter";
import { STATUS_COLORS } from "./LaunchPicker";

const MAX_THREADS = 32;
const STATUSES: ResultStatus[] = ["passed", "failed", "broken", "skipped", "unknown"];
const fmt = (ms: number | null) => (ms ? dayjs(ms).format("YYYY-MM-DD HH:mm") : "–");

function ScanJobSummary({ job, onShow }: { job: Job; onShow: (job: Job) => void }) {
  const s = job.summary as LaunchCleanupScanSummary | null;
  if (!s) return null;
  return (
    <Space wrap>
      <Typography.Text>
        {s.project.name}: {s.found} launches created before {fmt(s.before)}, {s.results} test results
        {s.read < s.found ? ` (${s.read} read)` : ""}
      </Typography.Text>
      {job.state === "done" && (
        <Button size="small" onClick={() => onShow(job)}>
          Show
        </Button>
      )}
    </Space>
  );
}

function DeleteJobSummary({ job }: { job: Job }) {
  const s = job.summary as LaunchCleanupDeleteSummary | null;
  if (!s) return null;
  return (
    <Space wrap>
      <Typography.Text>{s.project.name}:</Typography.Text>
      <Tag color="green">deleted {s.deleted}</Tag>
      {s.skipped > 0 && <Tag color="orange">skipped {s.skipped}</Tag>}
      {s.failed > 0 && <Tag color="red">failed {s.failed}</Tag>}
    </Space>
  );
}

function Results({ launch }: { launch: CleanupLaunch }) {
  if (!launch.statistic) return <Typography.Text type="secondary">–</Typography.Text>;
  return (
    <Space size={2} wrap>
      {STATUSES.filter((s) => launch.statistic?.[s]).map((s) => (
        <Tooltip key={s} title={s}>
          <Tag color={STATUS_COLORS[s]} style={{ marginInlineEnd: 0 }}>
            {launch.statistic?.[s]}
          </Tag>
        </Tooltip>
      ))}
    </Space>
  );
}

/** Asks to type the number of launches, so that a deletion is never a stray click. */
function ConfirmDelete({ count, project, onCancel, onConfirm }: { count: number; project: string; onCancel: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState("");
  return (
    <Modal
      open
      title="Delete the launches?"
      okText={`Delete ${count}`}
      okButtonProps={{ danger: true, disabled: typed.trim() !== String(count) }}
      onOk={onConfirm}
      onCancel={onCancel}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Typography.Paragraph>
          {count} launches of "{project}" are deleted with their test results. This cannot be undone. A launch that no longer matches the filter is
          skipped. This is done on behalf of the API token owner.
        </Typography.Paragraph>
        <Typography.Text>Type {count} to confirm:</Typography.Text>
        <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onPressEnter={() => typed.trim() === String(count) && onConfirm()} style={{ width: 160 }} />
      </Space>
    </Modal>
  );
}

export function LaunchCleanupPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [keepDays, setKeepDays] = useState(30);
  const [aql, setAql] = useState("");
  const [onlyClosed, setOnlyClosed] = useState(true);
  const [threads, setThreads] = useState(8);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState<"count" | "scan" | "plan" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanAdded, setScanAdded] = useState<Job | null>(null);
  const [deleteAdded, setDeleteAdded] = useState<Job | null>(null);
  const [plan, setPlan] = useState<{ jobId: string; plan: LaunchCleanupPlan } | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api.projects().then(setProjects, (e: unknown) => setError(errorText(e)));
    api.getConfig().then((c) => setEndpoint(c.endpoint), (e: unknown) => setError(errorText(e)));
  }, []);

  const input = useMemo((): LaunchCleanupInput | null => (projectId ? { projectId, keepDays, aql, onlyClosed, threads } : null), [projectId, keepDays, aql, onlyClosed, threads]);
  useEffect(() => setCount(null), [input]);

  const run = async (what: "count" | "scan" | "plan" | "delete", fn: () => Promise<void>) => {
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
      const p = await api.launchCleanupPlan(job.id);
      setPlan({ jobId: job.id, plan: p });
      setSelected(p.launches.map((l) => l.id));
      setQuery("");
    });

  const rows = useMemo(() => {
    const all = plan?.plan.launches ?? [];
    const q = query.trim().toLowerCase();
    return q ? all.filter((l) => l.name.toLowerCase().includes(q) || String(l.id) === q || l.tags.some((t) => t.toLowerCase().includes(q))) : all;
  }, [plan, query]);
  const chosenResults = (plan?.plan.launches ?? []).filter((l) => selected.includes(l.id)).reduce((n, l) => n + (l.results ?? 0), 0);

  const project = projects?.find((p) => p.id === projectId);

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%", maxWidth: 1200 }}>
      <div>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          Launch cleanup
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ maxWidth: 860 }}>
          Deletes the launches of a project older than the history to keep, optionally only those matching a filter. A dry run comes first: it lists the
          launches to delete with their attributes, and the list can be downloaded. Then the chosen launches are deleted with their test results.
        </Typography.Paragraph>
      </div>

      {error && <Alert type="error" showIcon closable onClose={() => setError(null)} title={error} />}

      <Card title="1. Launches to delete">
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <div style={{ maxWidth: 720 }}>
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
              <Typography.Link href={`${endpoint}/project/${projectId}/launches`} target="_blank" rel="noopener">
                <ExportOutlined /> Open the launches of {project?.name ?? `project ${projectId}`} in Allure TestOps
              </Typography.Link>
            )}
          </div>
          <Space wrap>
            <Typography.Text strong>Keep the history of the last</Typography.Text>
            <InputNumber min={0} max={36500} precision={0} value={keepDays} onChange={(v) => setKeepDays(v ?? 0)} style={{ width: 100 }} />
            <Typography.Text strong>days</Typography.Text>
            <Typography.Text type="secondary">launches created before {dayjs().subtract(keepDays, "day").format("YYYY-MM-DD HH:mm")} are deleted</Typography.Text>
          </Space>
          <div>
            <Typography.Text strong>Only launches matching</Typography.Text>
            <Typography.Text type="secondary"> (no conditions: all launches older than that)</Typography.Text>
            <div style={{ marginTop: 4 }}>
              <LaunchFilter projectId={projectId} onApply={setAql} storageKey="launchCleanup.filter" />
            </div>
          </div>
          <Checkbox checked={onlyClosed} onChange={(e) => setOnlyClosed(e.target.checked)}>
            Only closed launches <Typography.Text type="secondary">(a launch still open may be in progress)</Typography.Text>
          </Checkbox>
          <Space wrap>
            <Typography.Text strong>Threads</Typography.Text>
            <InputNumber min={1} max={MAX_THREADS} precision={0} value={threads} onChange={(v) => setThreads(v ?? 8)} style={{ width: 80 }} />
            <Typography.Text type="secondary">launches read or deleted at a time, 1 to {MAX_THREADS}; more is faster and loads Allure TestOps more</Typography.Text>
          </Space>
          <Space wrap>
            <Button onClick={() => input && run("count", async () => setCount((await api.launchCleanupCount(input)).count))} loading={busy === "count"} disabled={!input}>
              Count launches
            </Button>
            <Button type="primary" onClick={() => input && run("scan", async () => setScanAdded(await api.launchCleanupScan(input)))} loading={busy === "scan"} disabled={!input}>
              Dry run
            </Button>
            <Typography.Text type="secondary">
              {!input ? "Choose the project" : count !== null ? `${count} launches to delete` : "The dry run lists the launches, it deletes nothing"}
            </Typography.Text>
          </Space>
        </Space>
      </Card>

      <JobList
        kind="launch-cleanup-scan"
        added={scanAdded}
        summary={(job) => <ScanJobSummary job={job} onShow={showPlan} />}
        onFinished={(job) => {
          if (job.state === "done" && job.id === scanAdded?.id) showPlan(job);
        }}
      />

      {plan && (
        <Card
          title={`2. ${plan.plan.project.name}: launches created before ${fmt(plan.plan.before)}`}
          extra={<Input.Search allowClear placeholder="Name, ID or tag" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 240 }} />}
        >
          <Space orientation="vertical" style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              AQL: <code>{plan.plan.rql}</code>
            </Typography.Text>
            <Space wrap>
              <Button type="primary" danger onClick={() => setConfirming(true)} loading={busy === "delete"} disabled={selected.length === 0}>
                Delete {selected.length} launches…
              </Button>
              <Button size="small" onClick={() => setSelected(plan.plan.launches.map((l) => l.id))}>
                Select all
              </Button>
              <Button size="small" onClick={() => setSelected([])}>
                Select none
              </Button>
              <Typography.Text type="secondary">
                {plan.plan.launches.length} launches found, {selected.length} chosen with {chosenResults} test results; unchecked ones stay
              </Typography.Text>
            </Space>
            <Table<CleanupLaunch>
              size="small"
              rowKey="id"
              dataSource={rows}
              loading={busy === "plan"}
              pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [50, 100, 500] }}
              locale={{ emptyText: "No launches to delete" }}
              rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as number[]), preserveSelectedRowKeys: true }}
              columns={[
                {
                  title: "ID",
                  dataIndex: "id",
                  width: 90,
                  render: (id: number, l) => (
                    <a href={l.url} target="_blank" rel="noopener">
                      {id}
                    </a>
                  ),
                },
                { title: "Name", dataIndex: "name" },
                { title: "Created", width: 150, render: (_, l) => fmt(l.createdDate), sorter: (a, b) => (a.createdDate ?? 0) - (b.createdDate ?? 0) },
                { title: "By", dataIndex: "createdBy", width: 110 },
                {
                  title: "Tags",
                  render: (_, l) => (
                    <Space size={2} wrap>
                      {l.tags.map((t) => (
                        <Tag key={t} style={{ marginInlineEnd: 0 }}>
                          {t}
                        </Tag>
                      ))}
                    </Space>
                  ),
                },
                { title: "Environment", render: (_, l) => <Typography.Text type="secondary">{l.env.join(", ")}</Typography.Text> },
                { title: "Results", width: 170, render: (_, l) => <Results launch={l} />, sorter: (a, b) => (a.results ?? 0) - (b.results ?? 0) },
                { title: "", width: 70, render: (_, l) => (l.closed ? null : <Tag color="blue">open</Tag>) },
              ]}
            />
          </Space>
        </Card>
      )}

      {confirming && plan && (
        <ConfirmDelete
          count={selected.length}
          project={plan.plan.project.name}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void run("delete", async () => {
              setDeleteAdded(await api.launchCleanupDelete(plan.jobId, selected));
            });
          }}
        />
      )}

      <JobList kind="launch-cleanup" added={deleteAdded} summary={(job) => <DeleteJobSummary job={job} />} />
    </Space>
  );
}

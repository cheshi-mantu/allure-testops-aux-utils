import { useEffect, useState } from "react";
import { Alert, Button, Card, Form, Input, InputNumber, Select, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import { api, errorText, type GroupBy, type Job, type LaunchReportInput, type LaunchRow, type Project, type ResultStatus, type Theme } from "./api";
import { JobList } from "./JobPanel";
import { LaunchFilter } from "./LaunchFilter";

const PROJECT_KEY = "launchReport.projectId";

const STATUS_COLORS: Record<ResultStatus | "in progress", string> = {
  passed: "green",
  failed: "red",
  broken: "orange",
  skipped: "default",
  unknown: "purple",
  "in progress": "blue",
};

type Options = Omit<LaunchReportInput, "launchId">;

const DEFAULT_OPTIONS: Options = {
  reportName: "",
  includeAttachments: true,
  maxAttachmentMb: 20,
  includeRetries: true,
  groupBy: "auto",
  theme: "auto",
};

const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "auto", label: "Auto: suites, else behaviours, else packages" },
  { value: "suites", label: "Suites (parent suite → suite → sub suite)" },
  { value: "behaviors", label: "Behaviours (epic → feature → story)" },
  { value: "packages", label: "Package" },
  { value: "none", label: "No grouping" },
];

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "auto", label: "As in the viewer's system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function storedProject(): number | null {
  try {
    const v = Number(localStorage.getItem(PROJECT_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function Statistic({ launch }: { launch: LaunchRow }) {
  if (!launch.statistic) return <Typography.Text type="secondary">–</Typography.Text>;
  return (
    <Space size={2} wrap>
      {launch.statistic
        .filter((s) => s.count > 0)
        .map((s) => {
          const status = s.status ?? "in progress";
          return (
            <Tooltip key={status} title={status}>
              <Tag color={STATUS_COLORS[status]} style={{ marginInlineEnd: 0 }}>
                {s.count}
              </Tag>
            </Tooltip>
          );
        })}
    </Space>
  );
}

/** Values of one variable together: a launch can have several. */
function envGroups(env: LaunchRow["env"]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const { name, value } of env) groups.set(name, [...(groups.get(name) ?? []), value]);
  return [...groups];
}

export function LaunchReportPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState<number | null>(storedProject);
  const [query, setQuery] = useState("");
  const [aql, setAql] = useState<string | null>(null);
  const [launches, setLaunches] = useState<LaunchRow[]>([]);
  /** null until the first list is loaded and after a failed load. */
  const [total, setTotal] = useState<number | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LaunchRow | null>(null);
  const [form] = Form.useForm<Options>();
  const includeAttachments = Form.useWatch("includeAttachments", form);
  const [starting, setStarting] = useState(false);
  const [added, setAdded] = useState<Job | null>(null);

  useEffect(() => {
    api.projects().then(
      (list) => {
        setProjects(list);
        setProjectId((id) => (id && list.some((p) => p.id === id) ? id : null));
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, []);

  useEffect(() => {
    // Waits for the filter to report its first value.
    if (!projectId || aql === null) return;
    try {
      localStorage.setItem(PROJECT_KEY, String(projectId));
    } catch {
      // Remembering the project is a convenience only.
    }
    let stale = false;
    setLoading(true);
    setSelected(null);
    api
      .launches(projectId, query, aql)
      .then(
        (list) => {
          if (stale) return;
          setLaunches(list.launches);
          setTotal(list.total);
          setListError(null);
        },
        (e: unknown) => {
          if (stale) return;
          setLaunches([]);
          setTotal(null);
          setListError(errorText(e));
        },
      )
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [projectId, query, aql]);

  const start = async (options: Options) => {
    if (!selected) return;
    setStarting(true);
    try {
      setAdded(await api.startLaunchReport({ ...options, launchId: selected.id }));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%", maxWidth: 1200 }}>
      <div>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          Launch → Allure Report
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ maxWidth: 820 }}>
          Builds an Allure Report 3 from the test results of one launch as a single HTML file that opens in any browser without a server: steps,
          fixtures, attachments, parameters, links, tags and custom fields, retries and the launch environment.
        </Typography.Paragraph>
      </div>

      {error && <Alert type="error" showIcon closable onClose={() => setError(null)} title={error} />}

      <Card title="1. Launch">
        <Space wrap style={{ marginBottom: 16 }}>
          <Select<number>
            showSearch={{ optionFilterProp: "label" }}
            placeholder="Project"
            loading={!projects}
            value={projectId ?? undefined}
            onChange={setProjectId}
            options={(projects ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.id})` }))}
            style={{ width: 320 }}
          />
          <Input.Search
            placeholder="Launch ID or part of the name"
            allowClear
            disabled={!projectId}
            onSearch={(v) => setQuery(v.trim())}
            style={{ width: 320 }}
          />
        </Space>
        <div style={{ marginBottom: 16 }}>
          <LaunchFilter projectId={projectId} onApply={setAql} />
        </div>
        {listError && <Alert type="error" showIcon title={listError} style={{ marginBottom: 16 }} />}
        {projectId && !loading && total !== null && (
          <Typography.Paragraph type="secondary">
            {query || aql
              ? `${total} launch${total === 1 ? "" : "es"} match${total === 1 ? "es" : ""}${total > launches.length ? `, the latest ${launches.length} are listed` : ""}`
              : `The latest ${launches.length} of ${total} launches`}
          </Typography.Paragraph>
        )}
        <Table<LaunchRow>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={projectId ? launches : []}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 1100 }}
          locale={{ emptyText: projectId ? "No launches found" : "Choose a project" }}
          rowSelection={{
            type: "radio",
            selectedRowKeys: selected ? [selected.id] : [],
            onChange: (_, rows) => setSelected(rows[0] ?? null),
          }}
          onRow={(l) => ({ onClick: () => setSelected(l), style: { cursor: "pointer" } })}
          columns={[
            { title: "ID", dataIndex: "id", width: 90 },
            {
              title: "Name",
              dataIndex: "name",
              render: (_, l) => (
                <Space size={4} wrap>
                  {l.name}
                  {l.tags.map((t) => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: "Created",
              width: 220,
              render: (_, l) => (
                <span>
                  {l.createdDate ? dayjs(l.createdDate).format("YYYY-MM-DD HH:mm") : "–"}
                  {l.createdBy && <Typography.Text type="secondary"> by {l.createdBy}</Typography.Text>}
                </span>
              ),
            },
            {
              title: "Environment",
              width: 240,
              render: (_, l) => (
                <Space size={2} wrap>
                  {envGroups(l.env).map(([name, values]) => (
                    <Tag key={name} style={{ marginInlineEnd: 0, whiteSpace: "normal" }}>
                      {name}: {values.join(", ")}
                    </Tag>
                  ))}
                </Space>
              ),
            },
            { title: "State", width: 90, render: (_, l) => (l.closed ? <Tag>closed</Tag> : <Tag color="blue">open</Tag>) },
            { title: "Results", width: 220, render: (_, l) => <Statistic launch={l} /> },
          ]}
        />
      </Card>

      <Card title="2. Report">
        <Form<Options> form={form} layout="vertical" initialValues={DEFAULT_OPTIONS} onFinish={start} style={{ maxWidth: 720 }}>
          <Form.Item name="reportName" label="Report name">
            <Input placeholder={selected ? selected.name : "The launch name"} allowClear />
          </Form.Item>
          <Form.Item name="groupBy" label="Group test results by" extra="Custom fields named like Allure labels (Suite, Parent Suite, Epic, Feature, Story, Package…) are used for grouping.">
            <Select options={GROUP_BY_OPTIONS} />
          </Form.Item>
          <Space size="large" wrap align="start">
            <Form.Item name="includeRetries" label="Retries" valuePropName="checked" tooltip="Earlier attempts of retried tests, shown on the Retries tab of a test">
              <Switch />
            </Form.Item>
            <Form.Item name="includeAttachments" label="Attachments" valuePropName="checked" tooltip="Attachments are embedded in the HTML file and make it bigger">
              <Switch />
            </Form.Item>
            <Form.Item name="maxAttachmentMb" label="Skip attachments larger than" tooltip="0 means no limit">
              <InputNumber min={0} max={1024} addonAfter="MB" disabled={!includeAttachments} style={{ width: 150 }} />
            </Form.Item>
            <Form.Item name="theme" label="Theme">
              <Select options={THEME_OPTIONS} style={{ width: 220 }} />
            </Form.Item>
          </Space>
          <Space>
            <Button type="primary" htmlType="submit" loading={starting} disabled={!selected}>
              Build report
            </Button>
            <Typography.Text type="secondary">{selected ? `Launch ${selected.id}: ${selected.name}` : "Choose a launch above"}</Typography.Text>
          </Space>
        </Form>
      </Card>

      <JobList kind="launch-report" added={added} />
    </Space>
  );
}

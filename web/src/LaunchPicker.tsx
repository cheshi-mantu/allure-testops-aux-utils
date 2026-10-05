import { useEffect, useState } from "react";
import { Alert, Card, Input, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import { api, errorText, type LaunchRow, type Project, type ResultStatus } from "./api";
import { LaunchFilter } from "./LaunchFilter";

const PROJECT_KEY = "launchReport.projectId";

export const STATUS_COLORS: Record<ResultStatus | "in progress", string> = {
  passed: "green",
  failed: "red",
  broken: "orange",
  skipped: "default",
  unknown: "purple",
  "in progress": "blue",
};

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

/** Project, search, filter and the list of launches to choose one from. Shared by the launch tools. */
export function LaunchPicker({ selected, onSelect }: { selected: LaunchRow | null; onSelect: (launch: LaunchRow | null) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState<number | null>(storedProject);
  const [query, setQuery] = useState("");
  const [aql, setAql] = useState<string | null>(null);
  const [launches, setLaunches] = useState<LaunchRow[]>([]);
  /** null until the first list is loaded and after a failed load. */
  const [total, setTotal] = useState<number | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.projects().then(
      (list) => {
        setProjects(list);
        setProjectId((id) => (id && list.some((p) => p.id === id) ? id : null));
      },
      (e: unknown) => setListError(errorText(e)),
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
    onSelect(null);
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

  return (
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
          onChange: (_, rows) => onSelect(rows[0] ?? null),
        }}
        onRow={(l) => ({ onClick: () => onSelect(l), style: { cursor: "pointer" } })}
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
  );
}

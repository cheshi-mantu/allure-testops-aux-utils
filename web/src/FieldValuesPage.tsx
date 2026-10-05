import { useEffect, useMemo, useState } from "react";
import { ExportOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Modal, Radio, Select, Space, Switch, Table, Tag, Typography } from "antd";
import { api, errorText, type CleanupSummary, type FieldValue, type Job, type Project, type ProjectField, type ValueImpact } from "./api";
import { JobList } from "./JobPanel";

interface Row extends FieldValue {
  key: string;
  field: ProjectField;
}

type Scope = "all" | "project" | "global";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const rowKey = (fieldId: number, valueId: number) => `${fieldId}:${valueId}`;

function CleanupJobSummary({ job }: { job: Job }) {
  const s = job.summary as CleanupSummary | null;
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

function ValueTags({ global, isDefault }: { global: boolean; isDefault: boolean }) {
  return (
    <>
      {global && <Tag color="purple">global</Tag>}
      {isDefault && <Tag color="blue">default</Tag>}
    </>
  );
}

/** What deleting the chosen values does, shown before confirming. */
function Impact({ impacts }: { impacts: ValueImpact[] }) {
  const live = impacts.filter((v) => !v.gone && v.testCases === 0);
  const used = impacts.filter((v) => !v.gone && v.testCases > 0);
  const gone = impacts.filter((v) => v.gone);
  const global = live.filter((v) => v.global);
  const defaults = live.filter((v) => v.isDefault);
  const inBin = live.filter((v) => v.deletedTestCases > 0);
  const binCases = inBin.reduce((n, v) => n + v.deletedTestCases, 0);
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Typography.Text>
        {live.length === 1 ? "1 value is" : `${live.length} values are`} deleted from the project. Test cases of the project do not use {live.length === 1 ? "it" : "them"}.
      </Typography.Text>
      {inBin.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title={`${plural(inBin.length, "value is", "values are")} set in ${plural(binCases, "deleted test case")} (the recycle bin). These test cases lose the value, also when restored later.`}
        />
      )}
      {defaults.length > 0 && <Alert type="warning" showIcon title={`${plural(defaults.length, "value is the default", "values are the defaults")} of the field; the field is left without a default in the project.`} />}
      {global.length > 0 && (
        <Alert
          type="info"
          showIcon
          title={`${plural(global.length, "global value", "global values")}: removed from this project only. A global value no other project and no test case has is deleted from Allure TestOps.`}
        />
      )}
      {used.length + gone.length > 0 && <Alert type="info" showIcon title={`${plural(used.length + gone.length, "value is", "values are")} skipped: test cases use them now, or they are not in the project any more.`} />}
      <Table
        size="small"
        rowKey={(v) => rowKey(v.fieldId, v.valueId)}
        dataSource={impacts}
        pagination={impacts.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
        columns={[
          { title: "Field", dataIndex: "fieldName" },
          {
            title: "Value",
            render: (_, v) => (
              <Space size={4} wrap>
                <Typography.Text delete={!v.gone && v.testCases === 0}>{v.name}</Typography.Text>
                <ValueTags global={v.global} isDefault={v.isDefault} />
              </Space>
            ),
          },
          {
            title: "Affected",
            render: (_, v) =>
              v.gone ? (
                <Tag>gone, skipped</Tag>
              ) : v.testCases > 0 ? (
                <Tag color="orange">{plural(v.testCases, "test case")} now, skipped</Tag>
              ) : v.deletedTestCases > 0 ? (
                <Tag color="orange">{plural(v.deletedTestCases, "deleted test case")}</Tag>
              ) : (
                <Typography.Text type="secondary">nothing</Typography.Text>
              ),
          },
        ]}
      />
    </Space>
  );
}

export function FieldValuesPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [fields, setFields] = useState<ProjectField[] | null>(null);
  const [chosenFields, setChosenFields] = useState<number[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [onlyUnused, setOnlyUnused] = useState(true);
  const [scope, setScope] = useState<Scope>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Job | null>(null);

  useEffect(() => {
    api.projects().then(setProjects, (e: unknown) => setError(errorText(e)));
    api.getConfig().then((c) => setEndpoint(c.endpoint), (e: unknown) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    setFields(null);
    setChosenFields([]);
    setRows(null);
    setSelected([]);
    if (!projectId) return;
    api.projectFields(projectId).then(
      (list) => {
        setFields(list);
        setChosenFields(list.map((f) => f.id));
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, [projectId]);

  const load = async () => {
    if (!projectId || !fields) return;
    setLoading(true);
    setSelected([]);
    try {
      const wanted = fields.filter((f) => chosenFields.includes(f.id));
      const lists = await Promise.all(wanted.map(async (f) => (await api.fieldValues(projectId, f.id)).map((v): Row => ({ ...v, key: rowKey(f.id, v.id), field: f }))));
      setRows(lists.flat());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  const shown = useMemo(
    () => (rows ?? []).filter((r) => (!onlyUnused || r.testCases === 0) && (scope === "all" || r.global === (scope === "global"))),
    [rows, onlyUnused, scope],
  );
  const unused = (rows ?? []).filter((r) => r.testCases === 0).length;

  const remove = async () => {
    if (!projectId || !rows) return;
    const chosen = rows.filter((r) => selected.includes(r.key)).map((r) => ({ fieldId: r.field.id, valueId: r.id }));
    setChecking(true);
    let impacts: ValueImpact[];
    try {
      impacts = await api.checkValues(projectId, chosen);
      setError(null);
    } catch (e) {
      setError(errorText(e));
      return;
    } finally {
      setChecking(false);
    }
    const toDelete = impacts.filter((v) => !v.gone && v.testCases === 0).length;
    Modal.confirm({
      title: "Delete the unused values?",
      width: 760,
      content: <Impact impacts={impacts} />,
      okText: `Delete ${toDelete}`,
      okButtonProps: { danger: true, disabled: toDelete === 0 },
      onOk: async () => {
        try {
          setAdded(await api.deleteValues(projectId, chosen));
          setSelected([]);
          setError(null);
        } catch (e) {
          setError(errorText(e));
        }
      },
    });
  };

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%", maxWidth: 1200 }}>
      <div>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          Unused custom field values
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ maxWidth: 860 }}>
          Lists the values of custom fields in a project with the number of test cases that have them, and deletes the values no test case uses.
          Before deleting, the values are checked again: deleted test cases in the recycle bin that still have a value, default values and global values are
          shown. A value that got test cases in the meantime is skipped.
        </Typography.Paragraph>
      </div>

      {error && <Alert type="error" showIcon closable onClose={() => setError(null)} title={error} />}

      <Card title="1. Project and fields">
        <Space orientation="vertical" size="middle" style={{ width: "100%", maxWidth: 720 }}>
          <Select<number>
            showSearch={{ optionFilterProp: "label" }}
            placeholder="Project"
            loading={!projects}
            value={projectId ?? undefined}
            onChange={setProjectId}
            options={(projects ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.id})` }))}
            style={{ width: "100%" }}
          />
          {projectId && endpoint && (
            <Typography.Link href={`${endpoint}/project/${projectId}`} target="_blank" rel="noopener">
              <ExportOutlined /> Open {projects?.find((p) => p.id === projectId)?.name ?? `project ${projectId}`} in Allure TestOps
            </Typography.Link>
          )}
          {projectId && (
            <>
              <Select<number[]>
                mode="multiple"
                allowClear
                placeholder="Custom fields"
                loading={!fields}
                value={chosenFields}
                onChange={setChosenFields}
                options={(fields ?? []).map((f) => ({ value: f.id, label: f.name }))}
                optionFilterProp="label"
                maxTagCount="responsive"
                style={{ width: "100%" }}
              />
              <Space wrap>
                <Button type="primary" onClick={load} loading={loading} disabled={!fields || chosenFields.length === 0}>
                  Find values
                </Button>
                <Button size="small" onClick={() => setChosenFields((fields ?? []).map((f) => f.id))} disabled={!fields}>
                  All fields
                </Button>
                <Button size="small" onClick={() => setChosenFields([])} disabled={!fields}>
                  None
                </Button>
              </Space>
            </>
          )}
        </Space>
      </Card>

      {rows && (
        <Card
          title="2. Values"
          extra={
            <Space wrap>
              <Radio.Group size="small" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
                <Radio.Button value="all">All</Radio.Button>
                <Radio.Button value="project">Project</Radio.Button>
                <Radio.Button value="global">Global</Radio.Button>
              </Radio.Group>
              <Switch size="small" checked={onlyUnused} onChange={setOnlyUnused} />
              <Typography.Text>Only unused</Typography.Text>
            </Space>
          }
        >
          <Space orientation="vertical" style={{ width: "100%" }}>
            <Space wrap>
              <Button onClick={() => setSelected(shown.filter((r) => r.testCases === 0).map((r) => r.key))} disabled={!shown.some((r) => r.testCases === 0)}>
                Select all unused shown
              </Button>
              <Button danger onClick={remove} loading={checking} disabled={selected.length === 0}>
                Delete {selected.length || ""} selected…
              </Button>
              <Typography.Text type="secondary">
                {rows.length} values, {unused} unused
              </Typography.Text>
            </Space>
            <Table<Row>
              size="small"
              rowKey="key"
              dataSource={shown}
              pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [50, 100, 500] }}
              locale={{ emptyText: onlyUnused ? "No unused values" : "No values" }}
              rowSelection={{
                selectedRowKeys: selected,
                onChange: (keys) => setSelected(keys as string[]),
                // Only values no test case uses can be deleted here.
                getCheckboxProps: (r) => ({ disabled: r.testCases > 0 }),
                preserveSelectedRowKeys: true,
              }}
              columns={[
                { title: "Field", render: (_, r) => r.field.name, sorter: (a, b) => a.field.name.localeCompare(b.field.name) },
                {
                  title: "Value",
                  dataIndex: "name",
                  sorter: (a, b) => a.name.localeCompare(b.name),
                  render: (_, r) => (
                    <Space size={4} wrap>
                      <Typography.Text>{r.name}</Typography.Text>
                      <ValueTags global={r.global} isDefault={r.field.defaultValueId === r.id} />
                    </Space>
                  ),
                },
                {
                  title: "Test cases",
                  dataIndex: "testCases",
                  width: 120,
                  align: "right",
                  sorter: (a, b) => a.testCases - b.testCases,
                  render: (n: number) => (n === 0 ? <Typography.Text type="secondary">0</Typography.Text> : n),
                },
              ]}
            />
          </Space>
        </Card>
      )}

      <JobList
        kind="field-values"
        added={added}
        summary={(job) => <CleanupJobSummary job={job} />}
        // Show what is left once values are deleted.
        onFinished={(job) => {
          if (rows && (job.summary as CleanupSummary | null)?.project.id === projectId) void load();
        }}
      />
    </Space>
  );
}

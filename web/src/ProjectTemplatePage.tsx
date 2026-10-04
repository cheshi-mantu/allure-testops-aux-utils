import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Checkbox, Collapse, Input, Modal, Radio, Select, Space, Switch, Table, Tag, Typography } from "antd";
import { api, errorText, type ActionKind, type Job, type Project, type TemplateInput, type TemplatePreview, type TemplateSection, type TemplateSummary } from "./api";
import { JobList } from "./JobPanel";

const KIND: Record<ActionKind, { color: string; label: string }> = {
  create: { color: "green", label: "create" },
  update: { color: "blue", label: "update" },
  remove: { color: "red", label: "remove" },
  skip: { color: "default", label: "same" },
  manual: { color: "orange", label: "by hand" },
};
const KINDS: ActionKind[] = ["create", "update", "remove", "manual", "skip"];

function Counts({ counts }: { counts: Partial<Record<ActionKind, number>> }) {
  return (
    <Space size={2} wrap>
      {KINDS.filter((k) => counts[k]).map((k) => (
        <Tag key={k} color={KIND[k].color} style={{ marginInlineEnd: 0 }}>
          {KIND[k].label} {counts[k]}
        </Tag>
      ))}
    </Space>
  );
}

function countActions(actions: { kind: ActionKind }[]): Partial<Record<ActionKind, number>> {
  const counts: Partial<Record<ActionKind, number>> = {};
  for (const a of actions) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  return counts;
}

/** Per-section results of a template job, with a link to the project made. */
function TemplateJobSummary({ job }: { job: Job }) {
  const s = job.summary as TemplateSummary | null;
  if (!s) return null;
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      {s.targetProject && s.targetUrl && (
        <Typography.Text>
          Target:{" "}
          <a href={s.targetUrl} target="_blank" rel="noopener">
            {s.targetProject.name} ({s.targetProject.id})
          </a>
        </Typography.Text>
      )}
      <Table
        size="small"
        rowKey="key"
        pagination={false}
        dataSource={s.sections}
        columns={[
          { title: "Section", dataIndex: "label" },
          { title: "Actions", render: (_, r) => <Counts counts={r.counts} /> },
          {
            title: "Failed",
            width: 90,
            render: (_, r) => (r.error ? <Tag color="red">not read</Tag> : r.failed ? <Tag color="red">{r.failed}</Tag> : <Typography.Text type="secondary">0</Typography.Text>),
          },
        ]}
      />
    </Space>
  );
}

export function ProjectTemplatePage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [sections, setSections] = useState<TemplateSection[]>([]);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [abbr, setAbbr] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Job | null>(null);

  useEffect(() => {
    api.projects().then(setProjects, (e: unknown) => setError(errorText(e)));
    api.templateSections().then(
      (list) => {
        setSections(list);
        setChosen(list.map((s) => s.key));
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, []);

  const input = useMemo((): TemplateInput | null => {
    if (!sourceId || chosen.length === 0) return null;
    if (mode === "new") return name.trim() ? { sourceProjectId: sourceId, target: { mode, name, abbr, description, isPublic }, sections: chosen } : null;
    return targetId && targetId !== sourceId ? { sourceProjectId: sourceId, target: { mode, projectId: targetId }, sections: chosen } : null;
  }, [sourceId, mode, name, abbr, description, isPublic, targetId, chosen]);

  // A preview is for exactly these inputs.
  useEffect(() => setPreview(null), [input]);

  const runPreview = async () => {
    if (!input) return;
    setBusy("preview");
    try {
      setPreview(await api.previewTemplate(input));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const changes = preview ? preview.sections.flatMap((s) => s.actions).filter((a) => a.kind === "create" || a.kind === "update" || a.kind === "remove").length : 0;

  const apply = () => {
    if (!input || !preview) return;
    const targetName = input.target.mode === "new" ? `a new project "${input.target.name}"` : `"${preview.target?.name}"`;
    Modal.confirm({
      title: "Copy the configuration?",
      content: `The configuration of "${preview.source.name}" goes into ${targetName}: ${changes} changes as previewed${input.target.mode === "new" ? ", after creating the project" : ""}. This is done on behalf of the API token owner.`,
      okText: "Copy",
      onOk: async () => {
        setBusy("apply");
        try {
          setAdded(await api.startTemplate(input));
          setError(null);
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(null);
        }
      },
    });
  };

  const projectOptions = (projects ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.id})` }));

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%", maxWidth: 1200 }}>
      <div>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          Project as a template
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ maxWidth: 860 }}>
          Copies the configuration of a project, not its test cases or launches, into a new or an existing project: custom fields, environments,
          workflows, integrations, settings and the rest. Entries are matched by name or key: what is missing is created, what differs is updated.
          In a new project, the defaults Allure TestOps adds and the source does not have are removed; an existing project loses nothing. Running it
          again only does what is still left.
        </Typography.Paragraph>
      </div>

      {error && <Alert type="error" showIcon closable onClose={() => setError(null)} title={error} />}

      <Card title="1. Source and target">
        <Space orientation="vertical" size="middle" style={{ width: "100%", maxWidth: 720 }}>
          <div>
            <Typography.Text strong>Source project</Typography.Text>
            <Select<number>
              showSearch={{ optionFilterProp: "label" }}
              placeholder="The project to copy from"
              loading={!projects}
              value={sourceId ?? undefined}
              onChange={setSourceId}
              options={projectOptions}
              style={{ width: "100%", marginTop: 4 }}
            />
          </div>
          <Radio.Group value={mode} onChange={(e) => setMode(e.target.value as "new" | "existing")}>
            <Radio value="new">New project</Radio>
            <Radio value="existing">Existing project</Radio>
          </Radio.Group>
          {mode === "new" ? (
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Space wrap>
                <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} style={{ width: 380 }} />
                <Input placeholder="Abbreviation" value={abbr} onChange={(e) => setAbbr(e.target.value)} maxLength={2} style={{ width: 120 }} />
                <Space>
                  <Switch checked={isPublic} onChange={setIsPublic} />
                  <Typography.Text>Public</Typography.Text>
                </Space>
              </Space>
              <Input.TextArea placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} autoSize={{ minRows: 1, maxRows: 4 }} />
            </Space>
          ) : (
            <Select<number>
              showSearch={{ optionFilterProp: "label" }}
              placeholder="The project to copy into"
              value={targetId ?? undefined}
              onChange={setTargetId}
              options={projectOptions.filter((o) => o.value !== sourceId)}
              style={{ width: "100%" }}
            />
          )}
        </Space>
      </Card>

      <Card
        title="2. What to copy"
        extra={
          <Space>
            <Button size="small" onClick={() => setChosen(sections.map((s) => s.key))}>
              All
            </Button>
            <Button size="small" onClick={() => setChosen([])}>
              None
            </Button>
          </Space>
        }
      >
        <Checkbox.Group value={chosen} onChange={(v) => setChosen(v as string[])} style={{ width: "100%" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
            {sections.map((s) => (
              <Checkbox key={s.key} value={s.key}>
                <Typography.Text strong>{s.label}</Typography.Text>
                <br />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {s.description}
                </Typography.Text>
              </Checkbox>
            ))}
          </div>
        </Checkbox.Group>
      </Card>

      <Card
        title="3. Preview and copy"
        extra={
          preview && (
            <Space>
              <Switch size="small" checked={onlyChanges} onChange={setOnlyChanges} />
              <Typography.Text>Only changes</Typography.Text>
            </Space>
          )
        }
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Space wrap>
            <Button onClick={runPreview} loading={busy === "preview"} disabled={!input}>
              Preview
            </Button>
            <Button type="primary" onClick={apply} loading={busy === "apply"} disabled={!preview}>
              Copy
            </Button>
            <Typography.Text type="secondary">
              {!input ? "Choose the source, the target and at least one section" : !preview ? "Preview first: it reads both projects and changes nothing" : `${changes} changes`}
            </Typography.Text>
          </Space>
          {preview?.warnings.map((w) => <Alert key={w} type="info" showIcon title={w} />)}
          {preview && (
            <Collapse
              items={preview.sections.map((s) => {
                const shown = onlyChanges ? s.actions.filter((a) => a.kind !== "skip") : s.actions;
                return {
                  key: s.key,
                  label: (
                    <Space wrap>
                      <Typography.Text strong>{s.label}</Typography.Text>
                      {s.error ? <Tag color="red">cannot be read</Tag> : s.actions.length ? <Counts counts={countActions(s.actions)} /> : <Typography.Text type="secondary">nothing to copy</Typography.Text>}
                    </Space>
                  ),
                  children: s.error ? (
                    <Alert type="error" showIcon title={s.error} />
                  ) : (
                    <Table
                      size="small"
                      rowKey={(a) => `${a.kind}:${a.name}`}
                      pagination={shown.length > 20 ? { pageSize: 20 } : false}
                      dataSource={shown}
                      locale={{ emptyText: "Nothing changes" }}
                      columns={[
                        { title: "", dataIndex: "kind", width: 90, render: (k: ActionKind) => <Tag color={KIND[k].color}>{KIND[k].label}</Tag> },
                        { title: "What", dataIndex: "name" },
                        { title: "Details", dataIndex: "detail", render: (d: string | null) => <Typography.Text type="secondary">{d}</Typography.Text> },
                      ]}
                    />
                  ),
                };
              })}
            />
          )}
        </Space>
      </Card>

      <JobList kind="project-template" added={added} summary={(job) => <TemplateJobSummary job={job} />} />
    </Space>
  );
}

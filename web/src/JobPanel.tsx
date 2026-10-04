import { useEffect, useState } from "react";
import { Alert, Button, Card, Collapse, Progress, Space, Tag, Typography } from "antd";
import { DeleteOutlined, DownloadOutlined, ExportOutlined, StopOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api, errorText, formatSize, type Job, type JobState } from "./api";

const POLL_MS = 1000;

const STATE_TAG: Record<JobState, { color: string; label: string }> = {
  running: { color: "processing", label: "Running" },
  done: { color: "success", label: "Done" },
  failed: { color: "error", label: "Failed" },
  cancelled: { color: "default", label: "Cancelled" },
};

/** Files a browser shows by itself; others are only downloaded. */
const viewable = (contentType: string) => contentType.startsWith("text/html") || contentType === "application/pdf";

/** Polls a job while it runs; offers its files once it is done. */
export function JobPanel({ initial, onDeleted }: { initial: Job; onDeleted: (id: string) => void }) {
  const [job, setJob] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (job.state !== "running") return;
    const timer = setTimeout(() => {
      api.job(job.id).then(
        (j) => {
          setJob(j);
          setError(null);
        },
        (e: unknown) => setError(errorText(e)),
      );
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [job]);

  const act = (fn: () => Promise<unknown>) => fn().catch((e: unknown) => setError(errorText(e)));
  const tag = STATE_TAG[job.state];
  const percent = job.total ? Math.round((job.done / job.total) * 100) : undefined;
  const elapsed = ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000;

  return (
    <Card
      size="small"
      title={
        <Space>
          {job.title}
          <Tag color={tag.color}>{tag.label}</Tag>
          <Typography.Text type="secondary" style={{ fontWeight: "normal" }}>
            {dayjs(job.startedAt).format("YYYY-MM-DD HH:mm:ss")}, {elapsed < 60 ? `${Math.round(elapsed)} s` : `${Math.floor(elapsed / 60)} min ${Math.round(elapsed % 60)} s`}
          </Typography.Text>
        </Space>
      }
      extra={
        <Space>
          {job.state === "running" && (
            <Button icon={<StopOutlined />} onClick={() => act(() => api.cancelJob(job.id).then(setJob))}>
              Cancel
            </Button>
          )}
          {job.state !== "running" && (
            <Button icon={<DeleteOutlined />} title="Delete the job and its files" onClick={() => act(() => api.deleteJob(job.id).then(() => onDeleted(job.id)))} />
          )}
        </Space>
      }
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        {job.state === "running" && (
          <div>
            <Typography.Text>
              {job.phase}
              {job.total > 0 && ` ${job.done} / ${job.total}`}
            </Typography.Text>
            <Progress percent={percent} status="active" showInfo={percent !== undefined} />
          </div>
        )}
        {job.state === "done" &&
          job.files.map((f, i) => (
            <div key={f.name} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Typography.Text style={{ minWidth: 0, flex: "1 1 240px" }} ellipsis={{ tooltip: f.name }}>
                {f.name}
              </Typography.Text>
              {viewable(f.contentType) && (
                <Button size="small" icon={<ExportOutlined />} href={api.jobFileUrl(job.id, i, true)} target="_blank" rel="noopener">
                  Open
                </Button>
              )}
              <Button size="small" type="primary" icon={<DownloadOutlined />} href={api.jobFileUrl(job.id, i)}>
                Download {formatSize(f.size)}
              </Button>
            </div>
          ))}
        {job.error && <Alert type="error" showIcon title={job.error} />}
        {error && <Alert type="warning" showIcon title={error} />}
        {job.warnings.length > 0 && (
          <Alert
            type="warning"
            showIcon
            title={`${job.warnings.length} warning${job.warnings.length > 1 ? "s" : ""}`}
            description={<pre className="job-log">{job.warnings.join("\n")}</pre>}
          />
        )}
        <Collapse size="small" ghost items={[{ key: "log", label: "Log", children: <pre className="job-log">{job.log.join("\n")}</pre> }]} />
      </Space>
    </Card>
  );
}

/** Jobs of one kind, newest first; `added` puts a just started job on top. */
export function JobList({ kind, added }: { kind: string; added: Job | null }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.jobs(kind).then(setJobs, (e: unknown) => setError(errorText(e)));
  }, [kind]);

  useEffect(() => {
    if (added) setJobs((list) => [added, ...list.filter((j) => j.id !== added.id)]);
  }, [added]);

  if (error) return <Alert type="error" showIcon title={error} />;
  if (jobs.length === 0) return null;
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      {jobs.map((j) => (
        <JobPanel key={j.id} initial={j} onDeleted={(id) => setJobs((list) => list.filter((x) => x.id !== id))} />
      ))}
    </Space>
  );
}

import { useState } from "react";
import { Alert, Button, Card, Checkbox, Form, InputNumber, Space, Switch, Typography } from "antd";
import { api, errorText, type DocumentStatus, type Job, type LaunchDocumentInput, type LaunchRow } from "./api";
import { JobList } from "./JobPanel";
import { LaunchPicker } from "./LaunchPicker";

type Options = Omit<LaunchDocumentInput, "launchId">;

const DEFAULT_OPTIONS: Options = {
  statuses: [],
  includeRetries: false,
  embedAttachments: true,
  maxAttachmentMb: 2,
  maxTotalAttachmentMb: 200,
};

const STATUS_OPTIONS: { value: DocumentStatus; label: string }[] = [
  { value: "failed", label: "Failed" },
  { value: "broken", label: "Broken" },
  { value: "unknown", label: "Unknown" },
  { value: "skipped", label: "Skipped" },
  { value: "passed", label: "Passed" },
  { value: "in_progress", label: "In progress" },
];

export function LaunchDocumentPage() {
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LaunchRow | null>(null);
  const [form] = Form.useForm<Options>();
  const embed = Form.useWatch("embedAttachments", form);
  const [starting, setStarting] = useState(false);
  const [added, setAdded] = useState<Job | null>(null);

  const start = async (options: Options) => {
    if (!selected) return;
    setStarting(true);
    try {
      setAdded(await api.startLaunchDocument({ ...options, launchId: selected.id }));
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
          Launch → HTML document
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ maxWidth: 820 }}>
          Writes the test results of one launch as one long HTML page for reading and printing to PDF: launch attributes and job runs, contents grouped
          by status, then every test result with its custom fields, description, scenario steps, errors and attachments. Collapsed sections open by
          themselves when the page is printed.
        </Typography.Paragraph>
      </div>

      {error && <Alert type="error" showIcon closable onClose={() => setError(null)} title={error} />}

      <LaunchPicker selected={selected} onSelect={setSelected} />

      <Card title="2. Document">
        <Form<Options> form={form} layout="vertical" initialValues={DEFAULT_OPTIONS} onFinish={start} style={{ maxWidth: 820 }}>
          <Form.Item name="statuses" label="Test results" extra="None ticked means all statuses.">
            <Checkbox.Group options={STATUS_OPTIONS} />
          </Form.Item>
          <Space size="large" wrap align="start">
            <Form.Item name="includeRetries" label="Earlier retries" valuePropName="checked" tooltip="Earlier attempts of retried tests, as separate test results">
              <Switch />
            </Form.Item>
            <Form.Item
              name="embedAttachments"
              label="Embed attachments"
              valuePropName="checked"
              tooltip="Images and text attachments are embedded in the page; other types are listed by name and size"
            >
              <Switch />
            </Form.Item>
            <Form.Item name="maxAttachmentMb" label="Embed attachments up to" tooltip="Larger ones are listed only. 0 means no limit">
              <InputNumber min={0} max={1024} addonAfter="MB" disabled={!embed} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="maxTotalAttachmentMb" label="Embed at most" tooltip="In total; once reached, further attachments are listed only. 0 means no limit">
              <InputNumber min={0} max={10240} addonAfter="MB" disabled={!embed} style={{ width: 150 }} />
            </Form.Item>
          </Space>
          <Space>
            <Button type="primary" htmlType="submit" loading={starting} disabled={!selected}>
              Build document
            </Button>
            <Typography.Text type="secondary">{selected ? `Launch ${selected.id}: ${selected.name}` : "Choose a launch above"}</Typography.Text>
          </Space>
        </Form>
      </Card>

      <JobList kind="launch-document" added={added} />
    </Space>
  );
}

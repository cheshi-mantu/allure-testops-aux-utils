import { useState } from "react";
import { Alert, Button, Card, Form, Input, InputNumber, Select, Space, Switch, Typography } from "antd";
import { api, errorText, type GroupBy, type Job, type LaunchReportInput, type LaunchRow, type Theme } from "./api";
import { JobList } from "./JobPanel";
import { LaunchPicker } from "./LaunchPicker";

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

export function LaunchReportPage() {
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LaunchRow | null>(null);
  const [form] = Form.useForm<Options>();
  const includeAttachments = Form.useWatch("includeAttachments", form);
  const [starting, setStarting] = useState(false);
  const [added, setAdded] = useState<Job | null>(null);

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

      <LaunchPicker selected={selected} onSelect={setSelected} />

      <Card title="2. Report">
        <Form<Options> form={form} layout="vertical" initialValues={DEFAULT_OPTIONS} onFinish={start} style={{ maxWidth: 720 }}>
          <Form.Item name="reportName" label="Report name">
            <Input placeholder={selected ? selected.name : "The launch name"} allowClear />
          </Form.Item>
          <Form.Item
            name="groupBy"
            label="Group test results by"
            extra="Custom fields named like Allure labels (Suite, Parent Suite, Epic, Feature, Story, Package…) are used for grouping."
          >
            <Select options={GROUP_BY_OPTIONS} />
          </Form.Item>
          <Space size="large" wrap align="start">
            <Form.Item
              name="includeRetries"
              label="Retries"
              valuePropName="checked"
              tooltip="Earlier attempts of retried tests, shown on the Retries tab of a test"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name="includeAttachments"
              label="Attachments"
              valuePropName="checked"
              tooltip="Attachments are embedded in the HTML file and make it bigger"
            >
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

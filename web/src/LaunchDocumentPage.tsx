import { useMemo, useState } from "react";
import { Alert, Button, Card, Checkbox, Form, InputNumber, Space, Switch, Typography } from "antd";
import { api, errorText, type DocumentSection, type DocumentStatus, type Job, type LaunchDocumentInput, type LaunchRow } from "./api";
import { JobList } from "./JobPanel";
import { LaunchPicker } from "./LaunchPicker";

/** In the form the sections are a list of ticked boxes. */
type FormValues = Omit<LaunchDocumentInput, "launchId" | "sections"> & { sections: DocumentSection[] };

const STORAGE_KEY = "launchDocument.options";

const SECTION_OPTIONS: { value: DocumentSection; label: string }[] = [
  { value: "scenario", label: "Scenario" },
  { value: "customFields", label: "Custom fields" },
  { value: "environment", label: "Environment variables" },
  { value: "attachments", label: "Attachments" },
];

const DEFAULT_OPTIONS: FormValues = {
  statuses: [],
  sections: SECTION_OPTIONS.map((o) => o.value),
  includeRetries: false,
  embedAttachments: true,
  maxAttachmentMb: 2,
  maxTotalAttachmentMb: 200,
  pdf: true,
};

const STATUS_OPTIONS: { value: DocumentStatus; label: string }[] = [
  { value: "failed", label: "Failed" },
  { value: "broken", label: "Broken" },
  { value: "unknown", label: "Unknown" },
  { value: "skipped", label: "Skipped" },
  { value: "passed", label: "Passed" },
  { value: "in_progress", label: "In progress" },
];

/** The options used last time in this browser. */
function storedOptions(): FormValues {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<FormValues> | null;
    return { ...DEFAULT_OPTIONS, ...(stored ?? {}) };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

export function LaunchDocumentPage() {
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LaunchRow | null>(null);
  const initial = useMemo(storedOptions, []);
  const [form] = Form.useForm<FormValues>();
  const embed = Form.useWatch("embedAttachments", form);
  const sections = Form.useWatch("sections", form) ?? initial.sections;
  const withAttachments = sections.includes("attachments");
  const [starting, setStarting] = useState(false);
  const [added, setAdded] = useState<Job | null>(null);

  const start = async (values: FormValues) => {
    if (!selected) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
    } catch {
      // Remembering the options is a convenience only.
    }
    setStarting(true);
    try {
      const ticked = new Set(values.sections);
      setAdded(
        await api.startLaunchDocument({
          ...values,
          launchId: selected.id,
          sections: {
            scenario: ticked.has("scenario"),
            customFields: ticked.has("customFields"),
            environment: ticked.has("environment"),
            attachments: ticked.has("attachments"),
          },
        }),
      );
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
          Writes the test results of one launch as one long HTML page and, if wanted, a PDF: launch attributes and job runs, contents grouped
          by status, then every test result on its own page with the sections chosen below.
        </Typography.Paragraph>
      </div>

      {error && <Alert type="error" showIcon closable onClose={() => setError(null)} title={error} />}

      <LaunchPicker selected={selected} onSelect={setSelected} />

      <Card title="2. Document">
        <Form<FormValues> form={form} layout="vertical" initialValues={initial} onFinish={start} style={{ maxWidth: 820 }}>
          <Form.Item name="statuses" label="Test results" extra="None ticked means all statuses.">
            <Checkbox.Group options={STATUS_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="sections"
            label="For every test result include"
            extra="Name, status, links to Allure TestOps, error, description, members, tags and parameters are always there, and so is the assignee of a manual test. Sections left out are not read from Allure TestOps, which makes the export faster."
          >
            <Checkbox.Group options={SECTION_OPTIONS} />
          </Form.Item>
          <Space size="large" wrap align="start">
            <Form.Item
              name="pdf"
              label="PDF"
              valuePropName="checked"
              tooltip="A PDF next to the HTML page: each test result on its own page, bookmarks and page numbers. Long text attachments are cut in the PDF; PNG and JPEG images are embedded"
            >
              <Switch />
            </Form.Item>
            <Form.Item name="includeRetries" label="Earlier retries" valuePropName="checked" tooltip="Earlier attempts of retried tests, as separate test results">
              <Switch />
            </Form.Item>
            <Form.Item
              name="embedAttachments"
              label="Embed attachments"
              valuePropName="checked"
              tooltip="Images and text attachments are embedded; other types are listed by name and size"
            >
              <Switch disabled={!withAttachments} />
            </Form.Item>
            <Form.Item name="maxAttachmentMb" label="Embed attachments up to" tooltip="Larger ones are listed only. 0 means no limit">
              <InputNumber min={0} max={1024} addonAfter="MB" disabled={!embed || !withAttachments} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="maxTotalAttachmentMb" label="Embed at most" tooltip="In total; once reached, further attachments are listed only. 0 means no limit">
              <InputNumber min={0} max={10240} addonAfter="MB" disabled={!embed || !withAttachments} style={{ width: 150 }} />
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

import { useState } from "react";
import { Alert, Button, Card, Form, Input, Space, message } from "antd";
import { api, errorText, type PublicConfig } from "./api";

type FormValues = { endpoint: string; token: string };

export function SettingsPage({ config, onSaved }: { config: PublicConfig; onSaved: (c: PublicConfig) => void }) {
  const [form] = Form.useForm<FormValues>();
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [msg, holder] = message.useMessage();

  const test = async () => {
    const { endpoint, token } = await form.validateFields(["endpoint", "token"]);
    setBusy("test");
    try {
      const r = await api.testConfig({ endpoint, token: token ?? "" });
      msg.success(`Connection works, projects available: ${r.projects}`);
    } catch (e) {
      msg.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async (v: FormValues) => {
    setBusy("save");
    try {
      const saved = await api.saveConfig({ endpoint: v.endpoint, token: v.token ?? "" });
      form.setFieldValue("token", "");
      msg.success("Settings saved");
      onSaved(saved);
    } catch (e) {
      msg.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Allure TestOps connection" style={{ maxWidth: 720 }}>
      {holder}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="Settings are stored on the application server. The token is never sent back to the browser. The tools act on behalf of the token owner."
      />
      <Form<FormValues> form={form} layout="vertical" onFinish={save} initialValues={{ endpoint: config.endpoint, token: "" }}>
        <Form.Item
          name="endpoint"
          label="Allure TestOps endpoint"
          rules={[{ required: true, type: "url", message: "Enter a URL, e.g. https://testops.example.com" }]}
        >
          <Input placeholder="https://testops.example.com" />
        </Form.Item>
        <Form.Item
          name="token"
          label="API token"
          extra={config.tokenSet ? `Token ${config.tokenHint} is saved. Leave the field empty to keep it.` : "Allure TestOps user profile → API tokens"}
          rules={[{ required: !config.tokenSet, message: "Enter an API token" }]}
        >
          <Input.Password placeholder={config.tokenSet ? "••••••••" : ""} autoComplete="off" />
        </Form.Item>
        <Space>
          <Button onClick={test} loading={busy === "test"}>
            Test connection
          </Button>
          <Button type="primary" htmlType="submit" loading={busy === "save"}>
            Save
          </Button>
        </Space>
      </Form>
    </Card>
  );
}

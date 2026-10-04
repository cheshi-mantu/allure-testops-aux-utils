import { useEffect, useState, type ReactNode } from "react";
import { Alert, Layout, Menu, Spin, Typography } from "antd";
import { FileTextOutlined, ProfileOutlined, SettingOutlined } from "@ant-design/icons";
import { api, errorText, type PublicConfig } from "./api";
import { LaunchDocumentPage } from "./LaunchDocumentPage";
import { LaunchReportPage } from "./LaunchReportPage";
import { SettingsPage } from "./SettingsPage";

/** A tool shown in the side menu. New tools are added here. */
interface Tool {
  key: string;
  group: string;
  label: string;
  icon: ReactNode;
  render: () => ReactNode;
}

const TOOLS: Tool[] = [
  { key: "launch-report", group: "Export", label: "Launch → Allure Report", icon: <FileTextOutlined />, render: () => <LaunchReportPage /> },
  { key: "launch-document", group: "Export", label: "Launch → HTML document", icon: <ProfileOutlined />, render: () => <LaunchDocumentPage /> },
];

const SETTINGS = "settings";

function initialKey(): string {
  const hash = window.location.hash.slice(1);
  return TOOLS.some((t) => t.key === hash) || hash === SETTINGS ? hash : TOOLS[0].key;
}

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(initialKey);
  // Remounting the tools after a connection change drops stale state.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    api
      .getConfig()
      .then((c) => {
        setConfig(c);
        if (!c.tokenSet || !c.endpoint) setKey(SETTINGS);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    window.history.replaceState(null, "", `#${key}`);
  }, [key]);

  const configured = Boolean(config?.endpoint && config.tokenSet);

  const onSaved = (next: PublicConfig) => {
    const reconnect = !configured || next.endpoint !== config?.endpoint || next.tokenHint !== config?.tokenHint;
    setConfig(next);
    if (reconnect) {
      setGeneration((g) => g + 1);
      setKey(TOOLS[0].key);
    }
  };

  const groups = [...new Set(TOOLS.map((t) => t.group))];
  const tool = TOOLS.find((t) => t.key === key);

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Header style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Typography.Title level={4} style={{ color: "#fff", margin: 0, whiteSpace: "nowrap" }}>
          Allure TestOps Aux Utils
        </Typography.Title>
        {config?.endpoint && (
          <Typography.Text ellipsis style={{ color: "rgba(255,255,255,0.65)" }}>
            {config.endpoint}
          </Typography.Text>
        )}
      </Layout.Header>
      <Layout>
        <Layout.Sider width={240} theme="light" breakpoint="lg" collapsedWidth={0}>
          <Menu
            mode="inline"
            selectedKeys={[key]}
            onClick={(e) => setKey(e.key)}
            style={{ height: "100%", paddingTop: 8 }}
            items={[
              ...groups.map((g) => ({
                type: "group" as const,
                key: `group-${g}`,
                label: g,
                children: TOOLS.filter((t) => t.group === g).map((t) => ({ key: t.key, icon: t.icon, label: t.label, disabled: !configured })),
              })),
              { type: "divider" as const },
              { key: SETTINGS, icon: <SettingOutlined />, label: "Settings" },
            ]}
          />
        </Layout.Sider>
        <Layout.Content style={{ padding: 24, minWidth: 0 }}>
          {error && <Alert type="error" showIcon title={`Application server is unavailable: ${error}`} />}
          {!config && !error && <Spin style={{ marginTop: 48, width: "100%" }} />}
          {config && key === SETTINGS && <SettingsPage key={generation} config={config} onSaved={onSaved} />}
          {config && configured && tool && <div key={`${tool.key}-${generation}`}>{tool.render()}</div>}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

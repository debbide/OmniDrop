import {
  CloudUploadOutlined,
  DashboardOutlined,
  LogoutOutlined,
  PlusOutlined,
  SettingOutlined,
  ClusterOutlined,
  UnorderedListOutlined,
  DatabaseOutlined,
} from "@ant-design/icons";
import { Layout, Menu, Button, Typography, Space, theme } from "antd";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

const { Header, Sider, Content } = Layout;

export function AppLayout() {
  const loc = useLocation();
  const nav = useNavigate();
  const { user, logout } = useAuth();
  const { token } = theme.useToken();

  const selected = loc.pathname.startsWith("/targets")
    ? "/targets"
    : loc.pathname.startsWith("/artifacts")
      ? "/artifacts"
      : loc.pathname.startsWith("/jobs/new")
        ? "/jobs/new"
        : loc.pathname.startsWith("/jobs")
          ? "/jobs"
          : loc.pathname.startsWith("/settings")
            ? "/settings"
            : "/";

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider breakpoint="lg" collapsedWidth={64} theme="dark">
        <div style={{ padding: "16px 16px 8px" }}>
          <div className="brand-mark">
            <CloudUploadOutlined />
            OmniDrop
          </div>
          <Typography.Text style={{ color: "rgba(255,255,255,0.45)", fontSize: 12 }}>
            万能空投
          </Typography.Text>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          onClick={({ key }) => nav(key)}
          items={[
            { key: "/", icon: <DashboardOutlined />, label: "总览" },
            { key: "/artifacts", icon: <DatabaseOutlined />, label: "产物库" },
            { key: "/targets", icon: <ClusterOutlined />, label: "目标管理" },
            { key: "/jobs", icon: <UnorderedListOutlined />, label: "任务列表" },
            { key: "/jobs/new", icon: <PlusOutlined />, label: "新建投递" },
            { key: "/settings", icon: <SettingOutlined />, label: "设置" },
          ]}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: token.colorBgContainer,
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            paddingInline: 24,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Space>
            <Typography.Text type="secondary">{user?.username}</Typography.Text>
            <Button
              icon={<LogoutOutlined />}
              onClick={async () => {
                await logout();
                nav("/login");
              }}
            >
              退出
            </Button>
          </Space>
        </Header>
        <Content style={{ margin: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

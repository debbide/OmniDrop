import { App, Button, Card, Form, Input, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../hooks/useAuth";

export function LoginPage() {
  const { message } = App.useApp();
  const nav = useNavigate();
  const { refresh, setUser } = useAuth();

  return (
    <div className="auth-shell">
      <Card className="auth-card" title="登录 OmniDrop">
        <Typography.Paragraph type="secondary">
          多协议产物发布平台 · 万能空投
        </Typography.Paragraph>
        <Form
          layout="vertical"
          onFinish={async (values) => {
            try {
              const res = await api.post("/auth/login", values);
              setUser({ id: "me", username: res.data.username });
              await refresh();
              message.success("登录成功");
              nav("/");
            } catch (err) {
              message.error(err instanceof Error ? err.message : "登录失败");
            }
          }}
        >
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true }]}
          >
            <Input autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true }]}
          >
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}

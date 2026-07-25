import { App, Button, Card, Form, Input, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../hooks/useAuth";

export function SetupPage() {
  const { message } = App.useApp();
  const nav = useNavigate();
  const { refresh } = useAuth();

  return (
    <div className="auth-shell">
      <Card className="auth-card" title="初始化管理员">
        <Typography.Paragraph type="secondary">
          首次启动需要创建管理员账号。密码至少 10 位。
        </Typography.Paragraph>
        <Form
          layout="vertical"
          onFinish={async (values) => {
            try {
              await api.post("/auth/setup", values);
              await refresh();
              message.success("初始化完成");
              nav("/");
            } catch (err) {
              message.error(err instanceof Error ? err.message : "初始化失败");
            }
          }}
        >
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, min: 3 }]}
          >
            <Input autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, min: 10 }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认密码"
            dependencies={["password"]}
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue("password") === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error("两次密码不一致"));
                },
              }),
            ]}
          >
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            创建管理员
          </Button>
        </Form>
      </Card>
    </div>
  );
}

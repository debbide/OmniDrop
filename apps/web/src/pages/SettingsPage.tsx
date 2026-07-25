import {
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useState } from "react";
import { api } from "../api/client";

export function SettingsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [pwdForm] = Form.useForm();
  const [tokenForm] = Form.useForm();
  const [newToken, setNewToken] = useState<string | null>(null);

  const { isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const data = (await api.get("/settings")).data;
      form.setFieldsValue(data);
      return data;
    },
  });

  const { data: sessions } = useQuery({
    queryKey: ["sessions"],
    queryFn: async () =>
      (await api.get<{ items: Array<Record<string, unknown>> }>("/auth/sessions"))
        .data.items,
  });

  const { data: apiTokens } = useQuery({
    queryKey: ["api-tokens"],
    queryFn: async () =>
      (
        await api.get<{ items: Array<Record<string, unknown>> }>(
          "/auth/api-tokens",
        )
      ).data.items,
  });

  const saveMut = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.put("/settings", values),
    onSuccess: async () => {
      message.success("设置已保存");
      await qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const pwdMut = useMutation({
    mutationFn: (values: Record<string, string>) =>
      api.post("/auth/change-password", values),
    onSuccess: () => {
      message.success("密码已修改，请重新登录");
      pwdForm.resetFields();
      window.location.href = "/login";
    },
    onError: (err: Error) => message.error(err.message),
  });

  const revokeSession = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: async () => {
      message.success("会话已吊销");
      await qc.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const revokeAll = useMutation({
    mutationFn: () => api.delete("/auth/sessions"),
    onSuccess: async () => {
      message.success("已吊销其他会话");
      await qc.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const createToken = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.post("/auth/api-tokens", values),
    onSuccess: async (res) => {
      setNewToken(res.data.token as string);
      tokenForm.resetFields();
      await qc.invalidateQueries({ queryKey: ["api-tokens"] });
      message.success("Token 已创建（仅显示一次）");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const revokeToken = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/api-tokens/${id}`),
    onSuccess: async () => {
      message.success("Token 已撤销");
      await qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        设置
      </Typography.Title>

      <div className="page-card" style={{ maxWidth: 640, marginBottom: 16 }}>
        <Typography.Title level={5}>运行参数</Typography.Title>
        <Form
          form={form}
          layout="vertical"
          disabled={isLoading}
          onFinish={(v) => saveMut.mutate(v)}
        >
          <Form.Item name="maxDownloadConcurrency" label="下载并发">
            <InputNumber min={1} max={20} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="maxUploadConcurrency" label="上传并发">
            <InputNumber min={1} max={20} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="jobTmpTtlMinutes" label="临时文件保留（分钟）">
            <InputNumber min={5} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="githubToken" label="GitHub Token（可选）">
            <Input.Password placeholder="留空表示不修改" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={saveMut.isPending}>
            保存
          </Button>
        </Form>
      </div>

      <div className="page-card" style={{ maxWidth: 640, marginBottom: 16 }}>
        <Typography.Title level={5}>修改密码</Typography.Title>
        <Typography.Paragraph type="secondary">
          修改后将吊销全部会话，需重新登录。
        </Typography.Paragraph>
        <Form form={pwdForm} layout="vertical" onFinish={(v) => pwdMut.mutate(v)}>
          <Form.Item
            name="currentPassword"
            label="当前密码"
            rules={[{ required: true }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[{ required: true, min: 10 }]}
          >
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={pwdMut.isPending}>
            修改密码
          </Button>
        </Form>
      </div>

      <div className="page-card" style={{ marginBottom: 16 }}>
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            活跃会话
          </Typography.Title>
          <Popconfirm title="吊销除当前外的所有会话？" onConfirm={() => revokeAll.mutate()}>
            <Button size="small">吊销其他会话</Button>
          </Popconfirm>
        </Space>
        <Table
          style={{ marginTop: 12 }}
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={sessions ?? []}
          columns={[
            {
              title: "状态",
              render: (_, r) =>
                r.current ? <Tag color="blue">当前</Tag> : <Tag>其他</Tag>,
            },
            {
              title: "IP",
              dataIndex: "ip",
              render: (v) => v || "-",
            },
            {
              title: "User-Agent",
              dataIndex: "userAgent",
              ellipsis: true,
              render: (v) => v || "-",
            },
            {
              title: "创建",
              dataIndex: "createdAt",
              render: (t) => dayjs(t as number).format("MM-DD HH:mm"),
            },
            {
              title: "操作",
              render: (_, r) => (
                <Button
                  size="small"
                  danger
                  disabled={!!r.current}
                  onClick={() => revokeSession.mutate(String(r.id))}
                >
                  吊销
                </Button>
              ),
            },
          ]}
        />
      </div>

      <div className="page-card">
        <Typography.Title level={5}>API Token（CI / 机器访问）</Typography.Title>
        {newToken && (
          <div style={{ marginBottom: 12 }}>
            <Typography.Text type="warning">
              新 Token 仅显示一次，请立即复制：
            </Typography.Text>
            <Input.TextArea value={newToken} readOnly rows={2} className="mono" />
            <Button
              size="small"
              style={{ marginTop: 8 }}
              onClick={async () => {
                await navigator.clipboard.writeText(newToken);
                message.success("已复制");
              }}
            >
              复制
            </Button>
          </div>
        )}
        <Form
          form={tokenForm}
          layout="inline"
          style={{ marginBottom: 16 }}
          initialValues={{
            scopes: ["jobs:write", "artifacts:read"],
          }}
          onFinish={(v) => createToken.mutate(v)}
        >
          <Form.Item name="name" rules={[{ required: true }]}>
            <Input placeholder="名称" />
          </Form.Item>
          <Form.Item name="scopes" rules={[{ required: true }]}>
            <Select
              mode="multiple"
              style={{ minWidth: 280 }}
              options={[
                "jobs:read",
                "jobs:write",
                "artifacts:read",
                "artifacts:write",
                "targets:read",
                "targets:write",
                "shares:write",
                "settings:read",
                "settings:write",
                "*",
              ].map((s) => ({ value: s, label: s }))}
            />
          </Form.Item>
          <Form.Item name="expiresInDays">
            <InputNumber min={1} placeholder="有效天数(空=永久)" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createToken.isPending}>
            创建
          </Button>
        </Form>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={apiTokens ?? []}
          columns={[
            { title: "名称", dataIndex: "name" },
            {
              title: "前缀",
              dataIndex: "tokenPrefix",
              render: (v) => <span className="mono">{v}…</span>,
            },
            {
              title: "Scopes",
              dataIndex: "scopes",
              render: (s: string[]) => s?.join(", "),
            },
            {
              title: "创建",
              dataIndex: "createdAt",
              render: (t) => dayjs(t as number).format("YYYY-MM-DD"),
            },
            {
              title: "操作",
              render: (_, r) => (
                <Popconfirm
                  title="撤销该 Token？"
                  onConfirm={() => revokeToken.mutate(String(r.id))}
                >
                  <Button size="small" danger>
                    撤销
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}

import { useState } from "react";
import {
  App,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useNavigate } from "react-router-dom";
import { api, type Target } from "../api/client";

export function TargetsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Target | null>(null);
  const [form] = Form.useForm();
  const type = Form.useWatch("type", form);

  const { data, isLoading } = useQuery({
    queryKey: ["targets"],
    queryFn: async () =>
      (await api.get<{ items: Target[] }>("/targets")).data.items,
  });

  const buildConfig = (values: Record<string, unknown>) => {
      switch (values.type) {
        case "sftp":
          return {
            host: values.host,
            port: values.port,
            username: values.username,
            remotePath: values.remotePath,
            authMethod: values.authMethod,
            hostKeyPolicy: values.hostKeyPolicy,
          };
        case "pterodactyl":
          return {
            panelUrl: values.panelUrl,
            serverId: values.serverId,
            remotePath: values.remotePath,
            createDirs: values.createDirs,
          };
        case "ftp":
          return {
            host: values.host,
            port: values.port,
            username: values.username,
            remotePath: values.remotePath,
            secure: values.secure,
            insecureTls: values.insecureTls,
          };
        case "webdav":
          return {
            url: values.url,
            username: values.username,
            remotePath: values.remotePath,
            vendor: values.vendor,
            authType: values.authType,
            insecureTls: values.insecureTls,
          };
        default:
          return {};
      }
    };

    const saveMut = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      if (editing) {
        const secret: Record<string, string> = {};
        if (values.password) secret.password = String(values.password);
        if (values.privateKey) secret.privateKey = String(values.privateKey);
        if (values.apiKey) secret.apiKey = String(values.apiKey);
        const body: Record<string, unknown> = {
          name: values.name,
          enabled: values.enabled,
          config: buildConfig(values),
        };
        if (Object.keys(secret).length) body.secret = secret;
        return api.patch(`/targets/${editing.id}`, body);
      }

      if (values.type === "sftp") {
        return api.post("/targets", {
          name: values.name,
          type: "sftp",
          enabled: values.enabled ?? true,
          config: {
            host: values.host,
            port: values.port ?? 22,
            username: values.username,
            remotePath: values.remotePath,
            authMethod: values.authMethod ?? "password",
            hostKeyPolicy: values.hostKeyPolicy ?? "accept-new",
          },
          secret: {
            password: values.password,
            privateKey: values.privateKey,
            passphrase: values.passphrase,
          },
        });
      }
      if (values.type === "ftp") {
        return api.post("/targets", {
          name: values.name,
          type: "ftp",
          enabled: values.enabled ?? true,
          config: {
            host: values.host,
            port: values.port ?? 21,
            username: values.username,
            remotePath: values.remotePath,
            secure: values.secure ?? "plain",
          },
          secret: { password: values.password },
        });
      }
      if (values.type === "webdav") {
        return api.post("/targets", {
          name: values.name,
          type: "webdav",
          enabled: values.enabled ?? true,
          config: {
            url: values.url,
            username: values.username,
            remotePath: values.remotePath,
            vendor: values.vendor ?? "other",
            authType: values.authType ?? "basic",
            insecureTls: values.insecureTls ?? false,
          },
          secret: {
            password: values.password,
            bearerToken: values.bearerToken,
          },
        });
      }
      return api.post("/targets", {
        name: values.name,
        type: "pterodactyl",
        enabled: values.enabled ?? true,
        config: {
          panelUrl: values.panelUrl,
          serverId: values.serverId,
          remotePath: values.remotePath,
          createDirs: values.createDirs ?? true,
        },
        secret: { apiKey: values.apiKey },
      });
    },
    onSuccess: async () => {
      message.success(editing ? "已更新" : "已创建");
      setOpen(false);
      setEditing(null);
      form.resetFields();
      await qc.invalidateQueries({ queryKey: ["targets"] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.delete(`/targets/${id}`),
    onSuccess: async () => {
      message.success("已删除");
      await qc.invalidateQueries({ queryKey: ["targets"] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const testMut = useMutation({
    mutationFn: (id: string) => api.post(`/targets/${id}/test`),
    onSuccess: () => message.info("已入队连通性测试，请查看 worker 日志"),
    onError: (err: Error) => message.error(err.message),
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      type: "sftp",
      enabled: true,
      port: 22,
      authMethod: "password",
      hostKeyPolicy: "accept-new",
      createDirs: true,
      secure: "plain",
      vendor: "other",
      authType: "basic",
      insecureTls: false,
      remotePath: "/",
    });
    setOpen(true);
  };

  const openEdit = (t: Target) => {
    setEditing(t);
    form.setFieldsValue({
      name: t.name,
      type: t.type,
      enabled: t.enabled,
      ...t.config,
      password: undefined,
      privateKey: undefined,
      apiKey: undefined,
    });
    setOpen(true);
  };

  return (
    <div>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          目标管理
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          添加目标
        </Button>
      </Space>

      <div className="page-card">
        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={data ?? []}
          columns={[
            { title: "名称", dataIndex: "name" },
            {
              title: "类型",
              dataIndex: "type",
              render: (t) => (
                <Tag color={t === "sftp" ? "geekblue" : "purple"}>{t}</Tag>
              ),
            },
            {
              title: "地址",
              render: (_, r) => {
                if (r.type === "sftp" || r.type === "ftp") {
                  return `${r.config.host as string}:${r.config.port as number}`;
                }
                if (r.type === "webdav") return String(r.config.url ?? "");
                return String(r.config.panelUrl ?? "");
              },
            },
            {
              title: "远端路径",
              render: (_, r) => String(r.config.remotePath ?? ""),
            },
            {
              title: "启用",
              dataIndex: "enabled",
              render: (v) => (v ? "是" : "否"),
            },
            {
              title: "更新",
              dataIndex: "updatedAt",
              render: (t) => dayjs(t).format("MM-DD HH:mm"),
            },
            {
              title: "操作",
              render: (_, r) => (
                <Space wrap>
                  <Button size="small" type="primary" onClick={() => nav(`/targets/${r.id}`)}>
                    浏览
                  </Button>
                  <Button size="small" onClick={() => openEdit(r)}>
                    编辑
                  </Button>
                  <Button size="small" onClick={() => testMut.mutate(r.id)}>
                    测试
                  </Button>
                  <Popconfirm
                    title="确认删除该目标？"
                    onConfirm={() => delMut.mutate(r.id)}
                  >
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </div>

      <Drawer
        title={editing ? "编辑目标" : "添加目标"}
        width={480}
        open={open}
        onClose={() => setOpen(false)}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => saveMut.mutate(v)}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select
              disabled={!!editing}
              options={[
                { value: "sftp", label: "SFTP" },
                { value: "ftp", label: "FTP" },
                { value: "webdav", label: "WebDAV" },
                { value: "pterodactyl", label: "翼龙 Pterodactyl" },
              ]}
            />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>

          {type === "sftp" && (
            <>
              <Form.Item name="host" label="主机" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="port" label="端口" rules={[{ required: true }]}>
                <InputNumber style={{ width: "100%" }} min={1} max={65535} />
              </Form.Item>
              <Form.Item
                name="username"
                label="用户名"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
              <Form.Item name="authMethod" label="认证方式">
                <Select
                  options={[
                    { value: "password", label: "密码" },
                    { value: "privateKey", label: "私钥" },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="password"
                label={editing ? "密码（留空不改）" : "密码"}
                rules={editing ? [] : [{ required: true }]}
              >
                <Input.Password />
              </Form.Item>
              <Form.Item name="privateKey" label="私钥 PEM（可选）">
                <Input.TextArea rows={4} />
              </Form.Item>
              <Form.Item name="hostKeyPolicy" label="Host Key 策略">
                <Select
                  options={[
                    { value: "accept-new", label: "accept-new（默认）" },
                    { value: "strict", label: "strict" },
                  ]}
                />
              </Form.Item>
            </>
          )}

          {type === "ftp" && (
            <>
              <Form.Item name="host" label="主机" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="port" label="端口" rules={[{ required: true }]}>
                <InputNumber style={{ width: "100%" }} min={1} max={65535} />
              </Form.Item>
              <Form.Item
                name="username"
                label="用户名"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
              <Form.Item name="secure" label="TLS">
                <Select
                  options={[
                    { value: "plain", label: "明文 FTP" },
                    { value: "explicit", label: "Explicit FTPS" },
                    { value: "implicit", label: "Implicit FTPS" },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="insecureTls"
                label="跳过证书校验（仅调试）"
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
              <Form.Item
                name="password"
                label={editing ? "密码（留空不改）" : "密码"}
                rules={editing ? [] : [{ required: true }]}
              >
                <Input.Password />
              </Form.Item>
            </>
          )}

          {type === "webdav" && (
            <>
              <Form.Item
                name="url"
                label="WebDAV URL"
                rules={[{ required: true, type: "url" }]}
              >
                <Input placeholder="https://dav.example.com/remote.php/dav" />
              </Form.Item>
              <Form.Item name="vendor" label="厂商">
                <Select
                  options={[
                    { value: "other", label: "other" },
                    { value: "nextcloud", label: "Nextcloud" },
                    { value: "owncloud", label: "ownCloud" },
                    { value: "sharepoint", label: "SharePoint" },
                  ]}
                />
              </Form.Item>
              <Form.Item name="authType" label="认证">
                <Select
                  options={[
                    { value: "basic", label: "Basic 用户名密码" },
                    { value: "bearer", label: "Bearer Token" },
                  ]}
                />
              </Form.Item>
              <Form.Item name="username" label="用户名">
                <Input />
              </Form.Item>
              <Form.Item
                name="password"
                label={editing ? "密码（留空不改）" : "密码"}
              >
                <Input.Password />
              </Form.Item>
              <Form.Item name="bearerToken" label="Bearer Token（可选）">
                <Input.Password />
              </Form.Item>
              <Form.Item
                name="insecureTls"
                label="跳过证书校验（仅调试）"
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
            </>
          )}

          {type === "pterodactyl" && (
            <>
              <Form.Item
                name="panelUrl"
                label="面板 URL"
                rules={[{ required: true, type: "url" }]}
              >
                <Input placeholder="https://panel.example.com" />
              </Form.Item>
              <Form.Item
                name="serverId"
                label="Server ID"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
              <Form.Item
                name="apiKey"
                label={editing ? "Client API Key（留空不改）" : "Client API Key"}
                rules={editing ? [] : [{ required: true }]}
              >
                <Input.Password />
              </Form.Item>
              <Form.Item name="createDirs" label="自动创建目录" valuePropName="checked">
                <Switch />
              </Form.Item>
            </>
          )}

          <Form.Item
            name="remotePath"
            label="远端路径"
            rules={[{ required: true }]}
          >
            <Input placeholder="/plugins" />
          </Form.Item>

          <Button type="primary" htmlType="submit" loading={saveMut.isPending} block>
            保存
          </Button>
        </Form>
      </Drawer>
    </div>
  );
}

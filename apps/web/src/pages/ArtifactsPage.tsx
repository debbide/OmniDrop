import { useState } from "react";
import {
  App,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from "antd";
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  LinkOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useNavigate } from "react-router-dom";
import { api, type Target } from "../api/client";

type Artifact = {
  id: string;
  fileName: string;
  sizeBytes: number;
  checksumSha256: string;
  sourceType: string | null;
  sourceUrl: string | null;
  createdAt: number;
};

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function ArtifactsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [shareArt, setShareArt] = useState<Artifact | null>(null);
  const [dispatchArt, setDispatchArt] = useState<Artifact | null>(null);
  const [renameArt, setRenameArt] = useState<Artifact | null>(null);
  const [shareForm] = Form.useForm();
  const [dispatchForm] = Form.useForm();
  const [renameForm] = Form.useForm();
  const [createdShareUrl, setCreatedShareUrl] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["artifacts"],
    queryFn: async () =>
      (
        await api.get<{
          items: Artifact[];
          total: number;
          totalBytes: number;
        }>("/artifacts")
      ).data,
  });

  const { data: targets } = useQuery({
    queryKey: ["targets"],
    queryFn: async () =>
      (await api.get<{ items: Target[] }>("/targets")).data.items,
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.delete(`/artifacts/${id}`),
    onSuccess: async () => {
      message.success("已删除");
      await qc.invalidateQueries({ queryKey: ["artifacts"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const renameMut = useMutation({
    mutationFn: ({ id, fileName }: { id: string; fileName: string }) =>
      api.patch(`/artifacts/${id}`, { fileName }),
    onSuccess: async () => {
      message.success("已重命名");
      setRenameArt(null);
      await qc.invalidateQueries({ queryKey: ["artifacts"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const shareMut = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.post(`/artifacts/${shareArt!.id}/shares`, values),
    onSuccess: (res) => {
      setCreatedShareUrl(res.data.url as string);
      message.success("分享链接已创建（仅显示一次，请复制）");
      void qc.invalidateQueries({ queryKey: ["artifacts"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const dispatchMut = useMutation({
    mutationFn: (values: { targetIds: string[] }) =>
      api.post(`/artifacts/${dispatchArt!.id}/dispatch`, {
        targetIds: values.targetIds,
        options: { overwrite: true },
      }),
    onSuccess: (res) => {
      message.success("已创建投递任务");
      setDispatchArt(null);
      nav(`/jobs/${res.data.jobId}`);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const enabledTargets = (targets ?? []).filter((t) => t.enabled);

  return (
    <div>
      <Space
        style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }}
      >
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            产物库
          </Typography.Title>
          <Typography.Text type="secondary">
            共 {data?.total ?? 0} 个 · {formatBytes(data?.totalBytes ?? 0)}
          </Typography.Text>
        </div>
      </Space>

      <div className="page-card">
        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={data?.items ?? []}
          columns={[
            { title: "文件名", dataIndex: "fileName" },
            {
              title: "大小",
              dataIndex: "sizeBytes",
              render: (n) => formatBytes(n),
            },
            {
              title: "SHA256",
              dataIndex: "checksumSha256",
              render: (v) => (
                <span className="mono" title={v}>
                  {String(v).slice(0, 12)}…
                </span>
              ),
            },
            { title: "来源", dataIndex: "sourceType" },
            {
              title: "创建",
              dataIndex: "createdAt",
              render: (t) => dayjs(t).format("YYYY-MM-DD HH:mm"),
            },
            {
              title: "操作",
              render: (_, r) => (
                <Space wrap>
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    href={`/api/v1/artifacts/${r.id}/download`}
                  >
                    下载
                  </Button>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => {
                      setRenameArt(r);
                      renameForm.setFieldsValue({ fileName: r.fileName });
                    }}
                  >
                    重命名
                  </Button>
                  <Button
                    size="small"
                    icon={<LinkOutlined />}
                    onClick={() => {
                      setShareArt(r);
                      setCreatedShareUrl(null);
                      shareForm.setFieldsValue({
                        ttlPreset: "24h",
                        maxDownloads: null,
                      });
                    }}
                  >
                    分享
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    icon={<SendOutlined />}
                    onClick={() => {
                      setDispatchArt(r);
                      dispatchForm.resetFields();
                    }}
                  >
                    再投递
                  </Button>
                  <Popconfirm
                    title="删除产物及关联分享？"
                    onConfirm={() => delMut.mutate(r.id)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </div>

      <Modal
        title="重命名"
        open={!!renameArt}
        onCancel={() => setRenameArt(null)}
        onOk={() => renameForm.submit()}
        confirmLoading={renameMut.isPending}
      >
        <Form
          form={renameForm}
          layout="vertical"
          onFinish={(v) =>
            renameMut.mutate({ id: renameArt!.id, fileName: v.fileName })
          }
        >
          <Form.Item name="fileName" label="文件名" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={`分享 · ${shareArt?.fileName ?? ""}`}
        open={!!shareArt}
        onClose={() => setShareArt(null)}
        width={420}
      >
        {createdShareUrl ? (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Text type="success">链接已生成（请立即复制）</Typography.Text>
            <Input.TextArea value={createdShareUrl} rows={3} readOnly />
            <Button
              type="primary"
              onClick={async () => {
                await navigator.clipboard.writeText(createdShareUrl);
                message.success("已复制");
              }}
            >
              复制链接
            </Button>
          </Space>
        ) : (
          <Form
            form={shareForm}
            layout="vertical"
            onFinish={(v) => shareMut.mutate(v)}
          >
            <Form.Item name="ttlPreset" label="有效期" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: "1h", label: "1 小时" },
                  { value: "24h", label: "24 小时" },
                  { value: "7d", label: "7 天" },
                  { value: "30d", label: "30 天" },
                  { value: "custom", label: "自定义秒数" },
                ]}
              />
            </Form.Item>
            <Form.Item noStyle shouldUpdate>
              {() =>
                shareForm.getFieldValue("ttlPreset") === "custom" ? (
                  <Form.Item
                    name="ttlSeconds"
                    label="TTL（秒）"
                    rules={[{ required: true }]}
                  >
                    <InputNumber min={60} style={{ width: "100%" }} />
                  </Form.Item>
                ) : null
              }
            </Form.Item>
            <Form.Item name="maxDownloads" label="最大下载次数（可选）">
              <InputNumber min={1} style={{ width: "100%" }} placeholder="不限制" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={shareMut.isPending} block>
              生成链接
            </Button>
          </Form>
        )}
      </Drawer>

      <Modal
        title={`再投递 · ${dispatchArt?.fileName ?? ""}`}
        open={!!dispatchArt}
        onCancel={() => setDispatchArt(null)}
        onOk={() => dispatchForm.submit()}
        confirmLoading={dispatchMut.isPending}
      >
        <Form form={dispatchForm} layout="vertical" onFinish={(v) => dispatchMut.mutate(v)}>
          <Form.Item
            name="targetIds"
            label="目标"
            rules={[{ required: true, message: "请选择目标" }]}
          >
            <Select
              mode="multiple"
              options={enabledTargets.map((t) => ({
                value: t.id,
                label: `${t.name} (${t.type})`,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

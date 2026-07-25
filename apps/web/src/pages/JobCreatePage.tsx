import {
  App,
  Button,
  Checkbox,
  Form,
  Input,
  Radio,
  Select,
  Space,
  Typography,
} from "antd";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, type Target } from "../api/client";

export function JobCreatePage() {
  const { message } = App.useApp();
  const nav = useNavigate();
  const [form] = Form.useForm();
  const sourceType = Form.useWatch("sourceType", form);

  const { data: targets } = useQuery({
    queryKey: ["targets"],
    queryFn: async () =>
      (await api.get<{ items: Target[] }>("/targets")).data.items,
  });

  const mut = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      const body = {
        name: values.name || undefined,
        sourceType: values.sourceType,
        sourceUrl: values.sourceUrl,
        sourceMeta:
          values.sourceType === "github_release"
            ? {
                tag: values.tag || "latest",
                assetName: values.assetName || undefined,
              }
            : undefined,
        targetIds: values.targetIds,
        options: {
          overwrite: values.overwrite ?? true,
          retries: 2,
          expectedSha256: values.expectedSha256 || null,
        },
      };
      return (await api.post("/jobs", body)).data as { id: string };
    },
    onSuccess: (job) => {
      message.success("任务已创建");
      nav(`/jobs/${job.id}`);
    },
    onError: (err: Error) => message.error(err.message),
  });

  const enabledTargets = (targets ?? []).filter((t) => t.enabled);

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        新建投递
      </Typography.Title>
      <div className="page-card" style={{ maxWidth: 720 }}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            sourceType: "http",
            overwrite: true,
            tag: "latest",
          }}
          onFinish={(v) => mut.mutate(v)}
        >
          <Form.Item name="name" label="任务名称（可选）">
            <Input placeholder="例如 WorldEdit 7.3.0" />
          </Form.Item>
          <Form.Item name="sourceType" label="源类型" rules={[{ required: true }]}>
            <Radio.Group
              options={[
                { value: "http", label: "HTTP 直链" },
                { value: "github_release", label: "GitHub Release" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="sourceUrl"
            label={sourceType === "github_release" ? "仓库 URL" : "下载 URL"}
            rules={[{ required: true, type: "url" }]}
          >
            <Input
              placeholder={
                sourceType === "github_release"
                  ? "https://github.com/org/repo"
                  : "https://example.com/plugin.jar"
              }
            />
          </Form.Item>
          {sourceType === "github_release" && (
            <Space style={{ display: "flex" }} size="middle">
              <Form.Item name="tag" label="Tag" style={{ flex: 1 }}>
                <Input placeholder="latest 或 v1.0.0" />
              </Form.Item>
              <Form.Item name="assetName" label="Asset 名称" style={{ flex: 1 }}>
                <Input placeholder="plugin.jar" />
              </Form.Item>
            </Space>
          )}
          <Form.Item
            name="targetIds"
            label="目标服务器"
            rules={[{ required: true, message: "请选择至少一个目标" }]}
          >
            <Select
              mode="multiple"
              placeholder="选择已启用目标"
              options={enabledTargets.map((t) => ({
                value: t.id,
                label: `${t.name} (${t.type})`,
              }))}
            />
          </Form.Item>
          <Form.Item name="expectedSha256" label="期望 SHA256（可选）">
            <Input className="mono" placeholder="64 hex" />
          </Form.Item>
          <Form.Item name="overwrite" valuePropName="checked">
            <Checkbox>覆盖远端同名文件</Checkbox>
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={mut.isPending}>
            一键发布
          </Button>
        </Form>
      </div>
    </div>
  );
}

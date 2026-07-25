import {
  App,
  Alert,
  Button,
  Form,
  Input,
  Radio,
  Space,
  Typography,
} from "antd";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";

/**
 * Step 1 only: download HTTP / GitHub into the local artifact library.
 * Step 2 (upload to servers) is done from 产物库 → 上传到目标.
 */
export function JobCreatePage() {
  const { message } = App.useApp();
  const nav = useNavigate();
  const [form] = Form.useForm();
  const sourceType = Form.useWatch("sourceType", form);

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
        // Download only — no targets here
        targetIds: [],
        options: {
          retries: 2,
          expectedSha256: values.expectedSha256 || null,
        },
      };
      return (await api.post("/jobs", body)).data as { id: string };
    },
    onSuccess: (job) => {
      message.success("已开始下载，完成后会出现在「文件管理」");
      nav(`/jobs/${job.id}`);
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        从网址下载
      </Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16, maxWidth: 720 }}
        message="两步流程（不是一键发布）"
        description={
          <span>
            ① 本页：把 HTTP / GitHub 等资源<strong>下载到本站存储</strong>
            （文件管理），不选目标机、不上传。
            <br />
            ② 之后在{" "}
            <Link to="/artifacts">文件管理</Link>{" "}
            里管理这些文件；需要发到服务器时再点「上传到目标」。
          </span>
        }
      />
      <div className="page-card" style={{ maxWidth: 720 }}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            sourceType: "http",
            tag: "latest",
          }}
          onFinish={(v) => mut.mutate(v)}
        >
          <Form.Item name="name" label="名称（可选）">
            <Input placeholder="例如 server.jar / WorldEdit 7.3.0" />
          </Form.Item>
          <Form.Item name="sourceType" label="下载来源" rules={[{ required: true }]}>
            <Radio.Group
              options={[
                { value: "http", label: "HTTP 直链" },
                { value: "github_release", label: "GitHub Release（解析资源后下载）" },
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
                  : "https://example.com/plugin.jar 或 GitHub releases/download/..."
              }
            />
          </Form.Item>
          {sourceType === "github_release" && (
            <Space style={{ display: "flex" }} size="middle">
              <Form.Item name="tag" label="Tag" style={{ flex: 1 }}>
                <Input placeholder="latest 或 v1.0.0" />
              </Form.Item>
              <Form.Item name="assetName" label="Asset 名称" style={{ flex: 1 }}>
                <Input placeholder="server.jar（可选，用于匹配资源）" />
              </Form.Item>
            </Space>
          )}
          <Form.Item name="expectedSha256" label="期望 SHA256（可选）">
            <Input className="mono" placeholder="64 hex" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={mut.isPending}>
            开始下载
          </Button>
        </Form>
      </div>
    </div>
  );
}

import {
  App,
  Alert,
  Button,
  Form,
  Input,
  Radio,
  Space,
  Table,
  Typography,
} from "antd";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import { api } from "../api/client";

type GithubAsset = {
  id: number;
  name: string;
  size: number;
  contentType: string | null;
};

type GithubPreview = {
  owner: string;
  repo: string;
  tag: string;
  name: string | null;
  publishedAt: string | null;
  assets: GithubAsset[];
  usedToken: boolean;
};

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/**
 * Step 1 only: download HTTP / GitHub into the local artifact library.
 * Step 2 (upload to servers) is done from 产物库 → 上传到目标.
 */
export function JobCreatePage() {
  const { message } = App.useApp();
  const nav = useNavigate();
  const [form] = Form.useForm();
  const sourceType = Form.useWatch("sourceType", form);
  const [preview, setPreview] = useState<GithubPreview | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);

  const previewMut = useMutation({
    mutationFn: async () => {
      const values = await form.validateFields(["sourceUrl", "tag"]);
      return (
        await api.post<GithubPreview>("/jobs/preview-github", {
          repoUrl: values.sourceUrl,
          tag: values.tag || "latest",
        })
      ).data;
    },
    onSuccess: (data) => {
      setPreview(data);
      setSelectedAssetId(data.assets[0]?.id ?? null);
      if (!data.assets.length) {
        message.warning("该 Release 没有附件（Assets），只有源码包时不会自动下载");
      } else {
        message.success(
          `已解析 ${data.owner}/${data.repo} @ ${data.tag}，共 ${data.assets.length} 个资源`,
        );
      }
    },
    onError: (err: Error) => {
      setPreview(null);
      setSelectedAssetId(null);
      message.error(err.message);
    },
  });

  const downloadMut = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      const isGithub = values.sourceType === "github_release";
      if (isGithub) {
        if (!preview || selectedAssetId == null) {
          throw new Error("请先点击「解析 Release」并选择要下载的资源");
        }
        const asset = preview.assets.find((a) => a.id === selectedAssetId);
        if (!asset) throw new Error("请选择一个 Release 资源");
      }

      const asset =
        isGithub && selectedAssetId != null
          ? preview!.assets.find((a) => a.id === selectedAssetId)
          : undefined;

      const body = {
        name: values.name || asset?.name || undefined,
        sourceType: values.sourceType,
        sourceUrl: values.sourceUrl,
        sourceMeta: isGithub
          ? {
              tag: preview!.tag,
              assetName: asset!.name,
              assetId: asset!.id,
            }
          : undefined,
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
            ② 之后在 <Link to="/artifacts">文件管理</Link>{" "}
            里管理这些文件；需要发到服务器时再点「上传到目标」。
            <br />
            GitHub 私库请先在 <Link to="/settings">设置</Link>{" "}
            配置 Token。HTTP 直链若是 github.com / raw.githubusercontent.com
            也会自动带上该 Token（可下私库文件）。
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
          onFinish={(v) => downloadMut.mutate(v)}
          onValuesChange={(changed) => {
            if (
              "sourceUrl" in changed ||
              "tag" in changed ||
              "sourceType" in changed
            ) {
              setPreview(null);
              setSelectedAssetId(null);
            }
          }}
        >
          <Form.Item name="name" label="名称（可选）">
            <Input placeholder="例如 server.jar / WorldEdit 7.3.0" />
          </Form.Item>
          <Form.Item
            name="sourceType"
            label="下载来源"
            rules={[{ required: true }]}
          >
            <Radio.Group
              options={[
                { value: "http", label: "HTTP 直链" },
                {
                  value: "github_release",
                  label: "GitHub Release（先解析再下载）",
                },
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
                  : "https://example.com/a.jar · 或 raw.githubusercontent.com/... · 或 github.com/.../releases/download/..."
              }
            />
          </Form.Item>
          {sourceType === "github_release" && (
            <>
              <Form.Item
                name="tag"
                label="Tag"
                extra="填 latest 或具体 tag（如 v1.0.0）。必须是已发布的 Release，仅有 git tag 不够。"
              >
                <Input placeholder="latest 或 v1.0.0" />
              </Form.Item>
              <Space style={{ marginBottom: 16 }}>
                <Button
                  onClick={() => previewMut.mutate()}
                  loading={previewMut.isPending}
                >
                  解析 Release
                </Button>
                {preview && (
                  <Typography.Text type="secondary">
                    {preview.owner}/{preview.repo} @ {preview.tag}
                    {preview.usedToken ? " · 已使用 Token" : " · 未使用 Token"}
                  </Typography.Text>
                )}
              </Space>
              {preview && (
                <div style={{ marginBottom: 16 }}>
                  {preview.assets.length === 0 ? (
                    <Alert
                      type="warning"
                      showIcon
                      message="该 Release 没有 Assets"
                      description="GitHub 只会提供 Source code 压缩包，OmniDrop 不会自动下载源码包。请到 GitHub 上传构建产物，或改用 HTTP 直链。"
                    />
                  ) : (
                    <>
                      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                        选择要下载的资源（不会下载源码 zip）：
                      </Typography.Paragraph>
                      <Table
                        size="small"
                        rowKey="id"
                        pagination={false}
                        dataSource={preview.assets}
                        rowSelection={{
                          type: "radio",
                          selectedRowKeys:
                            selectedAssetId != null ? [selectedAssetId] : [],
                          onChange: (keys) =>
                            setSelectedAssetId(Number(keys[0])),
                        }}
                        columns={[
                          { title: "文件名", dataIndex: "name" },
                          {
                            title: "大小",
                            dataIndex: "size",
                            width: 120,
                            render: (n: number) => formatBytes(n),
                          },
                        ]}
                      />
                    </>
                  )}
                </div>
              )}
            </>
          )}
          <Form.Item name="expectedSha256" label="期望 SHA256（可选）">
            <Input className="mono" placeholder="64 hex" />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={downloadMut.isPending}
            disabled={
              sourceType === "github_release" &&
              (!preview ||
                selectedAssetId == null ||
                preview.assets.length === 0)
            }
          >
            {sourceType === "github_release"
              ? "确认下载所选资源"
              : "开始下载"}
          </Button>
          {sourceType === "github_release" && !preview && (
            <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
              请先「解析 Release」确认资源后再下载，避免下错文件或误下源码包。
            </Typography.Paragraph>
          )}
        </Form>
      </div>
    </div>
  );
}

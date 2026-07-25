import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Breadcrumb,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from "antd";
import {
  ArrowLeftOutlined,
  CloudDownloadOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import dayjs from "dayjs";
import { api, type Target } from "../api/client";

type RemoteEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number | null;
  modifiedAt?: number | null;
};

type ListResp = {
  root: string;
  path: string;
  entries: RemoteEntry[];
  truncated?: boolean;
};

type FsTransfer = {
  jobId: string;
  kind: "upload" | "download";
  status: "queued" | "running" | "succeeded" | "failed";
  fileName?: string;
  remotePath?: string;
  bytesDone: number;
  bytesTotal: number | null;
  progressPct: number;
  errorMessage?: string | null;
  remoteFinalPath?: string | null;
};

function formatBytes(n?: number | null) {
  if (n == null) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function TargetDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [path, setPath] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string[]>([]);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [renameEntry, setRenameEntry] = useState<RemoteEntry | null>(null);
  const [artifactUploadOpen, setArtifactUploadOpen] = useState(false);
  const [pendingUploadArtifactId, setPendingUploadArtifactId] = useState<
    string | null
  >(null);
  const [activeTransfers, setActiveTransfers] = useState<
    Array<{ jobId: string; kind: "upload" | "download"; label: string }>
  >([]);
  const [mkdirForm] = Form.useForm();
  const [renameForm] = Form.useForm();
  const [artifactForm] = Form.useForm();

  const trackTransfer = (
    jobId: string,
    kind: "upload" | "download",
    label: string,
  ) => {
    setActiveTransfers((prev) => {
      if (prev.some((t) => t.jobId === jobId)) return prev;
      return [...prev, { jobId, kind, label }];
    });
  };

  const dismissTransfer = (jobId: string) => {
    setActiveTransfers((prev) => prev.filter((t) => t.jobId !== jobId));
  };

  // From 文件管理 →「上传到目标」: /targets/:id?uploadArtifact=art_xxx
  useEffect(() => {
    const aid = searchParams.get("uploadArtifact");
    if (!aid) return;
    setPendingUploadArtifactId(aid);
    const next = new URLSearchParams(searchParams);
    next.delete("uploadArtifact");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const { data: target } = useQuery({
    queryKey: ["target", id],
    queryFn: async () => (await api.get<Target>(`/targets/${id}`)).data,
    enabled: !!id,
  });

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["target-files", id, path],
    queryFn: async () =>
      (
        await api.get<ListResp>(`/targets/${id}/files`, {
          params: path ? { path } : {},
        })
      ).data,
    enabled: !!id,
    retry: 1,
  });

  // Never share queryKey ["artifacts"] with ArtifactsPage (that page caches
  // { items, total, totalBytes }, not an array — causes ".map is not a function").
  const { data: artifactsRaw } = useQuery({
    queryKey: ["artifacts", "select-options"],
    queryFn: async () => {
      const res = await api.get<{
        items?: Array<{ id: string; fileName: string; note?: string | null }>;
      }>("/artifacts");
      const body = res.data as
        | {
            items?: Array<{
              id: string;
              fileName: string;
              note?: string | null;
            }>;
          }
        | Array<{ id: string; fileName: string; note?: string | null }>
        | undefined;
      if (Array.isArray(body)) return body;
      if (body && Array.isArray(body.items)) return body.items;
      return [] as Array<{
        id: string;
        fileName: string;
        note?: string | null;
      }>;
    },
  });
  const artifactOptions = Array.isArray(artifactsRaw) ? artifactsRaw : [];

  const currentPath = data?.path ?? path ?? data?.root ?? "/";
  const jailRoot =
    data?.root ??
    String(
      (target?.config as { remotePath?: string } | undefined)?.remotePath ?? "/",
    );

  const crumbs = useMemo(() => {
    try {
      const safeRoot = jailRoot || "/";
      const root = safeRoot === "/" ? "" : safeRoot.replace(/\/+$/, "");
      const cur = String(currentPath || "/").replace(/\/+$/, "") || "/";
      if (root && !cur.startsWith(root)) {
        return [{ title: safeRoot, path: safeRoot }];
      }
      const rel = root ? cur.slice(root.length) : cur;
      const parts = rel.split("/").filter(Boolean);
      const items: Array<{ title: string; path: string }> = [
        { title: safeRoot, path: safeRoot },
      ];
      let acc = root || "";
      for (const p of parts) {
        acc = `${acc}/${p}`.replace(/\/+/g, "/");
        if (!acc.startsWith("/")) acc = `/${acc}`;
        items.push({ title: p, path: acc });
      }
      return items;
    } catch {
      return [{ title: "/", path: "/" }];
    }
  }, [currentPath, jailRoot]);

  const fileEntries = Array.isArray(data?.entries) ? data!.entries : [];
  const breadcrumbItems = Array.isArray(crumbs) ? crumbs : [];

  const invalidate = async () => {
    setSelected([]);
    await qc.invalidateQueries({ queryKey: ["target-files", id] });
  };

  const mkdirMut = useMutation({
    mutationFn: (name: string) =>
      api.post(`/targets/${id}/files/mkdir`, { path: currentPath, name }),
    onSuccess: async () => {
      message.success("目录已创建");
      setMkdirOpen(false);
      mkdirForm.resetFields();
      await invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const renameMut = useMutation({
    mutationFn: ({ path: p, newName }: { path: string; newName: string }) =>
      api.post(`/targets/${id}/files/rename`, { path: p, newName }),
    onSuccess: async () => {
      message.success("已重命名");
      setRenameEntry(null);
      await invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (paths: string[]) =>
      api.post(`/targets/${id}/files/delete`, { paths, recursive: true }),
    onSuccess: async () => {
      message.success("已删除");
      await invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const downloadMut = useMutation({
    mutationFn: (remotePath: string) =>
      api.post<{ jobId: string; fileName?: string }>(
        `/targets/${id}/files/download`,
        { path: remotePath },
      ),
    onSuccess: (res, remotePath) => {
      const name =
        res.data.fileName ||
        remotePath.split("/").filter(Boolean).pop() ||
        remotePath;
      trackTransfer(res.data.jobId, "download", name);
      message.success(`开始下载到产物库：${name}`);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const artifactUploadMut = useMutation({
    mutationFn: (values: { artifactId: string }) =>
      api.post<{
        jobId: string;
        fileName?: string;
        sizeBytes?: number;
      }>(`/targets/${id}/files/upload-artifact`, {
        artifactId: values.artifactId,
        destPath: currentPath,
        overwrite: true,
      }),
    onSuccess: (res) => {
      const name = res.data.fileName || "文件";
      trackTransfer(res.data.jobId, "upload", name);
      message.success(`开始上传：${name} → ${currentPath}`);
      setArtifactUploadOpen(false);
      setPendingUploadArtifactId(null);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const pendingArtifact = pendingUploadArtifactId
    ? artifactOptions.find((a) => a.id === pendingUploadArtifactId)
    : undefined;

  const uploadPendingToCurrentDir = () => {
    if (!pendingUploadArtifactId) return;
    artifactUploadMut.mutate({ artifactId: pendingUploadArtifactId });
  };

  const goParent = () => {
    if (!data) return;
    if (currentPath === jailRoot || currentPath === "/") return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const parent = parts.length ? `/${parts.join("/")}` : "/";
    // stay in jail
    if (jailRoot !== "/" && !parent.startsWith(jailRoot.replace(/\/+$/, ""))) {
      setPath(jailRoot);
    } else {
      setPath(parent === "" ? "/" : parent);
    }
  };

// Always render shell even when list fails — never leave a blank page
  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={(e) => {
            e.preventDefault();
            nav("/targets");
          }}
        >
          返回列表
        </Button>
      </Space>

      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {target?.name ?? "目标"}
          </Typography.Title>
          <Space style={{ marginTop: 8 }}>
            {target && <Tag>{target.type}</Tag>}
            <Typography.Text type="secondary">
              根路径（jail）：{jailRoot}
            </Typography.Text>
          </Space>
        </div>
      </Space>

      <div className="page-card">
        {pendingUploadArtifactId && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={
              pendingArtifact
                ? `待上传：${pendingArtifact.fileName}${
                    pendingArtifact.note ? ` · ${pendingArtifact.note}` : ""
                  }`
                : "待上传产物"
            }
            description={
              <div>
                <div>
                  请浏览到目标目录，然后点「上传到此目录」。当前目录：
                  <Typography.Text code>{currentPath}</Typography.Text>
                </div>
                <Space style={{ marginTop: 8 }} wrap>
                  <Button
                    type="primary"
                    loading={artifactUploadMut.isPending}
                    onClick={uploadPendingToCurrentDir}
                  >
                    上传到此目录
                  </Button>
                  <Button onClick={() => setPendingUploadArtifactId(null)}>
                    取消
                  </Button>
                </Space>
              </div>
            }
          />
        )}

        {activeTransfers.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
              传输进度
            </Typography.Text>
            <Space direction="vertical" style={{ width: "100%" }} size={12}>
              {activeTransfers.map((t) => (
                <TransferProgressCard
                  key={t.jobId}
                  targetId={id!}
                  jobId={t.jobId}
                  kind={t.kind}
                  label={t.label}
                  onDismiss={() => dismissTransfer(t.jobId)}
                  onTerminalSuccess={() => {
                    void invalidate();
                    if (t.kind === "download") {
                      void qc.invalidateQueries({ queryKey: ["artifacts"] });
                    }
                  }}
                />
              ))}
            </Space>
          </div>
        )}

        <Space wrap style={{ marginBottom: 12, width: "100%", justifyContent: "space-between" }}>
          <Breadcrumb
            items={breadcrumbItems.map((c, i) => ({
              title:
                i === breadcrumbItems.length - 1 ? (
                  <span>{c.title}</span>
                ) : (
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => setPath(c.path)}
                  >
                    {c.title}
                  </button>
                ),
            }))}
          />
          <Space wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={goParent} disabled={currentPath === jailRoot}>
              上级
            </Button>
            <Button
              icon={<ReloadOutlined />}
              loading={isFetching}
              onClick={() => void invalidate()}
            >
              刷新
            </Button>
            <Button
              icon={<FolderAddOutlined />}
              onClick={() => setMkdirOpen(true)}
            >
              新建目录
            </Button>
            <Upload
              showUploadList={false}
              customRequest={async (options) => {
                try {
                  const file = options.file as File;
                  const form = new FormData();
                  form.append("file", file);
                  form.append("destPath", currentPath);
                  form.append("overwrite", "true");
                  await api.post(`/targets/${id}/files/upload`, form, {
                    headers: { "Content-Type": "multipart/form-data" },
                  });
                  message.success("上传成功");
                  options.onSuccess?.({});
                  await invalidate();
                } catch (e) {
                  const err = e as Error;
                  message.error(err.message);
                  options.onError?.(err);
                }
              }}
            >
              <Button icon={<UploadOutlined />}>上传本地文件</Button>
            </Upload>
            <Button
              onClick={() => {
                setArtifactUploadOpen(true);
                if (pendingUploadArtifactId) {
                  artifactForm.setFieldsValue({
                    artifactId: pendingUploadArtifactId,
                  });
                }
              }}
            >
              从产物库上传
            </Button>
            <Popconfirm
              title={`删除选中的 ${selected.length} 项？`}
              disabled={!selected.length}
              onConfirm={() => deleteMut.mutate(selected)}
            >
              <Button danger disabled={!selected.length} icon={<DeleteOutlined />}>
                批量删除
              </Button>
            </Popconfirm>
          </Space>
        </Space>

        {error && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message="无法列出远端目录"
            description={
              <div>
                <div>{(error as Error).message}</div>
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  请检查：① 主机/端口/账号密码 ②「远端路径」是否为该 SFTP 用户真实目录（可先试{" "}
                  <code>/</code>）③ 服务器防火墙是否允许本机出站 ④ 目标详情点「测试」看连通性。
                  容器内可执行：
                  <code> docker compose logs omnidrop | tail </code>
                  查看 [remote-fs list] 详细错误。
                </Typography.Paragraph>
              </div>
            }
          />
        )}
        {data?.truncated && (
          <Typography.Text type="warning">
            目录条目过多，已截断显示前 2000 项
          </Typography.Text>
        )}

        <Table
          rowKey="path"
          loading={isLoading}
          dataSource={fileEntries}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys as string[]),
          }}
          onRow={(r) => ({
            onDoubleClick: () => {
              if (r.type === "dir") setPath(r.path);
            },
          })}
          columns={[
            {
              title: "名称",
              dataIndex: "name",
              render: (name, r) => (
                <Space>
                  {r.type === "dir" ? <FolderOpenOutlined /> : <FileOutlined />}
                  {r.type === "dir" ? (
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => setPath(r.path)}
                    >
                      {name}
                    </button>
                  ) : (
                    name
                  )}
                </Space>
              ),
            },
            {
              title: "类型",
              dataIndex: "type",
              width: 80,
              render: (t) => (t === "dir" ? "目录" : "文件"),
            },
            {
              title: "大小",
              dataIndex: "size",
              width: 100,
              render: (s, r) => (r.type === "dir" ? "-" : formatBytes(s)),
            },
            {
              title: "修改时间",
              dataIndex: "modifiedAt",
              width: 160,
              render: (t) =>
                t ? dayjs(t).format("YYYY-MM-DD HH:mm") : "-",
            },
            {
              title: "操作",
              width: 280,
              render: (_, r) => (
                <Space wrap>
                  {r.type === "file" && (
                    <Button
                      size="small"
                      icon={<CloudDownloadOutlined />}
                      loading={downloadMut.isPending}
                      onClick={() => downloadMut.mutate(r.path)}
                    >
                      到产物库
                    </Button>
                  )}
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => {
                      setRenameEntry(r);
                      renameForm.setFieldsValue({ newName: r.name });
                    }}
                  >
                    重命名
                  </Button>
                  <Popconfirm
                    title={
                      r.type === "dir"
                        ? "删除目录及其内容？"
                        : "删除该文件？"
                    }
                    onConfirm={() => deleteMut.mutate([r.path])}
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
        title="新建目录"
        open={mkdirOpen}
        onCancel={() => setMkdirOpen(false)}
        onOk={() => mkdirForm.submit()}
        confirmLoading={mkdirMut.isPending}
      >
        <Form
          form={mkdirForm}
          layout="vertical"
          onFinish={(v) => mkdirMut.mutate(v.name)}
        >
          <Form.Item name="name" label="目录名" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="重命名"
        open={!!renameEntry}
        onCancel={() => setRenameEntry(null)}
        onOk={() => renameForm.submit()}
        confirmLoading={renameMut.isPending}
      >
        <Form
          form={renameForm}
          layout="vertical"
          onFinish={(v) =>
            renameMut.mutate({ path: renameEntry!.path, newName: v.newName })
          }
        >
          <Form.Item name="newName" label="新名称" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="从产物库上传"
        open={artifactUploadOpen}
        onCancel={() => setArtifactUploadOpen(false)}
        onOk={() => artifactForm.submit()}
        confirmLoading={artifactUploadMut.isPending}
      >
        <Form
          form={artifactForm}
          layout="vertical"
          onFinish={(v) => artifactUploadMut.mutate(v)}
        >
          <Form.Item
            name="artifactId"
            label="产物"
            rules={[{ required: true }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={artifactOptions.map((a) => ({
                value: a.id,
                label: a.note
                  ? `${a.fileName} · ${a.note}`
                  : a.fileName,
              }))}
            />
          </Form.Item>
          <Typography.Text type="secondary">
            将上传到当前目录：{currentPath}
          </Typography.Text>
        </Form>
      </Modal>

      <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
        提示：双击目录进入。下载/上传进度显示在上方「传输进度」。下载到产物库完成后可在{" "}
        <Link to="/artifacts">产物库</Link>{" "}
        查看（备注会自动填「来自：{target?.name ?? "目标名"}」）。
      </Typography.Paragraph>
    </div>
  );
}

function TransferProgressCard(props: {
  targetId: string;
  jobId: string;
  kind: "upload" | "download";
  label: string;
  onDismiss: () => void;
  onTerminalSuccess: () => void;
}) {
  const { message } = App.useApp();
  const notified = useState({ done: false })[0];

  const { data } = useQuery({
    queryKey: ["fs-transfer", props.targetId, props.jobId],
    queryFn: async () =>
      (
        await api.get<FsTransfer>(
          `/targets/${props.targetId}/files/transfers/${props.jobId}`,
        )
      ).data,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (s === "succeeded" || s === "failed") return false;
      return 500;
    },
  });

  useEffect(() => {
    if (!data || notified.done) return;
    if (data.status === "succeeded") {
      notified.done = true;
      message.success(
        props.kind === "upload"
          ? `上传完成：${data.fileName || props.label}`
          : `已下载到产物库：${data.fileName || props.label}`,
      );
      props.onTerminalSuccess();
    } else if (data.status === "failed") {
      notified.done = true;
      message.error(data.errorMessage || "传输失败");
    }
  }, [data, message, notified, props]);

  const status = data?.status ?? "queued";
  const pct = data?.progressPct ?? 0;
  const bytesDone = data?.bytesDone ?? 0;
  const bytesTotal = data?.bytesTotal ?? null;
  const unknown = status === "running" && (bytesTotal == null || bytesTotal <= 0);
  const displayPct =
    status === "succeeded"
      ? 100
      : unknown
        ? bytesDone > 0
          ? Math.min(99, Math.max(8, pct || 15))
          : 0
        : pct;

  return (
    <div
      style={{
        border: "1px solid #f0f0f0",
        borderRadius: 8,
        padding: "10px 12px",
        background: "#fafafa",
      }}
    >
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Space wrap>
          <Tag color={props.kind === "upload" ? "blue" : "purple"}>
            {props.kind === "upload" ? "上传" : "下载到产物库"}
          </Tag>
          <Typography.Text strong>
            {data?.fileName || props.label}
          </Typography.Text>
          <Tag
            color={
              status === "succeeded"
                ? "success"
                : status === "failed"
                  ? "error"
                  : status === "running"
                    ? "processing"
                    : "default"
            }
          >
            {status === "queued"
              ? "排队中"
              : status === "running"
                ? "进行中"
                : status === "succeeded"
                  ? "完成"
                  : "失败"}
          </Tag>
        </Space>
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          onClick={props.onDismiss}
        />
      </Space>
      <Progress
        percent={displayPct}
        status={
          status === "failed"
            ? "exception"
            : status === "succeeded"
              ? "success"
              : "active"
        }
        style={{ marginTop: 8, marginBottom: 0 }}
        format={(p) =>
          unknown
            ? bytesDone > 0
              ? formatBytes(bytesDone)
              : "…"
            : `${p}%`
        }
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {formatBytes(bytesDone)}
        {bytesTotal != null && bytesTotal > 0
          ? ` / ${formatBytes(bytesTotal)}`
          : status === "running"
            ? " / …"
            : ""}
        {data?.remoteFinalPath ? ` · ${data.remoteFinalPath}` : ""}
        {data?.errorMessage ? (
          <Typography.Text type="danger"> · {data.errorMessage}</Typography.Text>
        ) : null}
      </Typography.Text>
    </div>
  );
}

import {
  App,
  Button,
  Descriptions,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import dayjs from "dayjs";
import { api, type JobDetail } from "../api/client";
import { StatusTag } from "../components/StatusTag";
import { useJobEvents } from "../hooks/useJobEvents";

function formatBytes(n?: number | null) {
  if (n == null || Number.isNaN(n)) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function formatSpeed(bps?: number | null) {
  if (bps == null || bps <= 0 || Number.isNaN(bps)) return null;
  return `${formatBytes(bps)}/s`;
}

export function JobDetailPage() {
  const { id } = useParams();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { live, sseConnected } = useJobEvents(id);

  const terminalStatuses = ["succeeded", "failed", "canceled", "partial"];

  const { data, isLoading } = useQuery({
    queryKey: ["job", id],
    queryFn: async () => (await api.get<JobDetail>(`/jobs/${id}`)).data,
    enabled: !!id,
    // Backup poll; useJobEvents also polls at 1s while running
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (s && terminalStatuses.includes(s)) return false;
      return 2000;
    },
  });

  const cancelMut = useMutation({
    mutationFn: () => api.post(`/jobs/${id}/cancel`),
    onSuccess: async () => {
      message.success("已请求取消");
      await qc.invalidateQueries({ queryKey: ["job", id] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const retryMut = useMutation({
    mutationFn: () => api.post(`/jobs/${id}/retry`),
    onSuccess: async () => {
      message.success("已开始重试");
      await qc.invalidateQueries({ queryKey: ["job", id] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  if (!data && isLoading) {
    return <Typography.Text>加载中…</Typography.Text>;
  }
  if (!data) return <Typography.Text>任务不存在</Typography.Text>;

  const status = live?.status ?? data.status;
  const bytesDone = live?.bytesDone ?? data.bytesDone ?? 0;
  const bytesTotal =
    live?.bytesTotal !== undefined ? live.bytesTotal : data.bytesTotal;
  const progressPct =
    live?.progressPct ??
    data.progressPct ??
    (bytesTotal && bytesTotal > 0
      ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100))
      : status === "succeeded"
        ? 100
        : 0);

  const terminal = terminalStatuses.includes(status);
  const running = !terminal;
  // Unknown total size → indeterminate-looking active bar (Ant uses percent 0 + active)
  const unknownTotal =
    running && (bytesTotal == null || bytesTotal <= 0) && bytesDone >= 0;
  const displayPercent = unknownTotal
    ? bytesDone > 0
      ? Math.min(99, Math.max(5, progressPct || 15)) // soft hint so bar isn't stuck empty
      : 0
    : progressPct;

  const speedLabel = formatSpeed(live?.speedBps);
  const phaseLabel =
    live?.phase === "hashing"
      ? "校验中"
      : status === "downloading"
        ? "下载中"
        : status === "uploading"
          ? "上传中"
          : status === "queued"
            ? "排队中"
            : null;

  return (
    <div>
      <Space
        style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }}
      >
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {data.name || data.fileName || data.id}
          </Typography.Title>
          <Space style={{ marginTop: 8 }} wrap>
            <StatusTag status={status} />
            {phaseLabel && <Tag color="processing">{phaseLabel}</Tag>}
            {live?.resumedFrom && live.resumedFrom > 0 && (
              <Tag color="cyan">断点续传自 {formatBytes(live.resumedFrom)}</Tag>
            )}
            <Typography.Text type="secondary" className="mono">
              {data.id}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {sseConnected ? "实时推送已连接" : "轮询更新中…"}
            </Typography.Text>
          </Space>
        </div>
        <Space>
          {running && (
            <Popconfirm
              title="确认取消任务？"
              onConfirm={() => cancelMut.mutate()}
            >
              <Button danger loading={cancelMut.isPending}>
                取消
              </Button>
            </Popconfirm>
          )}
          {(status === "failed" ||
            status === "partial" ||
            status === "canceled") && (
            <Button
              onClick={() => retryMut.mutate()}
              loading={retryMut.isPending}
            >
              {data.targets?.some((t) => t.status === "failed")
                ? "重试失败上传"
                : "重试下载（可断点续传）"}
            </Button>
          )}
        </Space>
      </Space>

      <div className="page-card" style={{ marginBottom: 16 }}>
        <Space
          style={{ width: "100%", justifyContent: "space-between" }}
          wrap
        >
          <Typography.Text strong>传输进度</Typography.Text>
          <Typography.Text type="secondary">
            {formatBytes(bytesDone)}
            {bytesTotal != null && bytesTotal > 0
              ? ` / ${formatBytes(bytesTotal)}`
              : running
                ? " / 总大小未知"
                : ""}
            {bytesTotal != null && bytesTotal > 0
              ? ` · ${progressPct}%`
              : ""}
            {speedLabel ? ` · ${speedLabel}` : ""}
          </Typography.Text>
        </Space>
        <Progress
          percent={displayPercent}
          status={
            status === "failed"
              ? "exception"
              : status === "succeeded"
                ? "success"
                : "active"
          }
          strokeColor={
            unknownTotal
              ? { from: "#1677ff", to: "#69b1ff" }
              : undefined
          }
          format={(p) =>
            unknownTotal
              ? bytesDone > 0
                ? formatBytes(bytesDone)
                : "…"
              : `${p}%`
          }
        />
        {unknownTotal && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            源站未提供文件总大小，进度条按已下载量动态显示；完成后会显示 100%。
          </Typography.Text>
        )}
        <Descriptions size="small" column={2} style={{ marginTop: 12 }}>
          <Descriptions.Item label="源类型">{data.sourceType}</Descriptions.Item>
          <Descriptions.Item label="文件名">
            {data.fileName || "-"}
          </Descriptions.Item>
          {(data as { artifactId?: string }).artifactId && (
            <Descriptions.Item label="文件管理">
              <Link to="/artifacts">
                已入库 · {(data as { artifactId?: string }).artifactId}
              </Link>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="源 URL" span={2}>
            <span className="mono">{data.sourceUrl}</span>
          </Descriptions.Item>
          <Descriptions.Item label="SHA256" span={2}>
            <span className="mono">{data.checksumSha256 || "-"}</span>
          </Descriptions.Item>
          <Descriptions.Item label="大小">
            {bytesTotal != null && bytesTotal > 0
              ? formatBytes(bytesTotal)
              : "-"}
          </Descriptions.Item>
          <Descriptions.Item label="创建">
            {dayjs(data.createdAt).format("YYYY-MM-DD HH:mm:ss")}
          </Descriptions.Item>
          {data.errorMessage && (
            <Descriptions.Item label="错误" span={2}>
              <Typography.Text type="danger">{data.errorMessage}</Typography.Text>
            </Descriptions.Item>
          )}
        </Descriptions>
      </div>

      {Array.isArray(data.targets) && data.targets.length > 0 && (
        <div className="page-card" style={{ marginBottom: 16 }}>
          <Typography.Title level={5}>目标进度</Typography.Title>
          <Table
            rowKey="id"
            pagination={false}
            dataSource={data.targets}
            columns={[
              { title: "目标", dataIndex: "name" },
              { title: "类型", dataIndex: "type" },
              {
                title: "状态",
                dataIndex: "status",
                render: (s) => <StatusTag status={s} />,
              },
              {
                title: "进度",
                render: (_, r) => {
                  const pct = r.progressPct ?? 0;
                  const unknown = !r.bytesTotal && r.status === "uploading";
                  return (
                    <div style={{ minWidth: 160 }}>
                      <Progress
                        percent={unknown && r.bytesDone > 0 ? Math.min(99, pct || 20) : pct}
                        size="small"
                        status={
                          r.status === "failed"
                            ? "exception"
                            : r.status === "succeeded"
                              ? "success"
                              : "active"
                        }
                      />
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {formatBytes(r.bytesDone)}
                        {r.bytesTotal != null
                          ? ` / ${formatBytes(r.bytesTotal)}`
                          : r.status === "uploading"
                            ? " / …"
                            : ""}
                      </Typography.Text>
                    </div>
                  );
                },
              },
              {
                title: "远端路径",
                dataIndex: "remoteFinalPath",
                render: (v) => (
                  <span className="mono">{v || "-"}</span>
                ),
              },
              {
                title: "错误",
                dataIndex: "errorMessage",
                render: (v) =>
                  v ? (
                    <Typography.Text type="danger">{v}</Typography.Text>
                  ) : (
                    "-"
                  ),
              },
            ]}
          />
        </div>
      )}

      <div className="page-card">
        <Typography.Title level={5}>步骤时间线</Typography.Title>
        <Timeline
          items={(Array.isArray(data.steps) ? data.steps : []).map((s) => ({
            color:
              s.status === "succeeded"
                ? "green"
                : s.status === "failed"
                  ? "red"
                  : s.status === "running"
                    ? "blue"
                    : "gray",
            children: (
              <div>
                <Space>
                  <strong>{s.step}</strong>
                  <StatusTag status={s.status} />
                  <span>{s.progressPct}%</span>
                </Space>
                {s.detail && (
                  <div className="mono" style={{ marginTop: 4 }}>
                    {s.detail}
                  </div>
                )}
                <Typography.Text type="secondary">
                  {dayjs(s.updatedAt).format("HH:mm:ss")}
                </Typography.Text>
              </div>
            ),
          }))}
        />
      </div>
    </div>
  );
}

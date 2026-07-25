import {
  App,
  Button,
  Descriptions,
  Popconfirm,
  Progress,
  Space,
  Table,
  Timeline,
  Typography,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import dayjs from "dayjs";
import { api, type JobDetail } from "../api/client";
import { StatusTag } from "../components/StatusTag";
import { useJobEvents } from "../hooks/useJobEvents";

export function JobDetailPage() {
  const { id } = useParams();
  const { message } = App.useApp();
  const qc = useQueryClient();
  useJobEvents(id);

  const { data, isLoading } = useQuery({
    queryKey: ["job", id],
    queryFn: async () => (await api.get<JobDetail>(`/jobs/${id}`)).data,
    enabled: !!id,
    refetchInterval: 4000,
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
      message.success("已重试失败目标");
      await qc.invalidateQueries({ queryKey: ["job", id] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  if (!data && isLoading) {
    return <Typography.Text>加载中…</Typography.Text>;
  }
  if (!data) return <Typography.Text>任务不存在</Typography.Text>;

  const terminal = ["succeeded", "failed", "canceled", "partial"].includes(
    data.status,
  );

  return (
    <div>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {data.name || data.fileName || data.id}
          </Typography.Title>
          <Space style={{ marginTop: 8 }}>
            <StatusTag status={data.status} />
            <Typography.Text type="secondary" className="mono">
              {data.id}
            </Typography.Text>
          </Space>
        </div>
        <Space>
          {!terminal && (
            <Popconfirm title="确认取消任务？" onConfirm={() => cancelMut.mutate()}>
              <Button danger loading={cancelMut.isPending}>
                取消
              </Button>
            </Popconfirm>
          )}
          {(data.status === "failed" || data.status === "partial") && (
            <Button onClick={() => retryMut.mutate()} loading={retryMut.isPending}>
              重试失败目标
            </Button>
          )}
        </Space>
      </Space>

      <div className="page-card" style={{ marginBottom: 16 }}>
        <Typography.Text>总进度</Typography.Text>
        <Progress
          percent={data.progressPct}
          status={
            data.status === "failed"
              ? "exception"
              : data.status === "succeeded"
                ? "success"
                : "active"
          }
        />
        <Descriptions size="small" column={2} style={{ marginTop: 12 }}>
          <Descriptions.Item label="源类型">{data.sourceType}</Descriptions.Item>
          <Descriptions.Item label="文件名">{data.fileName}</Descriptions.Item>
          {(data as { artifactId?: string }).artifactId && (
            <Descriptions.Item label="产物">
              <Link to={`/artifacts`}>
                {(data as { artifactId?: string }).artifactId}
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
            {data.bytesTotal != null
              ? `${(data.bytesTotal / 1024 / 1024).toFixed(2)} MiB`
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
              render: (_, r) => <Progress percent={r.progressPct} size="small" />,
            },
            {
              title: "远端路径",
              dataIndex: "remoteFinalPath",
              render: (v) => <span className="mono">{v || "-"}</span>,
            },
            {
              title: "错误",
              dataIndex: "errorMessage",
              render: (v) =>
                v ? <Typography.Text type="danger">{v}</Typography.Text> : "-",
            },
          ]}
        />
      </div>

      <div className="page-card">
        <Typography.Title level={5}>步骤时间线</Typography.Title>
        <Timeline
          items={data.steps.map((s) => ({
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

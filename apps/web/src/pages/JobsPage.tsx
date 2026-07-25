import { App, Button, Popconfirm, Select, Space, Table, Typography } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { useState } from "react";
import { api, type JobBrief } from "../api/client";
import { StatusTag } from "../components/StatusTag";

export function JobsPage() {
  const nav = useNavigate();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [status, setStatus] = useState<string | undefined>();
  const { data, isLoading } = useQuery({
    queryKey: ["jobs", status],
    queryFn: async () =>
      (
        await api.get<{ items: JobBrief[]; total: number }>("/jobs", {
          params: { status, pageSize: 50 },
        })
      ).data,
    refetchInterval: (q) => {
      const items = q.state.data?.items ?? [];
      const busy = items.some((j) =>
        ["queued", "downloading", "uploading", "ready"].includes(j.status),
      );
      return busy ? 2000 : 10000;
    },
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.delete(`/jobs/${id}`),
    onSuccess: async () => {
      message.success("任务已删除");
      await qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <div>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          任务列表
        </Typography.Title>
        <Space>
          <Select
            allowClear
            placeholder="状态筛选"
            style={{ width: 160 }}
            value={status}
            onChange={setStatus}
            options={[
              "queued",
              "downloading",
              "uploading",
              "succeeded",
              "failed",
              "partial",
              "canceled",
            ].map((s) => ({ value: s, label: s }))}
          />
          <Button type="primary" onClick={() => nav("/jobs/new")}>
            从网址下载
          </Button>
        </Space>
      </Space>
      <div className="page-card">
        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={data?.items ?? []}
          columns={[
            {
              title: "名称",
              dataIndex: "name",
              render: (v, r) => (
                <Link to={`/jobs/${r.id}`}>{v || r.fileName || r.id}</Link>
              ),
            },
            { title: "源", dataIndex: "sourceType" },
            {
              title: "状态",
              dataIndex: "status",
              render: (s) => <StatusTag status={s} />,
            },
            {
              title: "进度",
              render: (_, r) => {
                const done = r.bytesDone ?? 0;
                const total = r.bytesTotal;
                const busy = ["downloading", "uploading", "queued"].includes(
                  r.status,
                );
                // Succeeded must never show 0% (upload may skip mid-progress ticks)
                const pct =
                  r.status === "succeeded"
                    ? 100
                    : total != null && total > 0
                      ? Math.min(
                          100,
                          Math.round((done / total) * 100) ||
                            (r.progressPct ?? 0),
                        )
                      : (r.progressPct ?? 0);
                if (r.status === "succeeded") {
                  if (total != null && total > 0) {
                    return `100% · ${(total / 1024 / 1024).toFixed(1)} MiB`;
                  }
                  return "100%";
                }
                if (total != null && total > 0) {
                  return `${pct}% · ${(done / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MiB`;
                }
                if (busy && done > 0) {
                  return `${(done / 1024 / 1024).toFixed(2)} MiB…`;
                }
                if (busy) return "进行中…";
                return `${pct}%`;
              },
            },
            {
              title: "创建",
              dataIndex: "createdAt",
              render: (t) => dayjs(t).format("YYYY-MM-DD HH:mm:ss"),
            },
            {
              title: "操作",
              width: 100,
              render: (_, r) => (
                <Popconfirm
                  title="删除该任务记录？"
                  description="只删任务记录，不会删除文件管理里的产物。"
                  onConfirm={() => delMut.mutate(r.id)}
                >
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    loading={delMut.isPending}
                  >
                    删除
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

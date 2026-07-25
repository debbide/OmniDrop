import { Button, Select, Space, Table, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { useState } from "react";
import { api, type JobBrief } from "../api/client";
import { StatusTag } from "../components/StatusTag";

export function JobsPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState<string | undefined>();
  const { data, isLoading } = useQuery({
    queryKey: ["jobs", status],
    queryFn: async () =>
      (
        await api.get<{ items: JobBrief[]; total: number }>("/jobs", {
          params: { status, pageSize: 50 },
        })
      ).data,
    refetchInterval: 5000,
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
            新建投递
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
              dataIndex: "progressPct",
              render: (p) => `${p ?? 0}%`,
            },
            {
              title: "创建",
              dataIndex: "createdAt",
              render: (t) => dayjs(t).format("YYYY-MM-DD HH:mm:ss"),
            },
          ]}
        />
      </div>
    </div>
  );
}

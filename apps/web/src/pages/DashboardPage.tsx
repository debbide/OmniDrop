import { Card, Col, Row, Statistic, Table, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import { api, type JobBrief } from "../api/client";
import { StatusTag } from "../components/StatusTag";

export function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () =>
      (await api.get("/jobs/stats/dashboard")).data as {
        running: number;
        succeededToday: number;
        failedToday: number;
        total: number;
        recent: JobBrief[];
      },
    refetchInterval: 5000,
  });

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        总览
      </Typography.Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="运行中" value={data?.running ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="今日成功" value={data?.succeededToday ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="今日失败/部分" value={data?.failedToday ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="历史任务" value={data?.total ?? 0} />
          </Card>
        </Col>
      </Row>

      <div className="page-card" style={{ marginTop: 16 }}>
        <Typography.Title level={5}>最近任务</Typography.Title>
        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={data?.recent ?? []}
          pagination={false}
          columns={[
            {
              title: "名称",
              dataIndex: "name",
              render: (v, r) => <Link to={`/jobs/${r.id}`}>{v || r.fileName}</Link>,
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (s) => <StatusTag status={s} />,
            },
            {
              title: "创建时间",
              dataIndex: "createdAt",
              render: (t) => dayjs(t).format("YYYY-MM-DD HH:mm:ss"),
            },
          ]}
        />
      </div>
    </div>
  );
}

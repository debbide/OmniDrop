import { Tag } from "antd";

const COLOR: Record<string, string> = {
  queued: "default",
  downloading: "processing",
  ready: "cyan",
  uploading: "blue",
  succeeded: "success",
  failed: "error",
  canceled: "warning",
  partial: "orange",
  pending: "default",
  skipped: "default",
  running: "processing",
};

export function StatusTag({ status }: { status: string }) {
  return <Tag color={COLOR[status] ?? "default"}>{status}</Tag>;
}

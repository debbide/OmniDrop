import axios from "axios";

export const api = axios.create({
  baseURL: "/api/v1",
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

api.interceptors.response.use(
  (r) => r,
  (error) => {
    const message =
      error.response?.data?.error?.message ||
      error.message ||
      "Request failed";
    return Promise.reject(new Error(message));
  },
);

export type Target = {
  id: string;
  name: string;
  type: "sftp" | "pterodactyl" | "ftp" | "webdav";
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type JobBrief = {
  id: string;
  name: string | null;
  sourceType: string;
  sourceUrl: string;
  status: string;
  checksumSha256: string | null;
  bytesTotal: number | null;
  bytesDone: number;
  fileName: string | null;
  artifactId?: string | null;
  errorMessage: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  progressPct: number;
};

export type JobDetail = JobBrief & {
  sourceMeta: Record<string, unknown> | null;
  options: Record<string, unknown>;
  targets: Array<{
    id: string;
    targetId: string;
    name: string | null;
    type: string | null;
    status: string;
    bytesTotal: number | null;
    bytesDone: number;
    remoteFinalPath: string | null;
    errorMessage: string | null;
    attempts: number;
    progressPct: number;
  }>;
  steps: Array<{
    id: string;
    jobTargetId: string | null;
    step: string;
    status: string;
    progressPct: number;
    detail: string | null;
    updatedAt: number;
  }>;
};

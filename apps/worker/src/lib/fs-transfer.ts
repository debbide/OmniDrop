import { redis } from "./redis.js";

export type FsTransferStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export type FsTransferState = {
  kind: "upload" | "download";
  status: FsTransferStatus;
  jobId: string;
  targetId?: string;
  fileName?: string;
  remotePath?: string;
  artifactId?: string;
  bytesDone: number;
  bytesTotal: number | null;
  progressPct: number;
  errorMessage?: string | null;
  remoteFinalPath?: string | null;
  updatedAt: number;
};

function key(kind: "upload" | "download", jobId: string) {
  return kind === "upload" ? `fs-upload:${jobId}` : `fs-download:${jobId}`;
}

export async function setFsTransfer(
  kind: "upload" | "download",
  jobId: string,
  patch: Partial<FsTransferState> & { status: FsTransferStatus },
): Promise<void> {
  const k = key(kind, jobId);
  let prev: Partial<FsTransferState> = {};
  try {
    const raw = await redis.get(k);
    if (raw) prev = JSON.parse(raw) as FsTransferState;
  } catch {
    /* ignore */
  }
  const bytesDone = patch.bytesDone ?? prev.bytesDone ?? 0;
  const bytesTotal =
    patch.bytesTotal !== undefined
      ? patch.bytesTotal
      : (prev.bytesTotal ?? null);
  const progressPct =
    patch.progressPct != null
      ? patch.progressPct
      : bytesTotal && bytesTotal > 0
        ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100))
        : (prev.progressPct ?? 0);

  const next: FsTransferState = {
    kind,
    jobId,
    status: patch.status,
    targetId: patch.targetId ?? prev.targetId,
    fileName: patch.fileName ?? prev.fileName,
    remotePath: patch.remotePath ?? prev.remotePath,
    artifactId: patch.artifactId ?? prev.artifactId,
    bytesDone,
    bytesTotal,
    progressPct:
      patch.status === "succeeded" ? 100 : progressPct,
    errorMessage:
      patch.errorMessage !== undefined
        ? patch.errorMessage
        : (prev.errorMessage ?? null),
    remoteFinalPath:
      patch.remoteFinalPath !== undefined
        ? patch.remoteFinalPath
        : (prev.remoteFinalPath ?? null),
    updatedAt: Date.now(),
  };
  await redis.set(k, JSON.stringify(next), "EX", 86400);
}

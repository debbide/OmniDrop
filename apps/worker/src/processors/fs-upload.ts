import path from "node:path";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import {
  createRemoteFs,
  getTargetJailRoot,
  resolveJailedRemotePath,
} from "@omnidrop/remote-fs";
import { getDb, artifacts } from "@omnidrop/db";
import { loadTargetWithSecret } from "../lib/targets.js";
import { artifactsDir } from "../lib/artifacts.js";
import { logger } from "../logger.js";
import { workerConfig } from "../config.js";
import { setFsTransfer } from "../lib/fs-transfer.js";

export type FsUploadPayload = {
  jobId: string;
  targetId: string;
  artifactId: string;
  destPath?: string;
  overwrite?: boolean;
  userId?: string;
};

export async function processFsUpload(job: Job<FsUploadPayload>) {
  const { jobId, targetId, artifactId, destPath, overwrite } = job.data;
  const db = getDb();
  const art = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .get();
  if (!art) throw new Error(`Artifact ${artifactId} not found`);

  const loaded = await loadTargetWithSecret(targetId);
  const jailRoot = getTargetJailRoot(loaded.config);
  const remoteDir = resolveJailedRemotePath(jailRoot, destPath ?? jailRoot);
  const localPath = path.join(artifactsDir(), art.storageName);
  const adapter = createRemoteFs(
    loaded.target.type,
    loaded.config,
    loaded.secret,
    {
      rclonePath: workerConfig.RCLONE_PATH,
    },
  );

  await setFsTransfer("upload", jobId, {
    status: "running",
    targetId,
    artifactId,
    fileName: art.fileName,
    remotePath: remoteDir,
    bytesDone: 0,
    bytesTotal: art.sizeBytes,
    progressPct: 0,
  });

  logger.info(
    { jobId, targetId, remoteDir, file: art.fileName, size: art.sizeBytes },
    "FS upload start",
  );

  let lastWrite = 0;
  try {
    const result = await adapter.upload({
      localPath,
      remoteDir,
      fileName: art.fileName,
      overwrite: overwrite !== false,
      onProgress: async ({ bytesDone, bytesTotal }) => {
        const total = bytesTotal > 0 ? bytesTotal : art.sizeBytes;
        const now = Date.now();
        // throttle redis writes ~4/s
        if (now - lastWrite < 250) return;
        lastWrite = now;
        await setFsTransfer("upload", jobId, {
          status: "running",
          bytesDone,
          bytesTotal: total,
          progressPct:
            total > 0 ? Math.min(99, Math.round((bytesDone / total) * 100)) : 0,
        });
      },
    });

    await setFsTransfer("upload", jobId, {
      status: "succeeded",
      bytesDone: art.sizeBytes,
      bytesTotal: art.sizeBytes,
      progressPct: 100,
      remoteFinalPath: result.remoteFinalPath,
    });
    logger.info({ jobId, result }, "FS upload done");
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setFsTransfer("upload", jobId, {
      status: "failed",
      errorMessage: message,
    });
    logger.error({ jobId, err: message }, "FS upload failed");
    throw err;
  }
}

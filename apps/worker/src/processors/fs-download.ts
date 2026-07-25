import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Job } from "bullmq";
import {
  createRemoteFs,
  getTargetJailRoot,
  remoteBasename,
  resolveJailedRemotePath,
} from "@omnidrop/remote-fs";
import { getDb, artifacts } from "@omnidrop/db";
import { loadTargetWithSecret } from "../lib/targets.js";
import { artifactsDir, ensureArtifactsDir } from "../lib/artifacts.js";
import { logger } from "../logger.js";
import { workerConfig } from "../config.js";
import { setFsTransfer } from "../lib/fs-transfer.js";

export type FsDownloadPayload = {
  jobId: string;
  targetId: string;
  remotePath: string;
  userId?: string;
  /** Optional note; defaults to target name when omitted */
  note?: string | null;
};

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(filePath);
    s.on("data", (c) => hash.update(c));
    s.on("error", reject);
    s.on("end", () => resolve());
  });
  return hash.digest("hex");
}

export async function processFsDownload(job: Job<FsDownloadPayload>) {
  const { jobId, targetId, remotePath, userId } = job.data;
  const loaded = await loadTargetWithSecret(targetId);
  const jailRoot = getTargetJailRoot(loaded.config);
  const jailed = resolveJailedRemotePath(jailRoot, remotePath);
  const adapter = createRemoteFs(
    loaded.target.type,
    loaded.config,
    loaded.secret,
    {
      rclonePath: workerConfig.RCLONE_PATH,
    },
  );

  await ensureArtifactsDir();
  const fileName = remoteBasename(jailed) || `download_${Date.now()}`;
  const artifactId = `art_${jobId.replace(/^fsd_/, "")}`;
  const dest = path.join(artifactsDir(), artifactId);

  const rawNote =
    job.data.note != null && String(job.data.note).trim() !== ""
      ? String(job.data.note).trim()
      : loaded.target.name
        ? `来自：${loaded.target.name}`
        : null;
  const note = rawNote ? rawNote.slice(0, 500) : null;

  await setFsTransfer("download", jobId, {
    status: "running",
    targetId,
    fileName,
    remotePath: jailed,
    bytesDone: 0,
    bytesTotal: null,
    progressPct: 0,
  });

  logger.info({ jobId, targetId, jailed, dest, note }, "FS download start");

  let lastWrite = 0;
  try {
    await adapter.download({
      remotePath: jailed,
      localPath: dest,
      onProgress: async ({ bytesDone, bytesTotal }) => {
        const now = Date.now();
        if (now - lastWrite < 250) return;
        lastWrite = now;
        await setFsTransfer("download", jobId, {
          status: "running",
          bytesDone,
          bytesTotal: bytesTotal > 0 ? bytesTotal : null,
          progressPct:
            bytesTotal > 0
              ? Math.min(99, Math.round((bytesDone / bytesTotal) * 100))
              : 0,
        });
      },
    });

    const st = await fs.stat(dest);
    const checksum = await sha256File(dest);
    const now = Date.now();
    const db = getDb();
    await db.insert(artifacts).values({
      id: artifactId,
      fileName,
      storageName: artifactId,
      sizeBytes: st.size,
      checksumSha256: checksum,
      contentType: null,
      sourceType: "remote",
      sourceUrl: `${loaded.target.type}://${targetId}${jailed}`,
      sourceJobId: jobId,
      note,
      createdBy: userId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    await setFsTransfer("download", jobId, {
      status: "succeeded",
      artifactId,
      fileName,
      bytesDone: st.size,
      bytesTotal: st.size,
      progressPct: 100,
    });

    logger.info({ jobId, artifactId, size: st.size, note }, "FS download done");
    return { artifactId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setFsTransfer("download", jobId, {
      status: "failed",
      errorMessage: message,
    });
    logger.error({ jobId, err: message }, "FS download failed");
    throw err;
  }
}

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
import { redis } from "../lib/redis.js";

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
  const adapter = createRemoteFs(loaded.target.type, loaded.config, loaded.secret, {
    rclonePath: workerConfig.RCLONE_PATH,
  });

  await ensureArtifactsDir();
  const fileName = remoteBasename(jailed) || `download_${Date.now()}`;
  const artifactId = `art_${jobId.replace(/^fsd_/, "")}`;
  const dest = path.join(artifactsDir(), artifactId);

  // Default note = target name so library rows show which server they came from
  const rawNote =
    job.data.note != null && String(job.data.note).trim() !== ""
      ? String(job.data.note).trim()
      : loaded.target.name
        ? `来自：${loaded.target.name}`
        : null;
  const note = rawNote ? rawNote.slice(0, 500) : null;

  logger.info({ jobId, targetId, jailed, dest, note }, "FS download start");
  await adapter.download({ remotePath: jailed, localPath: dest });

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

  await redis.set(
    `fs-download:${jobId}`,
    JSON.stringify({
      status: "succeeded",
      artifactId,
      fileName,
      sizeBytes: st.size,
      note,
    }),
    "EX",
    86400,
  );

  logger.info({ jobId, artifactId, size: st.size, note }, "FS download done");
  return { artifactId };
}

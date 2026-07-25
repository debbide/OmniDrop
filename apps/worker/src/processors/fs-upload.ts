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
import { redis } from "../lib/redis.js";

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
  const adapter = createRemoteFs(loaded.target.type, loaded.config, loaded.secret, {
    rclonePath: workerConfig.RCLONE_PATH,
  });

  logger.info({ jobId, targetId, remoteDir, file: art.fileName }, "FS upload start");
  const result = await adapter.upload({
    localPath,
    remoteDir,
    fileName: art.fileName,
    overwrite: overwrite !== false,
  });

  await redis.set(
    `fs-upload:${jobId}`,
    JSON.stringify({ status: "succeeded", ...result }),
    "EX",
    86400,
  );
  logger.info({ jobId, result }, "FS upload done");
  return result;
}

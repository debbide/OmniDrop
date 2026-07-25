import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, artifacts, jobs } from "@omnidrop/db";
import { workerConfig } from "../config.js";
import { logger } from "../logger.js";
import { randomBytes } from "node:crypto";

function resolveDataPath(p: string): string {
  if (path.isAbsolute(p)) return p;
  const rootish = path.resolve(
    process.cwd(),
    process.cwd().endsWith("worker") ? "../.." : ".",
  );
  return path.resolve(rootish, p);
}

export function artifactsDir(): string {
  return resolveDataPath(workerConfig.ARTIFACTS_DIR);
}

export async function ensureArtifactsDir(): Promise<void> {
  await fs.mkdir(artifactsDir(), { recursive: true });
}

function newArtifactId(): string {
  return `art_${randomBytes(16).toString("hex")}`;
}

/** Copy staging file into artifact library and link job. */
export async function promoteJobArtifact(opts: {
  jobId: string;
  tempPath: string;
  fileName: string;
  sizeBytes: number;
  checksumSha256: string;
  sourceType?: string | null;
  sourceUrl?: string | null;
  createdBy?: string | null;
}): Promise<string> {
  await ensureArtifactsDir();
  const db = getDb();
  const job = await db.select().from(jobs).where(eq(jobs.id, opts.jobId)).get();
  if (job?.artifactId) return job.artifactId;

  const id = newArtifactId();
  const dest = path.join(artifactsDir(), id);
  await fs.copyFile(opts.tempPath, dest);
  const now = Date.now();
  await db.insert(artifacts).values({
    id,
    fileName: opts.fileName,
    storageName: id,
    sizeBytes: opts.sizeBytes,
    checksumSha256: opts.checksumSha256,
    contentType: null,
    sourceType: opts.sourceType ?? null,
    sourceUrl: opts.sourceUrl ?? null,
    sourceJobId: opts.jobId,
    createdBy: opts.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
  await db.update(jobs).set({ artifactId: id }).where(eq(jobs.id, opts.jobId));
  logger.info({ jobId: opts.jobId, artifactId: id }, "Artifact promoted");
  return id;
}

export async function resolveJobLocalPath(job: {
  artifactId: string | null;
  tempPath: string | null;
}): Promise<string> {
  if (job.artifactId) {
    const row = await getDb()
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, job.artifactId))
      .get();
    if (!row) throw new Error(`Artifact ${job.artifactId} missing`);
    const p = path.join(artifactsDir(), row.storageName);
    await fs.access(p);
    return p;
  }
  if (job.tempPath) {
    await fs.access(job.tempPath);
    return job.tempPath;
  }
  throw new Error("No local file for job");
}

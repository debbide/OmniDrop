import fs from "node:fs/promises";
import path from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import {
  JobStatus,
  JobTargetStatus,
  SourceType,
  StepName,
  StepStatus,
  sanitizeFileName,
  type DispatchArtifactBody,
} from "@omnidrop/shared";
import {
  getDb,
  artifacts,
  jobs,
  jobTargets,
  jobSteps,
  shareLinks,
  targets,
} from "@omnidrop/db";
import { appConfig, resolveDataPath } from "../config.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { uploadQueue } from "../lib/queues.js";
import { audit } from "./audit-service.js";

export function artifactsDir(): string {
  return resolveDataPath(appConfig.ARTIFACTS_DIR);
}

export function artifactDiskPath(storageName: string): string {
  return path.join(artifactsDir(), storageName);
}

export async function ensureArtifactsDir(): Promise<void> {
  await fs.mkdir(artifactsDir(), { recursive: true });
}

function publicArtifact(row: typeof artifacts.$inferSelect) {
  return {
    id: row.id,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    contentType: row.contentType,
    sourceType: row.sourceType,
    sourceUrl: row.sourceUrl,
    sourceJobId: row.sourceJobId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listArtifacts(opts: { page?: number; pageSize?: number }) {
  const page = opts.page ?? 1;
  const pageSize = Math.min(opts.pageSize ?? 50, 100);
  const offset = (page - 1) * pageSize;
  const db = getDb();
  const rows = await db
    .select()
    .from(artifacts)
    .orderBy(desc(artifacts.createdAt))
    .limit(pageSize)
    .offset(offset)
    .all();
  const totalRow = await db
    .select({ c: sql<number>`count(*)` })
    .from(artifacts)
    .get();
  const sumRow = await db
    .select({ s: sql<number>`coalesce(sum(size_bytes),0)` })
    .from(artifacts)
    .get();
  return {
    items: rows.map(publicArtifact),
    page,
    pageSize,
    total: Number(totalRow?.c ?? 0),
    totalBytes: Number(sumRow?.s ?? 0),
  };
}

export async function getArtifact(id: string) {
  const db = getDb();
  const row = await db.select().from(artifacts).where(eq(artifacts.id, id)).get();
  if (!row) throw new AppError(404, "NOT_FOUND", "Artifact not found");
  return { row, public: publicArtifact(row) };
}

export async function renameArtifact(
  id: string,
  fileName: string,
  actor: { userId: string; ip?: string; userAgent?: string },
) {
  const safe = sanitizeFileName(fileName);
  if (safe.includes("..")) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid file name");
  }
  const { row } = await getArtifact(id);
  const db = getDb();
  await db
    .update(artifacts)
    .set({ fileName: safe, updatedAt: Date.now() })
    .where(eq(artifacts.id, id));
  await audit({
    actorUserId: actor.userId,
    actorType: "session",
    action: "artifact.rename",
    resourceType: "artifact",
    resourceId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    meta: { from: row.fileName, to: safe },
  });
  return (await getArtifact(id)).public;
}

export async function deleteArtifact(
  id: string,
  actor: { userId: string; ip?: string; userAgent?: string },
) {
  const { row } = await getArtifact(id);
  const db = getDb();
  // clear job refs
  await db
    .update(jobs)
    .set({ artifactId: null })
    .where(eq(jobs.artifactId, id));
  await db.delete(shareLinks).where(eq(shareLinks.artifactId, id));
  await db.delete(artifacts).where(eq(artifacts.id, id));
  await fs.unlink(artifactDiskPath(row.storageName)).catch(() => undefined);
  await audit({
    actorUserId: actor.userId,
    actorType: "session",
    action: "artifact.delete",
    resourceType: "artifact",
    resourceId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    meta: { fileName: row.fileName },
  });
}

/** Promote a finished download into the artifact library. */
export async function promoteFromJob(opts: {
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
  const existing = await db
    .select()
    .from(jobs)
    .where(eq(jobs.id, opts.jobId))
    .get();
  if (existing?.artifactId) return existing.artifactId;

  const id = newId("art");
  const storageName = id;
  const dest = artifactDiskPath(storageName);
  await fs.copyFile(opts.tempPath, dest);
  const now = Date.now();
  await db.insert(artifacts).values({
    id,
    fileName: opts.fileName,
    storageName,
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
  await db
    .update(jobs)
    .set({ artifactId: id })
    .where(eq(jobs.id, opts.jobId));
  return id;
}

export async function resolveLocalPathForJob(job: {
  artifactId: string | null;
  tempPath: string | null;
}): Promise<string> {
  if (job.artifactId) {
    const { row } = await getArtifact(job.artifactId);
    const p = artifactDiskPath(row.storageName);
    await fs.access(p);
    return p;
  }
  if (job.tempPath) {
    await fs.access(job.tempPath);
    return job.tempPath;
  }
  throw new AppError(409, "CONFLICT", "No local file available for this job");
}

export async function dispatchArtifact(
  artifactId: string,
  body: DispatchArtifactBody,
  userId: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const { row } = await getArtifact(artifactId);
  const db = getDb();
  const targetRows = await db.select().from(targets).all();
  const selected = targetRows.filter((t) => body.targetIds.includes(t.id));
  if (selected.length !== body.targetIds.length) {
    throw new AppError(400, "VALIDATION_ERROR", "One or more targets not found");
  }
  if (selected.some((t) => !t.enabled)) {
    throw new AppError(400, "VALIDATION_ERROR", "Some targets are disabled");
  }

  const jobId = newId("job");
  const ts = Date.now();
  await db.insert(jobs).values({
    id: jobId,
    name: `Redispatch ${row.fileName}`,
    sourceType: SourceType.ARTIFACT,
    sourceUrl: `artifact://${artifactId}`,
    status: JobStatus.UPLOADING,
    checksumSha256: row.checksumSha256,
    bytesTotal: row.sizeBytes,
    bytesDone: row.sizeBytes,
    fileName: row.fileName,
    artifactId,
    optionsJson: JSON.stringify(body.options ?? {}),
    createdBy: userId,
    createdAt: ts,
    startedAt: ts,
  });

  for (const t of selected) {
    const jtgId = newId("jtg");
    await db.insert(jobTargets).values({
      id: jtgId,
      jobId,
      targetId: t.id,
      status: JobTargetStatus.PENDING,
      bytesDone: 0,
      attempts: 0,
    });
    await db.insert(jobSteps).values({
      id: `stp_${jtgId}`,
      jobId,
      jobTargetId: jtgId,
      step: StepName.UPLOAD,
      status: StepStatus.PENDING,
      progressPct: 0,
      updatedAt: ts,
    });
    await uploadQueue.add(
      "upload",
      { jobId, jobTargetId: jtgId },
      { jobId: `upload-${jtgId}` },
    );
  }

  await audit({
    actorUserId: userId,
    actorType: "session",
    action: "artifact.dispatch",
    resourceType: "artifact",
    resourceId: artifactId,
    ip: meta?.ip,
    userAgent: meta?.userAgent,
    meta: { jobId, targetIds: body.targetIds },
  });

  return { jobId };
}

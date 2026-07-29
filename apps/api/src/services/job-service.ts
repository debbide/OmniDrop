import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  JobStatus,
  JobTargetStatus,
  SourceType,
  StepName,
  StepStatus,
  TERMINAL_JOB_STATUSES,
  REDIS_KEYS,
  fileNameFromUrl,
  type CreateJobBody,
} from "@omnidrop/shared";
import { getDb, jobs, jobTargets, jobSteps, targets } from "@omnidrop/db";
import { appConfig } from "../config.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { downloadQueue, cleanupQueue, uploadQueue } from "../lib/queues.js";
import { redis } from "../lib/redis.js";
import { getArtifact } from "./artifact-service.js";

function now() {
  return Date.now();
}

export async function listJobs(opts: {
  status?: string;
  page?: number;
  pageSize?: number;
}) {
  const page = opts.page ?? 1;
  const pageSize = Math.min(opts.pageSize ?? 20, 100);
  const offset = (page - 1) * pageSize;
  const db = getDb();

  const rows = opts.status
    ? await db
        .select()
        .from(jobs)
        .where(eq(jobs.status, opts.status))
        .orderBy(desc(jobs.createdAt))
        .limit(pageSize)
        .offset(offset)
        .all()
    : await db
        .select()
        .from(jobs)
        .orderBy(desc(jobs.createdAt))
        .limit(pageSize)
        .offset(offset)
        .all();

  const totalRow = opts.status
    ? await db
        .select({ c: sql<number>`count(*)` })
        .from(jobs)
        .where(eq(jobs.status, opts.status))
        .get()
    : await db.select({ c: sql<number>`count(*)` }).from(jobs).get();

  return {
    items: rows.map(serializeJobBrief),
    page,
    pageSize,
    total: Number(totalRow?.c ?? 0),
  };
}

export async function getJobDetail(id: string) {
  const db = getDb();
  const job = await db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) throw new AppError(404, "NOT_FOUND", "Job not found");

  const jts = await db
    .select({
      jt: jobTargets,
      targetName: targets.name,
      targetType: targets.type,
    })
    .from(jobTargets)
    .leftJoin(targets, eq(jobTargets.targetId, targets.id))
    .where(eq(jobTargets.jobId, id))
    .all();

  const steps = await db
    .select()
    .from(jobSteps)
    .where(eq(jobSteps.jobId, id))
    .all();

  return {
    ...serializeJobBrief(job),
    sourceMeta: job.sourceMetaJson ? JSON.parse(job.sourceMetaJson) : null,
    options: job.optionsJson ? JSON.parse(job.optionsJson) : {},
    tempPath: job.tempPath,
    artifactId: job.artifactId,
    targets: jts.map(({ jt, targetName, targetType }) => ({
      id: jt.id,
      targetId: jt.targetId,
      name: targetName,
      type: targetType,
      status: jt.status,
      bytesTotal: jt.bytesTotal,
      bytesDone: jt.bytesDone,
      remoteFinalPath: jt.remoteFinalPath,
      errorMessage: jt.errorMessage,
      attempts: jt.attempts,
      startedAt: jt.startedAt,
      finishedAt: jt.finishedAt,
      progressPct:
        jt.status === JobTargetStatus.SUCCEEDED
          ? 100
          : jt.bytesTotal && jt.bytesTotal > 0
            ? Math.min(100, Math.round((jt.bytesDone / jt.bytesTotal) * 100))
            : 0,
    })),
    steps: steps.map((s) => ({
      id: s.id,
      jobTargetId: s.jobTargetId,
      step: s.step,
      status: s.status,
      progressPct: s.progressPct,
      detail: s.detail,
      updatedAt: s.updatedAt,
    })),
  };
}

function serializeJobBrief(job: typeof jobs.$inferSelect) {
  return {
    id: job.id,
    name: job.name,
    sourceType: job.sourceType,
    sourceUrl: job.sourceUrl,
    status: job.status,
    checksumSha256: job.checksumSha256,
    bytesTotal: job.bytesTotal,
    bytesDone: job.bytesDone,
    fileName: job.fileName,
    artifactId: job.artifactId,
    errorMessage: job.errorMessage,
    createdBy: job.createdBy,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progressPct:
      // Always 100 when fully succeeded (upload may never emit mid-progress)
      job.status === JobStatus.SUCCEEDED
        ? 100
        : job.bytesTotal && job.bytesTotal > 0
          ? Math.min(100, Math.round((job.bytesDone / job.bytesTotal) * 100))
          : 0,
  };
}

export async function createJob(body: CreateJobBody, userId: string) {
  const db = getDb();
  const targetIds = body.targetIds ?? [];
  let targetRows: (typeof targets.$inferSelect)[] = [];

  if (targetIds.length > 0) {
    targetRows = await db
      .select()
      .from(targets)
      .where(inArray(targets.id, targetIds))
      .all();

    if (targetRows.length !== targetIds.length) {
      throw new AppError(400, "VALIDATION_ERROR", "One or more targets not found");
    }
    const disabled = targetRows.filter((t) => !t.enabled);
    if (disabled.length) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Disabled targets: ${disabled.map((t) => t.name).join(", ")}`,
      );
    }
  }

  const jobId = newId("job");
  const ts = now();

  // Upload from library: skip download, enqueue uploads only
  if (body.sourceType === SourceType.ARTIFACT) {
    if (!targetRows.length) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Select at least one target to upload from the library",
      );
    }
    const { row: art } = await getArtifact(body.artifactId!);
    await db.insert(jobs).values({
      id: jobId,
      name: body.name ?? art.fileName,
      sourceType: SourceType.ARTIFACT,
      sourceUrl: `artifact://${art.id}`,
      status: JobStatus.UPLOADING,
      checksumSha256: art.checksumSha256,
      // Start at 0 so list/detail progress can move during upload
      bytesTotal: art.sizeBytes,
      bytesDone: 0,
      fileName: art.fileName,
      artifactId: art.id,
      optionsJson: JSON.stringify(body.options ?? {}),
      createdBy: userId,
      createdAt: ts,
      startedAt: ts,
    });

    for (const t of targetRows) {
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
    return getJobDetail(jobId);
  }

  // Download into library (optionally also upload if targetIds provided)
  const fileName =
    body.sourceType === "github_release" && body.sourceMeta?.assetName
      ? body.sourceMeta.assetName
      : fileNameFromUrl(body.sourceUrl!);

  await db.insert(jobs).values({
    id: jobId,
    name: body.name ?? fileName,
    sourceType: body.sourceType,
    sourceUrl: body.sourceUrl!,
    sourceMetaJson: body.sourceMeta ? JSON.stringify(body.sourceMeta) : null,
    status: JobStatus.QUEUED,
    fileName,
    optionsJson: JSON.stringify(body.options ?? {}),
    createdBy: userId,
    createdAt: ts,
    bytesDone: 0,
  });

  for (const t of targetRows) {
    await db.insert(jobTargets).values({
      id: newId("jtg"),
      jobId,
      targetId: t.id,
      status: JobTargetStatus.PENDING,
      bytesDone: 0,
      attempts: 0,
    });
  }

  await db.insert(jobSteps).values({
    id: newId("stp"),
    jobId,
    jobTargetId: null,
    step: StepName.DOWNLOAD,
    status: StepStatus.PENDING,
    progressPct: 0,
    updatedAt: ts,
  });

  await downloadQueue.add("download", { jobId }, { jobId: `download-${jobId}` });

  return getJobDetail(jobId);
}

export async function cancelJob(id: string) {
  const db = getDb();
  const job = await db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) throw new AppError(404, "NOT_FOUND", "Job not found");
  if (TERMINAL_JOB_STATUSES.includes(job.status as never)) {
    throw new AppError(409, "CONFLICT", "Job already finished");
  }

  await redis.set(REDIS_KEYS.jobCancel(id), "1", "EX", 3600);

  const ts = now();
  await db
    .update(jobs)
    .set({
      status: JobStatus.CANCELED,
      errorMessage: "Canceled by user",
      finishedAt: ts,
    })
    .where(eq(jobs.id, id));

  await db
    .update(jobTargets)
    .set({ status: JobTargetStatus.CANCELED, finishedAt: ts })
    .where(
      and(
        eq(jobTargets.jobId, id),
        inArray(jobTargets.status, [
          JobTargetStatus.PENDING,
          JobTargetStatus.UPLOADING,
        ]),
      ),
    );

  try {
    const qj = await downloadQueue.getJob(`download-${id}`);
    if (qj) await qj.remove();
  } catch {
    /* ignore */
  }

  return getJobDetail(id);
}

/** Delete job record (and cascade targets/steps). Does not delete artifacts. */
export async function deleteJob(id: string) {
  const db = getDb();
  const job = await db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) throw new AppError(404, "NOT_FOUND", "Job not found");

  // Stop running work first
  if (!TERMINAL_JOB_STATUSES.includes(job.status as never)) {
    await redis.set(REDIS_KEYS.jobCancel(id), "1", "EX", 3600);
    try {
      const qj = await downloadQueue.getJob(`download-${id}`);
      if (qj) await qj.remove();
    } catch {
      /* ignore */
    }
  }

  // job_targets / job_steps cascade via FK
  await db.delete(jobs).where(eq(jobs.id, id));
  await redis.del(REDIS_KEYS.jobProgress(id)).catch(() => undefined);
  await redis.del(REDIS_KEYS.jobEvents(id)).catch(() => undefined);
  await redis.del(REDIS_KEYS.jobCancel(id)).catch(() => undefined);
  return { ok: true as const, id };
}

/** Retry failed download (Range resume from .part) when no targets / download failed */
export async function retryDownload(id: string) {
  const db = getDb();
  const job = await db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) throw new AppError(404, "NOT_FOUND", "Job not found");
  if (job.sourceType === "artifact") {
    throw new AppError(409, "CONFLICT", "Artifact upload jobs have no download step");
  }
  if (job.status !== JobStatus.FAILED && job.status !== JobStatus.CANCELED) {
    throw new AppError(409, "CONFLICT", "Only failed/canceled downloads can be retried");
  }
  // clear cancel flag so resume can run
  await redis.del(REDIS_KEYS.jobCancel(id));
  await db
    .update(jobs)
    .set({
      status: JobStatus.QUEUED,
      errorMessage: null,
      finishedAt: null,
    })
    .where(eq(jobs.id, id));

  const steps = await db
    .select()
    .from(jobSteps)
    .where(eq(jobSteps.jobId, id))
    .all();
  const dl = steps.find((s) => s.step === StepName.DOWNLOAD);
  if (dl) {
    await db
      .update(jobSteps)
      .set({
        status: StepStatus.PENDING,
        progressPct: 0,
        detail: "resume pending",
        updatedAt: Date.now(),
      })
      .where(eq(jobSteps.id, dl.id));
  }

  await downloadQueue.add(
    "download",
    { jobId: id },
    { jobId: `download-${id}-retry-${Date.now()}` },
  );
  return getJobDetail(id);
}

export async function retryFailedTargets(id: string) {
  const db = getDb();
  const job = await db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) throw new AppError(404, "NOT_FOUND", "Job not found");
  if (!job.artifactId && (!job.tempPath || !job.checksumSha256)) {
    // If download failed mid-way, offer download resume instead
    if (job.status === JobStatus.FAILED || job.status === JobStatus.CANCELED) {
      return retryDownload(id);
    }
    throw new AppError(
      409,
      "CONFLICT",
      "Job has no downloaded artifact to retry upload",
    );
  }

  const failed = await db
    .select()
    .from(jobTargets)
    .where(
      and(eq(jobTargets.jobId, id), eq(jobTargets.status, JobTargetStatus.FAILED)),
    )
    .all();

  if (!failed.length) {
    throw new AppError(409, "CONFLICT", "No failed targets to retry");
  }

  await db
    .update(jobs)
    .set({
      status: JobStatus.UPLOADING,
      errorMessage: null,
      finishedAt: null,
    })
    .where(eq(jobs.id, id));

  for (const jt of failed) {
    await db
      .update(jobTargets)
      .set({
        status: JobTargetStatus.PENDING,
        errorMessage: null,
        finishedAt: null,
        bytesDone: 0,
      })
      .where(eq(jobTargets.id, jt.id));

    await uploadQueue.add(
      "upload",
      { jobId: id, jobTargetId: jt.id },
      { jobId: `upload-${jt.id}-${Date.now()}` },
    );
  }

  return getJobDetail(id);
}

export async function scheduleCleanup(jobId: string) {
  const delay = appConfig.JOB_TMP_TTL_MINUTES * 60 * 1000;
  await cleanupQueue.add(
    "cleanup",
    { jobId },
    { delay, jobId: `cleanup-${jobId}` },
  );
}

export async function getDashboardStats() {
  const db = getDb();
  const all = await db.select().from(jobs).all();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const sod = startOfDay.getTime();

  const running = all.filter((j) =>
    [
      JobStatus.QUEUED,
      JobStatus.DOWNLOADING,
      JobStatus.READY,
      JobStatus.UPLOADING,
    ].includes(j.status as never),
  ).length;
  const today = all.filter((j) => (j.finishedAt ?? j.createdAt) >= sod);
  const succeededToday = today.filter((j) => j.status === JobStatus.SUCCEEDED).length;
  const failedToday = today.filter(
    (j) => j.status === JobStatus.FAILED || j.status === JobStatus.PARTIAL,
  ).length;

  return {
    running,
    succeededToday,
    failedToday,
    total: all.length,
    recent: all
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10)
      .map(serializeJobBrief),
  };
}

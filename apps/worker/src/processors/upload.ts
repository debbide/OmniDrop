import { eq } from "drizzle-orm";
import {
  JobStatus,
  JobTargetStatus,
  StepName,
  StepStatus,
  QUEUE_NAMES,
} from "@omnidrop/shared";
import {
  createRemoteFs,
  getTargetJailRoot,
  resolveJailedRemotePath,
} from "@omnidrop/remote-fs";
import { getDb, jobs, jobSteps, jobTargets } from "@omnidrop/db";
import type { Job } from "bullmq";
import { Queue } from "bullmq";
import { loadTargetWithSecret } from "../lib/targets.js";
import { isCanceled, publishJobEvent } from "../lib/progress.js";
import { redis } from "../lib/redis.js";
import { workerConfig } from "../config.js";
import { logger } from "../logger.js";
import { resolveJobLocalPath } from "../lib/artifacts.js";

const cleanupQueue = new Queue(QUEUE_NAMES.CLEANUP, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: 50,
    removeOnFail: 50,
  },
});

export async function processUpload(
  job: Job<{ jobId: string; jobTargetId: string }>,
) {
  const { jobId, jobTargetId } = job.data;
  const db = getDb();

  const parent = await db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  const jt = await db
    .select()
    .from(jobTargets)
    .where(eq(jobTargets.id, jobTargetId))
    .get();

  if (!parent || !jt) {
    logger.warn({ jobId, jobTargetId }, "upload job missing rows");
    return;
  }

  if (await isCanceled(jobId)) {
    await db
      .update(jobTargets)
      .set({ status: JobTargetStatus.CANCELED, finishedAt: Date.now() })
      .where(eq(jobTargets.id, jobTargetId));
    return;
  }

  let localPath: string;
  try {
    localPath = await resolveJobLocalPath(parent);
  } catch {
    throw new Error("Artifact not ready for upload");
  }

  const ts = Date.now();
  await db
    .update(jobTargets)
    .set({
      status: JobTargetStatus.UPLOADING,
      startedAt: jt.startedAt ?? ts,
      attempts: (jt.attempts ?? 0) + 1,
      bytesTotal: parent.bytesTotal,
    })
    .where(eq(jobTargets.id, jobTargetId));

  const steps = await db
    .select()
    .from(jobSteps)
    .where(eq(jobSteps.jobId, jobId))
    .all();
  const step = steps.find(
    (s) => s.jobTargetId === jobTargetId && s.step === StepName.UPLOAD,
  );

  if (step) {
    await db
      .update(jobSteps)
      .set({ status: StepStatus.RUNNING, updatedAt: ts })
      .where(eq(jobSteps.id, step.id));
  }

  await publishJobEvent(jobId, "target.updated", {
    jobTargetId,
    status: JobTargetStatus.UPLOADING,
  });

  const loaded = await loadTargetWithSecret(jt.targetId);
  const options = parent.optionsJson ? JSON.parse(parent.optionsJson) : {};
  const ac = new AbortController();

  const cancelPoll = setInterval(() => {
    void isCanceled(jobId).then((c) => {
      if (c) ac.abort();
    });
  }, 1000);

  try {
    const jailRoot = getTargetJailRoot(loaded.config);
    // Prefer job option destPath (from 目标文件浏览器「上传到此目录」)
    const destOverride =
      typeof options.destPath === "string" && options.destPath.trim()
        ? options.destPath.trim()
        : jailRoot;
    const remoteDir = resolveJailedRemotePath(jailRoot, destOverride);
    const adapter = createRemoteFs(
      loaded.target.type,
      loaded.config,
      loaded.secret,
      { rclonePath: workerConfig.RCLONE_PATH },
    );

    // Throttle SQLite writes; still push SSE every tick for live UI
    let lastDbWrite = 0;
    const totalHint = parent.bytesTotal ?? 0;
    logger.info(
      { jobId, jobTargetId, remoteDir, file: parent.fileName },
      "Upload start",
    );
    const result = await adapter.upload({
      localPath,
      remoteDir,
      fileName: parent.fileName ?? pathBasename(localPath),
      overwrite: options.overwrite !== false,
      signal: ac.signal,
      onProgress: async ({ bytesDone, bytesTotal }) => {
        const total = bytesTotal > 0 ? bytesTotal : totalHint;
        const pct =
          total > 0 ? Math.min(100, Math.round((bytesDone / total) * 100)) : 0;
        const now = Date.now();
        if (now - lastDbWrite > 800) {
          lastDbWrite = now;
          await db
            .update(jobTargets)
            .set({
              bytesDone,
              bytesTotal: total > 0 ? total : undefined,
            })
            .where(eq(jobTargets.id, jobTargetId));
          // Mirror onto parent job so top progress bar / polling see movement
          await db
            .update(jobs)
            .set({
              bytesDone,
              bytesTotal: total > 0 ? total : parent.bytesTotal,
              status: JobStatus.UPLOADING,
            })
            .where(eq(jobs.id, jobId));
          if (step) {
            await db
              .update(jobSteps)
              .set({
                progressPct: pct,
                updatedAt: now,
                detail: `上传 ${bytesDone}${total > 0 ? ` / ${total}` : ""}`,
              })
              .where(eq(jobSteps.id, step.id));
          }
        }
        // Always emit both events so SSE clients refresh job + target rows
        await publishJobEvent(jobId, "target.updated", {
          jobTargetId,
          id: jobTargetId,
          bytesDone,
          bytesTotal: total > 0 ? total : null,
          progressPct: pct,
          status: JobTargetStatus.UPLOADING,
        });
        await publishJobEvent(jobId, "job.updated", {
          id: jobId,
          status: JobStatus.UPLOADING,
          bytesDone,
          bytesTotal: total > 0 ? total : parent.bytesTotal ?? null,
          progressPct: pct,
          phase: "uploading",
        });
      },
    });

    const doneAt = Date.now();
    // Prefer known artifact/job size; never leave 0 after a successful upload
    const finalBytes =
      parent.bytesTotal && parent.bytesTotal > 0
        ? parent.bytesTotal
        : jt.bytesTotal && jt.bytesTotal > 0
          ? jt.bytesTotal
          : jt.bytesDone && jt.bytesDone > 0
            ? jt.bytesDone
            : 0;
    await db
      .update(jobTargets)
      .set({
        status: JobTargetStatus.SUCCEEDED,
        remoteFinalPath: result.remoteFinalPath,
        bytesDone: finalBytes,
        bytesTotal: finalBytes || parent.bytesTotal,
        finishedAt: doneAt,
      })
      .where(eq(jobTargets.id, jobTargetId));

    // Parent job must show 100% even when rclone never emitted onProgress
    await db
      .update(jobs)
      .set({
        bytesDone: finalBytes || parent.bytesDone || 0,
        bytesTotal: finalBytes || parent.bytesTotal,
      })
      .where(eq(jobs.id, jobId));

    if (step) {
      await db
        .update(jobSteps)
        .set({
          status: StepStatus.SUCCEEDED,
          progressPct: 100,
          detail: result.remoteFinalPath,
          updatedAt: doneAt,
        })
        .where(eq(jobSteps.id, step.id));
    }

    await publishJobEvent(jobId, "target.updated", {
      jobTargetId,
      id: jobTargetId,
      status: JobTargetStatus.SUCCEEDED,
      bytesDone: finalBytes,
      bytesTotal: finalBytes || parent.bytesTotal,
      progressPct: 100,
      remoteFinalPath: result.remoteFinalPath,
    });
    await publishJobEvent(jobId, "job.updated", {
      id: jobId,
      status: JobStatus.UPLOADING,
      bytesDone: finalBytes,
      bytesTotal: finalBytes || parent.bytesTotal,
      progressPct: 100,
      phase: "uploading",
    });

    await finalizeParentJob(jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const canceled = ac.signal.aborted || (await isCanceled(jobId));
    const status = canceled ? JobTargetStatus.CANCELED : JobTargetStatus.FAILED;

    await db
      .update(jobTargets)
      .set({
        status,
        errorMessage: message,
        finishedAt: Date.now(),
      })
      .where(eq(jobTargets.id, jobTargetId));

    if (step) {
      await db
        .update(jobSteps)
        .set({
          status: StepStatus.FAILED,
          detail: message,
          updatedAt: Date.now(),
        })
        .where(eq(jobSteps.id, step.id));
    }

    await publishJobEvent(jobId, "target.updated", {
      jobTargetId,
      status,
      errorMessage: message,
    });

    await finalizeParentJob(jobId);
    if (!canceled) throw err;
  } finally {
    clearInterval(cancelPoll);
  }
}

function pathBasename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() || "file.bin";
}

async function finalizeParentJob(jobId: string) {
  const db = getDb();
  const jts = await db
    .select()
    .from(jobTargets)
    .where(eq(jobTargets.jobId, jobId))
    .all();

  const pending = jts.some(
    (j) =>
      j.status === JobTargetStatus.PENDING ||
      j.status === JobTargetStatus.UPLOADING,
  );
  if (pending) return;

  const succeeded = jts.filter((j) => j.status === JobTargetStatus.SUCCEEDED).length;
  const failed = jts.filter((j) => j.status === JobTargetStatus.FAILED).length;
  const canceled = jts.filter((j) => j.status === JobTargetStatus.CANCELED).length;

  let status: string = JobStatus.SUCCEEDED;
  if (canceled && succeeded === 0 && failed === 0) status = JobStatus.CANCELED;
  else if (failed > 0 && succeeded > 0) status = JobStatus.PARTIAL;
  else if (failed > 0 && succeeded === 0) status = JobStatus.FAILED;
  else if (canceled && succeeded > 0) status = JobStatus.PARTIAL;

  await db
    .update(jobs)
    .set({ status, finishedAt: Date.now() })
    .where(eq(jobs.id, jobId));

  await publishJobEvent(jobId, "job.finished", { id: jobId, status });

  const delay = workerConfig.JOB_TMP_TTL_MINUTES * 60 * 1000;
  await cleanupQueue.add(
    "cleanup",
    { jobId },
    { delay, jobId: `cleanup-${jobId}` },
  );

  logger.info({ jobId, status, succeeded, failed }, "Job finalized");
}

import { eq } from "drizzle-orm";
import {
  JobStatus,
  JobTargetStatus,
  QUEUE_NAMES,
  SourceType,
  StepName,
  StepStatus,
} from "@omnidrop/shared";
import {
  getDb,
  jobs,
  jobSteps,
  jobTargets,
  settings as settingsTable,
} from "@omnidrop/db";
import type { Job } from "bullmq";
import { Queue } from "bullmq";
import {
  jobTempDir,
  resolveGithubAssetUrl,
  streamDownloadToFile,
} from "../download/stream-download.js";
import { isCanceled, publishJobEvent, setProgressFields } from "../lib/progress.js";
import { redis } from "../lib/redis.js";
import { workerConfig } from "../config.js";
import { logger } from "../logger.js";
import { promoteJobArtifact } from "../lib/artifacts.js";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/** Throttle SQLite progress writes per job (SSE still fires every progress tick). */
const lastDbWriteAt = new Map<string, number>();

const uploadQueue = new Queue(QUEUE_NAMES.UPLOAD, {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 8000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

async function readGithubToken(): Promise<string | undefined> {
  const db = getDb();
  const row = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, "githubToken"))
    .get();
  if (row) {
    try {
      const v = JSON.parse(row.valueJson) as string | null;
      if (v) return v;
    } catch {
      /* ignore */
    }
  }
  return workerConfig.GITHUB_TOKEN;
}

export async function processDownload(job: Job<{ jobId: string }>) {
  const { jobId } = job.data;
  const db = getDb();
  const row = await db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!row) {
    logger.warn({ jobId }, "Job missing");
    return;
  }
  if (await isCanceled(jobId)) {
    logger.info({ jobId }, "Skip download, canceled");
    return;
  }

  const ts = Date.now();
  await db
    .update(jobs)
    .set({ status: JobStatus.DOWNLOADING, startedAt: row.startedAt ?? ts })
    .where(eq(jobs.id, jobId));

  const allSteps = await db
    .select()
    .from(jobSteps)
    .where(eq(jobSteps.jobId, jobId))
    .all();
  const downloadStep = allSteps.find((s) => s.step === StepName.DOWNLOAD);

  if (downloadStep) {
    await db
      .update(jobSteps)
      .set({ status: StepStatus.RUNNING, updatedAt: ts })
      .where(eq(jobSteps.id, downloadStep.id));
  }

  await publishJobEvent(jobId, "job.updated", {
    id: jobId,
    status: JobStatus.DOWNLOADING,
  });

  try {
    const options = row.optionsJson ? JSON.parse(row.optionsJson) : {};
    let url = row.sourceUrl;
    let fileName = row.fileName ?? undefined;
    const headers: Record<string, string> = {};

    if (row.sourceType === SourceType.GITHUB_RELEASE) {
      const meta = row.sourceMetaJson ? JSON.parse(row.sourceMetaJson) : {};
      const token = await readGithubToken();
      const resolved = await resolveGithubAssetUrl({
        repoUrl: row.sourceUrl,
        tag: meta.tag,
        assetName: meta.assetName,
        token,
      });
      url = resolved.url;
      fileName = resolved.fileName;
      if (token) headers.Authorization = `Bearer ${token}`;
      headers.Accept = "application/octet-stream";
    }

    const destDir = jobTempDir(jobId);
    const result = await streamDownloadToFile({
      jobId,
      url,
      destDir,
      fileName,
      expectedSha256: options.expectedSha256,
      headers,
      resume: true,
      onProgress: async ({ bytesDone, bytesTotal, resumedFrom, phase }) => {
        // Throttle SQLite writes (every ~1s) but publish Redis/SSE every tick
        // so the UI moves even when Content-Length is unknown.
        const pct =
          bytesTotal && bytesTotal > 0
            ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100))
            : 0;
        const now = Date.now();
        const prevWrite = lastDbWriteAt.get(jobId) ?? 0;
        const shouldWriteDb = now - prevWrite > 1000;
        if (shouldWriteDb) {
          lastDbWriteAt.set(jobId, now);
          await db
            .update(jobs)
            .set({
              bytesDone,
              bytesTotal: bytesTotal ?? undefined,
            })
            .where(eq(jobs.id, jobId));
          if (downloadStep) {
            const detail =
              phase === "hashing"
                ? "校验 SHA256…"
                : resumedFrom && resumedFrom > 0
                  ? `断点续传自 ${formatBytes(resumedFrom)} · 已下 ${formatBytes(bytesDone)}`
                  : `已下载 ${formatBytes(bytesDone)}${
                      bytesTotal && bytesTotal > 0
                        ? ` / ${formatBytes(bytesTotal)}`
                        : ""
                    }`;
            await db
              .update(jobSteps)
              .set({
                progressPct: pct,
                updatedAt: now,
                detail,
              })
              .where(eq(jobSteps.id, downloadStep.id));
          }
        }
        await setProgressFields(jobId, {
          bytesDone,
          bytesTotal: bytesTotal ?? 0,
          phase: phase ?? "download",
          resumedFrom: resumedFrom ?? 0,
          progressPct: pct,
        });
        // Always push live progress to SSE (UI listens to this)
        await publishJobEvent(jobId, "job.updated", {
          id: jobId,
          status: JobStatus.DOWNLOADING,
          bytesDone,
          bytesTotal: bytesTotal ?? null,
          progressPct: pct,
          phase: phase ?? "downloading",
          resumedFrom: resumedFrom ?? 0,
        });
      },
    });

    if (await isCanceled(jobId)) {
      throw new Error("Job canceled");
    }

    const doneAt = Date.now();
    await db
      .update(jobs)
      .set({
        status: JobStatus.READY,
        tempPath: result.filePath,
        fileName: result.fileName,
        checksumSha256: result.checksumSha256,
        bytesTotal: result.bytesTotal,
        bytesDone: result.bytesTotal,
      })
      .where(eq(jobs.id, jobId));

    // Promote into durable artifact library (survives tmp cleanup)
    const artifactId = await promoteJobArtifact({
      jobId,
      tempPath: result.filePath,
      fileName: result.fileName,
      sizeBytes: result.bytesTotal,
      checksumSha256: result.checksumSha256,
      sourceType: row.sourceType,
      sourceUrl: row.sourceUrl,
      createdBy: row.createdBy,
    });

    if (downloadStep) {
      await db
        .update(jobSteps)
        .set({
          status: StepStatus.SUCCEEDED,
          progressPct: 100,
          detail: `sha256=${result.checksumSha256}; artifact=${artifactId}${
            result.resumed ? "; resumed=1" : ""
          }`,
          updatedAt: doneAt,
        })
        .where(eq(jobSteps.id, downloadStep.id));
    }

    await publishJobEvent(jobId, "job.updated", {
      id: jobId,
      status: JobStatus.READY,
      checksumSha256: result.checksumSha256,
      bytesTotal: result.bytesTotal,
      artifactId,
    });

    const jts = (
      await db.select().from(jobTargets).where(eq(jobTargets.jobId, jobId)).all()
    ).filter((jt) => jt.status === JobTargetStatus.PENDING);

    // Download-only: no targets → finish as succeeded (file is in library)
    if (!jts.length) {
      await db
        .update(jobs)
        .set({
          status: JobStatus.SUCCEEDED,
          finishedAt: Date.now(),
        })
        .where(eq(jobs.id, jobId));
      await publishJobEvent(jobId, "job.finished", {
        id: jobId,
        status: JobStatus.SUCCEEDED,
        artifactId,
      });
      logger.info(
        { jobId, file: result.fileName, bytes: result.bytesTotal, artifactId },
        "Download-only complete (library)",
      );
      return;
    }

    await db
      .update(jobs)
      .set({ status: JobStatus.UPLOADING })
      .where(eq(jobs.id, jobId));

    for (const jt of jts) {
      await db.insert(jobSteps).values({
        id: `stp_${jt.id}`,
        jobId,
        jobTargetId: jt.id,
        step: StepName.UPLOAD,
        status: StepStatus.PENDING,
        progressPct: 0,
        updatedAt: Date.now(),
      });

      await uploadQueue.add(
        "upload",
        { jobId, jobTargetId: jt.id },
        { jobId: `upload-${jt.id}` },
      );
    }

    await publishJobEvent(jobId, "job.updated", {
      id: jobId,
      status: JobStatus.UPLOADING,
    });

    logger.info(
      { jobId, file: result.fileName, bytes: result.bytesTotal },
      "Download complete, uploading",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const canceled =
      message.toLowerCase().includes("canceled") ||
      message.toLowerCase().includes("cancelled");
    const status =
      (await isCanceled(jobId)) || canceled ? JobStatus.CANCELED : JobStatus.FAILED;

    await db
      .update(jobs)
      .set({
        status,
        errorMessage: message,
        finishedAt: Date.now(),
      })
      .where(eq(jobs.id, jobId));

    if (downloadStep) {
      await db
        .update(jobSteps)
        .set({
          status: StepStatus.FAILED,
          detail: message,
          updatedAt: Date.now(),
        })
        .where(eq(jobSteps.id, downloadStep.id));
    }

    await publishJobEvent(jobId, "job.finished", {
      id: jobId,
      status,
      errorMessage: message,
    });

    if (status === JobStatus.FAILED) throw err;
  }
}

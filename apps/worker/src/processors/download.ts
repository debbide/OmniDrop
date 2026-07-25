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
      // settings may store JSON string or raw string depending on writer
      const raw = row.valueJson;
      let v: unknown = raw;
      try {
        v = JSON.parse(raw) as unknown;
      } catch {
        v = raw;
      }
      if (typeof v === "string" && v.trim()) return v.trim();
      if (v && typeof v === "object" && "token" in (v as object)) {
        const t = String((v as { token?: string }).token ?? "").trim();
        if (t) return t;
      }
    } catch {
      /* ignore */
    }
  }
  const env = workerConfig.GITHUB_TOKEN;
  return env && env.trim() ? env.trim() : undefined;
}

/**
 * For HTTP jobs pointing at GitHub, attach the global token so private
 * repo raw files / release assets / contents API work.
 * Also rewrites common blob / raw UI URLs to downloadable forms.
 */
function attachGithubAuthIfNeeded(
  inputUrl: string,
  token: string | undefined,
): { url: string; headers: Record<string, string> } {
  let url = inputUrl;
  const headers: Record<string, string> = {
    "User-Agent": "OmniDrop",
  };

  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { url, headers };
  }

  const isGithub =
    host === "github.com" ||
    host === "www.github.com" ||
    host === "raw.githubusercontent.com" ||
    host === "api.github.com" ||
    host.endsWith(".github.com") ||
    host.endsWith(".githubusercontent.com");

  if (!isGithub) return { url, headers };

  // github.com/owner/repo/blob/REF/path → raw.githubusercontent.com/owner/repo/REF/path
  const blob = url.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+?)(?:\?.*)?$/i,
  );
  if (blob) {
    url = `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`;
    host = "raw.githubusercontent.com";
  }

  // github.com/owner/repo/raw/REF/path → raw.githubusercontent.com
  const rawUi = url.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+?)(?:\?.*)?$/i,
  );
  if (rawUi) {
    url = `https://raw.githubusercontent.com/${rawUi[1]}/${rawUi[2]}/${rawUi[3]}/${rawUi[4]}`;
    host = "raw.githubusercontent.com";
  }

  if (!token) {
    logger.warn(
      { url },
      "HTTP GitHub URL without token — private files will 404",
    );
    return { url, headers };
  }

  headers.Authorization = `Bearer ${token}`;
  headers["X-GitHub-Api-Version"] = "2022-11-28";

  // Release asset browser URL / API asset URL
  if (
    /github\.com\/[^/]+\/[^/]+\/releases\/download\//i.test(url) ||
    /api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\//i.test(url)
  ) {
    headers.Accept = "application/octet-stream";
  } else if (host === "api.github.com" && /\/contents\//i.test(url)) {
    // Contents API: ask for raw file body
    headers.Accept = "application/vnd.github.raw";
  } else if (host === "raw.githubusercontent.com") {
    headers.Accept = "application/octet-stream";
  } else {
    headers.Accept = "application/vnd.github+json, application/octet-stream, */*";
  }

  return { url, headers };
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
      if (!token) {
        logger.warn({ jobId }, "GitHub download without token (public only)");
      }
      const resolved = await resolveGithubAssetUrl({
        repoUrl: row.sourceUrl,
        tag: meta.tag,
        assetName: meta.assetName,
        assetId: meta.assetId,
        token,
      });
      url = resolved.url;
      fileName = resolved.fileName;
      if (token) headers.Authorization = `Bearer ${token}`;
      headers.Accept = resolved.accept;
      headers["User-Agent"] = "OmniDrop";
      headers["X-GitHub-Api-Version"] = "2022-11-28";
    } else if (row.sourceType === SourceType.HTTP) {
      // Auto-attach global GitHub token for github.com / raw.githubusercontent.com
      // so private repo files and release assets work via HTTP 直链.
      const gh = attachGithubAuthIfNeeded(url, await readGithubToken());
      url = gh.url;
      Object.assign(headers, gh.headers);
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

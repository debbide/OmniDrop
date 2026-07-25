import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import axios from "axios";
import {
  fileNameFromUrl,
  formatGithubApiError,
  githubReleasePathSegment,
  parseGithubRepoUrl,
  sanitizeFileName,
} from "@omnidrop/shared";
import { workerConfig } from "../config.js";
import { isCanceled } from "../lib/progress.js";
import { logger } from "../logger.js";

export type DownloadResult = {
  filePath: string;
  fileName: string;
  bytesTotal: number;
  checksumSha256: string;
  resumed: boolean;
};

export type DownloadProgress = {
  bytesDone: number;
  bytesTotal: number | null;
  resumedFrom?: number;
  phase?: "downloading" | "hashing";
};

type PartMeta = {
  url: string;
  expectedTotal: number | null;
  etag: string | null;
};

export async function resolveGithubAssetUrl(opts: {
  repoUrl: string;
  tag?: string;
  assetName?: string;
  assetId?: number;
  token?: string;
}): Promise<{ url: string; fileName: string; accept: string }> {
  const { owner, repo } = parseGithubRepoUrl(opts.repoUrl);
  const usedToken = Boolean(opts.token);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "OmniDrop",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const tagPath = githubReleasePathSegment(opts.tag);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/${tagPath}`;

  let data: {
    tag_name?: string;
    assets?: Array<{
      id: number;
      name: string;
      url: string;
      browser_download_url: string;
    }>;
  };
  try {
    const res = await axios.get(apiUrl, { headers, timeout: 60_000 });
    data = res.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const status = err.response.status;
      const bodyMessage =
        typeof err.response.data === "object" &&
        err.response.data &&
        "message" in err.response.data
          ? String((err.response.data as { message?: string }).message)
          : undefined;
      throw new Error(
        formatGithubApiError({
          status,
          owner,
          repo,
          tagPath,
          usedToken,
          bodyMessage,
        }),
      );
    }
    throw err;
  }

  const assets = data.assets ?? [];
  if (!assets.length) {
    throw new Error(
      `Release ${data.tag_name ?? tagPath} 没有可下载的附件（Assets）。` +
        `若只有源码压缩包，请在 GitHub 上为该 Release 上传构建产物，或改用 HTTP 直链。`,
    );
  }

  let asset = assets[0]!;
  if (opts.assetId) {
    const found = assets.find((a) => a.id === opts.assetId);
    if (!found) {
      throw new Error(
        `Asset id ${opts.assetId} 不在该 Release 中。可选：${assets
          .map((a) => `${a.name}(#${a.id})`)
          .join(", ")}`,
      );
    }
    asset = found;
  } else if (opts.assetName) {
    const found = assets.find(
      (a) => a.name === opts.assetName || a.name.includes(opts.assetName!),
    );
    if (!found) {
      throw new Error(
        `找不到资源 ${opts.assetName}。可选：${assets.map((a) => a.name).join(", ")}`,
      );
    }
    asset = found;
  }

  // Private repos: browser_download_url often 404s. Use API asset URL + octet-stream.
  return {
    url: asset.url,
    fileName: sanitizeFileName(asset.name),
    accept: "application/octet-stream",
  };
}

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

async function readPartMeta(metaPath: string): Promise<PartMeta | null> {
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    return JSON.parse(raw) as PartMeta;
  } catch {
    return null;
  }
}

/**
 * Stream download with HTTP Range resume.
 * Partial data is kept in `file.part` (+ `.part.json` meta) until complete.
 */
export async function streamDownloadToFile(opts: {
  jobId: string;
  url: string;
  destDir: string;
  fileName?: string;
  expectedSha256?: string | null;
  headers?: Record<string, string>;
  resume?: boolean;
  onProgress?: (p: DownloadProgress) => void | Promise<void>;
}): Promise<DownloadResult> {
  await fs.mkdir(opts.destDir, { recursive: true });
  const fileName = opts.fileName ?? fileNameFromUrl(opts.url);
  const filePath = path.join(opts.destDir, fileName);
  const partPath = `${filePath}.part`;
  const metaPath = `${filePath}.part.json`;
  const resumeEnabled = opts.resume !== false;

  const clearPart = async () => {
    await fs.unlink(partPath).catch(() => undefined);
    await fs.unlink(metaPath).catch(() => undefined);
  };

  // If final file already complete (edge case), return it
  try {
    const finalSt = await fs.stat(filePath);
    if (finalSt.size > 0) {
      const checksumSha256 = await sha256File(filePath);
      if (
        !opts.expectedSha256 ||
        opts.expectedSha256.toLowerCase() === checksumSha256.toLowerCase()
      ) {
        return {
          filePath,
          fileName,
          bytesTotal: finalSt.size,
          checksumSha256,
          resumed: false,
        };
      }
    }
  } catch {
    /* no final yet */
  }

  // Attempt 1: resume from .part if present. On 416 / bad range, wipe and full re-download.
  let forceFull = !resumeEnabled;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await runDownloadAttempt({
        opts,
        fileName,
        filePath,
        partPath,
        metaPath,
        forceFull,
        clearPart,
      });
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retriable =
        /\b416\b/.test(msg) ||
        /Range Not Satisfiable/i.test(msg) ||
        /Range mismatch/i.test(msg) ||
        /Download incomplete/i.test(msg);
      if (attempt === 0 && retriable) {
        logger.warn(
          { jobId: opts.jobId, err: msg },
          "Download resume failed; clearing partial and retrying full",
        );
        await clearPart();
        forceFull = true;
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function runDownloadAttempt(args: {
  opts: {
    jobId: string;
    url: string;
    expectedSha256?: string | null;
    headers?: Record<string, string>;
    onProgress?: (p: DownloadProgress) => void | Promise<void>;
  };
  fileName: string;
  filePath: string;
  partPath: string;
  metaPath: string;
  forceFull: boolean;
  clearPart: () => Promise<void>;
}): Promise<DownloadResult> {
  const { opts, fileName, filePath, partPath, metaPath, forceFull, clearPart } =
    args;

  let existing = 0;
  if (!forceFull) {
    try {
      const st = await fs.stat(partPath);
      existing = st.size;
    } catch {
      existing = 0;
    }
  } else {
    await clearPart();
  }

  // Stale part larger than previously known total → restart full
  if (existing > 0) {
    const meta = await readPartMeta(metaPath);
    if (meta && meta.url !== opts.url) {
      logger.info({ jobId: opts.jobId }, "Part meta URL mismatch, restart download");
      await clearPart();
      existing = 0;
    } else if (
      meta?.expectedTotal != null &&
      meta.expectedTotal > 0 &&
      existing > meta.expectedTotal
    ) {
      logger.info(
        { jobId: opts.jobId, existing, expectedTotal: meta.expectedTotal },
        "Part larger than expected total; restart full download",
      );
      await clearPart();
      existing = 0;
    }
  }

  const baseHeaders: Record<string, string> = {
    "User-Agent": "OmniDrop",
    ...(opts.headers ?? {}),
  };
  // Never send Range on force-full (prevents GitHub 416 loops)
  delete baseHeaders.Range;
  delete baseHeaders.range;

  let resumed = false;
  let bytesDone = existing;
  let bytesTotal: number | null = null;
  let headerClaimedTotal: number | null = null;

  if (existing > 0) {
    const meta = await readPartMeta(metaPath);
    baseHeaders.Range = `bytes=${existing}-`;
    resumed = true;
    if (meta?.expectedTotal) bytesTotal = meta.expectedTotal;
  }

  let response;
  try {
    response = await axios.get(opts.url, {
      responseType: "stream",
      timeout: 0,
      maxRedirects: 5,
      headers: baseHeaders,
      // 416 must not be "success" — handled in catch for auto-restart
      validateStatus: (s) => s === 200 || s === 206,
    });
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const status = err.response.status;
      // Drain body so socket can reuse
      try {
        err.response.data?.destroy?.();
      } catch {
        /* */
      }
      const isGithub =
        typeof opts.url === "string" &&
        (opts.url.includes("github.com") ||
          opts.url.includes("githubusercontent.com"));
      if (status === 416) {
        throw new Error(
          `下载失败 HTTP 416（Range 不可用，将尝试整文件重下）: ${opts.url}`,
        );
      }
      if (isGithub && status === 404) {
        throw new Error(
          "下载资源 404：私有库请确认已配置有权限的 GitHub Token；" +
            "或该文件不存在。",
        );
      }
      if (isGithub && (status === 401 || status === 403)) {
        throw new Error(
          `下载资源 ${status}：GitHub Token 无效、过期或无权访问该仓库/资源。请到「设置」检查 Token。`,
        );
      }
      throw new Error(`下载失败 HTTP ${status}: ${opts.url}`);
    }
    throw err;
  }

  // Server ignored Range → full body; discard partial
  if (response.status === 200 && existing > 0) {
    logger.warn(
      { jobId: opts.jobId, existing },
      "Server ignored Range (200); restarting full download",
    );
    await clearPart();
    existing = 0;
    bytesDone = 0;
    resumed = false;
  }

  if (response.status !== 200 && response.status !== 206) {
    response.data?.destroy?.();
    throw new Error(`Download failed with HTTP ${response.status}`);
  }

  if (response.status === 206) {
    resumed = true;
    const cr = String(response.headers["content-range"] ?? "");
    const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
    if (m && Number(m[1]) !== existing) {
      response.data?.destroy?.();
      throw new Error(
        `Range mismatch: requested ${existing}, server started at ${m[1]}`,
      );
    }
    if (m && m[3] !== "*") {
      bytesTotal = Number(m[3]);
      headerClaimedTotal = bytesTotal;
    } else {
      const cl = response.headers["content-length"]
        ? Number(response.headers["content-length"])
        : null;
      if (cl != null && Number.isFinite(cl)) {
        bytesTotal = existing + cl;
        headerClaimedTotal = bytesTotal;
      }
    }
  } else {
    // 200 full — Content-Length is only a hint (CDNs/GitHub may lie or omit)
    const cl = response.headers["content-length"]
      ? Number(response.headers["content-length"])
      : null;
    bytesTotal = cl != null && Number.isFinite(cl) && cl > 0 ? cl : null;
    headerClaimedTotal = bytesTotal;
    existing = 0;
    bytesDone = 0;
    resumed = false;
  }

  const etag = (response.headers.etag as string | undefined) ?? null;
  await fs.writeFile(
    metaPath,
    JSON.stringify({
      url: opts.url,
      expectedTotal: bytesTotal,
      etag,
    } satisfies PartMeta),
    "utf8",
  );

  if (opts.onProgress) {
    await opts.onProgress({
      bytesDone,
      bytesTotal,
      resumedFrom: resumed ? existing : 0,
      phase: "downloading",
    });
  }

  const append = existing > 0 && response.status === 206;
  const writeStream = createWriteStream(partPath, {
    flags: append ? "a" : "w",
  });

  let lastEmit = 0;
  let firstChunk = true;
  const transform = new Transform({
    transform(chunk, _enc, cb) {
      void (async () => {
        try {
          if (await isCanceled(opts.jobId)) {
            cb(new Error("Job canceled"));
            return;
          }
          bytesDone += chunk.length;
          const now = Date.now();
          if (opts.onProgress && (firstChunk || now - lastEmit > 250)) {
            firstChunk = false;
            lastEmit = now;
            await opts.onProgress({
              bytesDone,
              bytesTotal,
              resumedFrom: resumed ? existing : 0,
              phase: "downloading",
            });
          }
          cb(null, chunk);
        } catch (err) {
          cb(err as Error);
        }
      })();
    },
  });

  try {
    await pipeline(response.data, transform, writeStream);
  } catch (err) {
    throw err;
  }

  const st = await fs.stat(partPath);

  // Size check: only fail if we got FEWER bytes than a trusted total.
  // If we got MORE than Content-Length (GitHub raw/CDN quirks), accept actual size.
  if (headerClaimedTotal != null && st.size < headerClaimedTotal) {
    throw new Error(
      `Download incomplete: got ${st.size} bytes, expected ${headerClaimedTotal}`,
    );
  }
  if (headerClaimedTotal != null && st.size > headerClaimedTotal) {
    logger.warn(
      {
        jobId: opts.jobId,
        got: st.size,
        contentLength: headerClaimedTotal,
      },
      "Downloaded more than Content-Length; accepting actual size",
    );
  }

  const finalTotal = st.size;

  if (opts.onProgress) {
    await opts.onProgress({
      bytesDone: finalTotal,
      bytesTotal: finalTotal,
      resumedFrom: resumed ? existing : 0,
      phase: "hashing",
    });
  }

  const checksumSha256 = await sha256File(partPath);
  if (
    opts.expectedSha256 &&
    opts.expectedSha256.toLowerCase() !== checksumSha256.toLowerCase()
  ) {
    await clearPart();
    throw new Error(
      `Checksum mismatch: expected ${opts.expectedSha256}, got ${checksumSha256}`,
    );
  }

  await fs.unlink(filePath).catch(() => undefined);
  await fs.rename(partPath, filePath);
  await fs.unlink(metaPath).catch(() => undefined);

  if (opts.onProgress) {
    await opts.onProgress({
      bytesDone: finalTotal,
      bytesTotal: finalTotal,
      resumedFrom: resumed ? existing : 0,
      phase: "downloading",
    });
  }

  logger.info(
    {
      jobId: opts.jobId,
      fileName,
      size: finalTotal,
      resumed,
      from: resumed ? existing : 0,
    },
    "Download finished",
  );

  return {
    filePath,
    fileName,
    bytesTotal: finalTotal,
    checksumSha256,
    resumed,
  };
}

export function jobTempDir(jobId: string): string {
  const base = path.isAbsolute(workerConfig.TMP_DIR)
    ? workerConfig.TMP_DIR
    : path.resolve(
        process.cwd().endsWith("worker") ? "../.." : process.cwd(),
        workerConfig.TMP_DIR,
      );
  return path.join(base, jobId);
}

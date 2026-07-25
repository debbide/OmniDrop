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

  let existing = 0;
  if (resumeEnabled) {
    try {
      const st = await fs.stat(partPath);
      existing = st.size;
    } catch {
      existing = 0;
    }
  } else {
    await fs.unlink(partPath).catch(() => undefined);
    await fs.unlink(metaPath).catch(() => undefined);
  }

  // If final file already complete (edge case), return it
  try {
    const finalSt = await fs.stat(filePath);
    if (finalSt.size > 0 && existing === 0) {
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

  const baseHeaders: Record<string, string> = {
    "User-Agent": "OmniDrop",
    ...(opts.headers ?? {}),
  };

  let resumed = false;
  let bytesDone = existing;
  let bytesTotal: number | null = null;

  if (existing > 0) {
    const meta = await readPartMeta(metaPath);
    if (meta && meta.url !== opts.url) {
      logger.info({ jobId: opts.jobId }, "Part meta URL mismatch, restart download");
      await fs.unlink(partPath).catch(() => undefined);
      await fs.unlink(metaPath).catch(() => undefined);
      existing = 0;
      bytesDone = 0;
    } else {
      baseHeaders.Range = `bytes=${existing}-`;
      resumed = true;
      if (meta?.expectedTotal) bytesTotal = meta.expectedTotal;
    }
  }

  let response;
  try {
    response = await axios.get(opts.url, {
      responseType: "stream",
      timeout: 0,
      maxRedirects: 5,
      headers: baseHeaders,
      // Do not treat 3xx as success without body; axios follows redirects itself.
      validateStatus: (s) => s === 200 || s === 206,
    });
  } catch (err) {
    // keep .part for next retry; surface GitHub-ish 404/401 clearly
    if (axios.isAxiosError(err) && err.response) {
      const status = err.response.status;
      const isGithub =
        typeof opts.url === "string" &&
        (opts.url.includes("github.com") || opts.url.includes("githubusercontent.com"));
      if (isGithub && status === 404) {
        throw new Error(
          "下载资源 404：私有库请确认已配置有权限的 GitHub Token；" +
            "或该 Asset 不存在。请删除任务后用「解析 Release」重新选择资源再下。",
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

  // Follow is handled by axios; if server ignores Range and returns 200 with full body
  if (response.status === 200 && existing > 0) {
    logger.warn(
      { jobId: opts.jobId, existing },
      "Server ignored Range (200); restarting full download",
    );
    await fs.unlink(partPath).catch(() => undefined);
    await fs.unlink(metaPath).catch(() => undefined);
    existing = 0;
    bytesDone = 0;
    resumed = false;
  }

  if (response.status !== 200 && response.status !== 206) {
    // destroy stream body
    response.data?.destroy?.();
    throw new Error(`Download failed with HTTP ${response.status}`);
  }

  if (response.status === 206) {
    resumed = true;
    const cr = String(response.headers["content-range"] ?? "");
    // bytes start-end/total
    const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
    if (m && m[3] !== "*") {
      bytesTotal = Number(m[3]);
    } else {
      const cl = response.headers["content-length"]
        ? Number(response.headers["content-length"])
        : null;
      if (cl != null) bytesTotal = existing + cl;
    }
    // If server started at wrong offset, restart
    if (m && Number(m[1]) !== existing) {
      response.data?.destroy?.();
      throw new Error(
        `Range mismatch: requested ${existing}, server started at ${m[1]}`,
      );
    }
  } else {
    // 200 full
    const cl = response.headers["content-length"]
      ? Number(response.headers["content-length"])
      : null;
    bytesTotal = cl;
    existing = 0;
    bytesDone = 0;
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
          // Emit immediately on first chunk, then every ~250ms
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
    // Keep .part for resume unless canceled
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("canceled")) {
      // user cancel: leave part so manual retry can resume, or clean?
      // keep part for resume on retry
    }
    throw err;
  }

  // Verify size if known
  const st = await fs.stat(partPath);
  if (bytesTotal != null && st.size !== bytesTotal) {
    // incomplete — keep part for resume
    throw new Error(
      `Download incomplete: got ${st.size} bytes, expected ${bytesTotal}`,
    );
  }

  if (opts.onProgress) {
    await opts.onProgress({
      bytesDone: st.size,
      bytesTotal: bytesTotal ?? st.size,
      resumedFrom: resumed ? existing : 0,
      phase: "hashing",
    });
  }

  const checksumSha256 = await sha256File(partPath);
  if (
    opts.expectedSha256 &&
    opts.expectedSha256.toLowerCase() !== checksumSha256.toLowerCase()
  ) {
    await fs.unlink(partPath).catch(() => undefined);
    await fs.unlink(metaPath).catch(() => undefined);
    throw new Error(
      `Checksum mismatch: expected ${opts.expectedSha256}, got ${checksumSha256}`,
    );
  }

  // Atomic-ish promote part → final
  await fs.unlink(filePath).catch(() => undefined);
  await fs.rename(partPath, filePath);
  await fs.unlink(metaPath).catch(() => undefined);

  if (opts.onProgress) {
    await opts.onProgress({
      bytesDone: st.size,
      bytesTotal: st.size,
      resumedFrom: resumed ? existing : 0,
      phase: "downloading",
    });
  }

  logger.info(
    {
      jobId: opts.jobId,
      fileName,
      size: st.size,
      resumed,
      from: resumed ? existing : 0,
    },
    "Download finished",
  );

  return {
    filePath,
    fileName,
    bytesTotal: st.size,
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

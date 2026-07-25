import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import axios from "axios";
import { fileNameFromUrl, sanitizeFileName } from "@omnidrop/shared";
import { workerConfig } from "../config.js";
import { isCanceled } from "../lib/progress.js";

export type DownloadResult = {
  filePath: string;
  fileName: string;
  bytesTotal: number;
  checksumSha256: string;
};

export type DownloadProgress = {
  bytesDone: number;
  bytesTotal: number | null;
};

export async function resolveGithubAssetUrl(opts: {
  repoUrl: string;
  tag?: string;
  assetName?: string;
  token?: string;
}): Promise<{ url: string; fileName: string }> {
  const m = opts.repoUrl.match(
    /github\.com\/([^/]+)\/([^/#?]+)/i,
  );
  if (!m) throw new Error("Invalid GitHub repository URL");
  const owner = m[1];
  const repo = m[2]!.replace(/\.git$/, "");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "OmniDrop",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const tag = opts.tag && opts.tag !== "latest" ? `tags/${opts.tag}` : "latest";
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/${tag}`;
  const { data } = await axios.get(apiUrl, { headers, timeout: 60_000 });
  const assets = (data.assets ?? []) as Array<{
    name: string;
    browser_download_url: string;
  }>;
  if (!assets.length) throw new Error("Release has no assets");

  let asset = assets[0]!;
  if (opts.assetName) {
    const found = assets.find(
      (a) => a.name === opts.assetName || a.name.includes(opts.assetName!),
    );
    if (!found) {
      throw new Error(
        `Asset not found: ${opts.assetName}. Available: ${assets.map((a) => a.name).join(", ")}`,
      );
    }
    asset = found;
  }

  return { url: asset.browser_download_url, fileName: sanitizeFileName(asset.name) };
}

export async function streamDownloadToFile(opts: {
  jobId: string;
  url: string;
  destDir: string;
  fileName?: string;
  expectedSha256?: string | null;
  headers?: Record<string, string>;
  onProgress?: (p: DownloadProgress) => void | Promise<void>;
}): Promise<DownloadResult> {
  await fs.mkdir(opts.destDir, { recursive: true });
  const fileName = opts.fileName ?? fileNameFromUrl(opts.url);
  const filePath = path.join(opts.destDir, fileName);

  const response = await axios.get(opts.url, {
    responseType: "stream",
    timeout: 0,
    maxRedirects: 5,
    headers: {
      "User-Agent": "OmniDrop",
      ...(opts.headers ?? {}),
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });

  if (response.status >= 400) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }

  const contentLength = response.headers["content-length"]
    ? Number(response.headers["content-length"])
    : null;

  const hash = createHash("sha256");
  let bytesDone = 0;
  let lastEmit = 0;

  const transform = new Transform({
    transform(chunk, _enc, cb) {
      void (async () => {
        try {
          if (await isCanceled(opts.jobId)) {
            cb(new Error("Job canceled"));
            return;
          }
          bytesDone += chunk.length;
          hash.update(chunk);
          const now = Date.now();
          if (opts.onProgress && now - lastEmit > 500) {
            lastEmit = now;
            await opts.onProgress({ bytesDone, bytesTotal: contentLength });
          }
          cb(null, chunk);
        } catch (err) {
          cb(err as Error);
        }
      })();
    },
  });

  const writeStream = createWriteStream(filePath);
  try {
    await pipeline(response.data, transform, writeStream);
  } catch (err) {
    await fs.unlink(filePath).catch(() => undefined);
    throw err;
  }

  if (opts.onProgress) {
    await opts.onProgress({ bytesDone, bytesTotal: contentLength ?? bytesDone });
  }

  const checksumSha256 = hash.digest("hex");
  if (
    opts.expectedSha256 &&
    opts.expectedSha256.toLowerCase() !== checksumSha256.toLowerCase()
  ) {
    await fs.unlink(filePath).catch(() => undefined);
    throw new Error(
      `Checksum mismatch: expected ${opts.expectedSha256}, got ${checksumSha256}`,
    );
  }

  return {
    filePath,
    fileName,
    bytesTotal: bytesDone,
    checksumSha256,
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

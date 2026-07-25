import { eq } from "drizzle-orm";
import {
  formatGithubApiError,
  githubReleasePathSegment,
  parseGithubRepoUrl,
  type GithubReleasePreview,
  type PreviewGithubReleaseBody,
} from "@omnidrop/shared";
import { getDb, settings as settingsTable } from "@omnidrop/db";
import { appConfig } from "../config.js";
import { AppError } from "../lib/errors.js";

async function readGithubToken(): Promise<string | undefined> {
  const db = getDb();
  const row = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, "githubToken"))
    .get();
  if (row) {
    try {
      const raw = row.valueJson;
      let v: unknown = raw;
      try {
        v = JSON.parse(raw) as unknown;
      } catch {
        v = raw;
      }
      if (typeof v === "string" && v.trim()) return v.trim();
    } catch {
      /* ignore */
    }
  }
  const env = appConfig.GITHUB_TOKEN;
  return env && env.trim() ? env.trim() : undefined;
}

export async function hasGithubTokenConfigured(): Promise<boolean> {
  return Boolean(await readGithubToken());
}

export async function previewGithubRelease(
  body: PreviewGithubReleaseBody,
): Promise<GithubReleasePreview> {
  const { owner, repo } = parseGithubRepoUrl(body.repoUrl);
  const token = await readGithubToken();
  const usedToken = Boolean(token);
  const tagPath = githubReleasePathSegment(body.tag);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/${tagPath}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "OmniDrop",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(apiUrl, { headers });
  } catch (err) {
    throw new AppError(
      502,
      "GITHUB_UNREACHABLE",
      err instanceof Error ? err.message : "无法连接 GitHub API",
    );
  }

  if (!res.ok) {
    let bodyMessage: string | undefined;
    try {
      const j = (await res.json()) as { message?: string };
      bodyMessage = j.message;
    } catch {
      /* ignore */
    }
    const msg = formatGithubApiError({
      status: res.status,
      owner,
      repo,
      tagPath,
      usedToken,
      bodyMessage,
    });
    throw new AppError(
      res.status === 404 ? 404 : res.status === 401 || res.status === 403 ? 400 : 502,
      "GITHUB_API_ERROR",
      msg,
    );
  }

  const data = (await res.json()) as {
    tag_name?: string;
    name?: string | null;
    published_at?: string | null;
    assets?: Array<{
      id: number;
      name: string;
      size: number;
      content_type?: string;
      url: string;
      browser_download_url: string;
    }>;
  };

  const assets = (data.assets ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    size: a.size,
    contentType: a.content_type ?? null,
    apiUrl: a.url,
    browserUrl: a.browser_download_url,
  }));

  return {
    owner,
    repo,
    tag: data.tag_name ?? (body.tag && body.tag !== "latest" ? body.tag : "latest"),
    name: data.name ?? null,
    publishedAt: data.published_at ?? null,
    assets,
    usedToken,
  };
}

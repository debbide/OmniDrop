/** Parse owner/repo from a GitHub repository URL. */
export function parseGithubRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!m) {
    throw new Error("无效的 GitHub 仓库 URL，请使用 https://github.com/owner/repo");
  }
  return {
    owner: m[1]!,
    repo: m[2]!.replace(/\.git$/, ""),
  };
}

/** Build GitHub REST release path segment for tag (latest or tags/v1.0.0). */
export function githubReleasePathSegment(tag?: string): string {
  if (!tag || tag === "latest") return "latest";
  return `tags/${tag}`;
}

export type GithubReleaseAsset = {
  id: number;
  name: string;
  size: number;
  contentType: string | null;
  /** Authenticated download URL (works for private repos with token) */
  apiUrl: string;
  /** Public browser URL (private repos often 404 without session cookie) */
  browserUrl: string;
};

export type GithubReleasePreview = {
  owner: string;
  repo: string;
  tag: string;
  name: string | null;
  publishedAt: string | null;
  assets: GithubReleaseAsset[];
  /** Whether a token was used for this request */
  usedToken: boolean;
};

export function formatGithubApiError(opts: {
  status: number;
  owner: string;
  repo: string;
  tagPath: string;
  usedToken: boolean;
  bodyMessage?: string;
}): string {
  const { status, owner, repo, tagPath, usedToken, bodyMessage } = opts;
  if (status === 401) {
    return "GitHub Token 无效或已过期，请在「设置」中重新填写。";
  }
  if (status === 403) {
    return usedToken
      ? "GitHub 拒绝访问（403）：Token 权限不足或触发了 API 限流。"
      : "GitHub 拒绝访问（403）：请在「设置」配置 GitHub Token。";
  }
  if (status === 404) {
    if (!usedToken) {
      return (
        `GitHub 返回 404：仓库 ${owner}/${repo} 不存在、为私有库，或没有可用的 Release。` +
        `私有库必须在「设置」配置有权访问该仓库的 GitHub Token。`
      );
    }
    return (
      `GitHub 返回 404：在 ${owner}/${repo} 找不到 Release（${tagPath}）。` +
      `请确认：① 仓库名正确 ② 已发布 Release（不是只有 tag）③ Tag 填写正确（如 v1.0.0，不要写错）` +
      `④ Token 对该仓库有 Contents/Metadata 读权限。` +
      (bodyMessage ? ` GitHub: ${bodyMessage}` : "")
    );
  }
  return `GitHub API 错误 ${status}${bodyMessage ? `: ${bodyMessage}` : ""}`;
}

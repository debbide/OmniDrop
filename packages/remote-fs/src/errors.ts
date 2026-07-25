/** Normalize protocol/tool errors into short, actionable messages. */
export function humanizeRemoteError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.replace(/\s+/g, " ").trim();

  if (/Failed to start rclone|ENOENT|not found|Is rclone installed/i.test(msg)) {
    return "rclone 未安装或不在 PATH。VPS/Docker 镜像已内置；本机请安装 rclone 并重启 API/Worker。";
  }
  if (/connection refused|ECONNREFUSED/i.test(msg)) {
    return "连接被拒绝：请检查主机、端口与防火墙。";
  }
  if (/timed out|timeout|deadline exceeded/i.test(msg)) {
    return "连接或操作超时：请检查网络、目标是否可达，或增大超时。";
  }
  if (/authentication|permission denied|401|403|invalid user|login incorrect/i.test(msg)) {
    return "认证失败：请检查用户名/密码/私钥/API Key。";
  }
  if (/host key|known_hosts|REMOTE HOST IDENTIFICATION/i.test(msg)) {
    return "SFTP Host Key 校验失败：可改用 accept-new，或配置 knownHosts 后使用 strict。";
  }
  if (/certificate|TLS|SSL|x509/i.test(msg)) {
    return "TLS/证书错误：检查 FTPS/WebDAV HTTPS 证书，或临时开启 insecureTls（仅调试）。";
  }
  if (/no such file|not found|404|directory not found/i.test(msg)) {
    return "远端路径不存在。";
  }
  if (/disk|quota|no space|ENOSPC/i.test(msg)) {
    return "远端磁盘空间不足或配额已满。";
  }
  // strip long rclone conf paths from message
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}

export class RemoteFsError extends Error {
  constructor(
    message: string,
    public code:
      | "RCLONE_MISSING"
      | "AUTH"
      | "TIMEOUT"
      | "NETWORK"
      | "NOT_FOUND"
      | "TLS"
      | "HOST_KEY"
      | "REMOTE"
      | "VALIDATION" = "REMOTE",
  ) {
    super(message);
    this.name = "RemoteFsError";
  }
}

export function classifyRemoteError(err: unknown): RemoteFsError {
  const human = humanizeRemoteError(err);
  const raw = err instanceof Error ? err.message : String(err);
  if (/Failed to start rclone|ENOENT|Is rclone installed/i.test(raw)) {
    return new RemoteFsError(human, "RCLONE_MISSING");
  }
  if (/authentication|permission denied|401|403|login incorrect/i.test(raw)) {
    return new RemoteFsError(human, "AUTH");
  }
  if (/timed out|timeout/i.test(raw)) {
    return new RemoteFsError(human, "TIMEOUT");
  }
  if (/ECONNREFUSED|connection refused|network/i.test(raw)) {
    return new RemoteFsError(human, "NETWORK");
  }
  if (/host key|known_hosts/i.test(raw)) {
    return new RemoteFsError(human, "HOST_KEY");
  }
  if (/certificate|TLS|SSL|x509/i.test(raw)) {
    return new RemoteFsError(human, "TLS");
  }
  if (/no such file|not found|404/i.test(raw)) {
    return new RemoteFsError(human, "NOT_FOUND");
  }
  if (/escapes|Invalid|Remote path/i.test(raw)) {
    return new RemoteFsError(human, "VALIDATION");
  }
  return new RemoteFsError(human, "REMOTE");
}

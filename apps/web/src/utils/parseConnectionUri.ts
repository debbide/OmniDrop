/**
 * Parse pasteable connection URIs into form fields.
 *
 * Supported examples:
 *   sftp://user:pass@host:2022/path
 *   sftp://user@host:22
 *   ftp://user:pass@host:21
 *   ftps://user@host
 *   user@host:2022
 *   sftp://user:pass@host
 *
 * Edge cases like `sftp://user@host:port` and empty password `sftp://user:@host:port`.
 */

export type ParsedConnection = {
  type?: "sftp" | "ftp";
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  remotePath?: string;
  secure?: "plain" | "explicit" | "implicit";
  authMethod?: "password" | "privateKey";
};

function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

/**
 * Manual parse for schemes URL may mishandle (empty host, password with special chars).
 * Pattern: [scheme://][user[:password]@]host[:port][/path]
 */
export function parseConnectionUri(raw: string): ParsedConnection | null {
  const input = raw.trim();
  if (!input) return null;

  let rest = input;
  let type: "sftp" | "ftp" | undefined;
  let secure: "plain" | "explicit" | "implicit" | undefined;

  const schemeMatch = rest.match(/^(sftp|ftp|ftps|sftps):\/\/(.*)$/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    rest = schemeMatch[2]!;
    if (scheme === "sftp" || scheme === "sftps") {
      type = "sftp";
    } else if (scheme === "ftps") {
      type = "ftp";
      secure = "explicit";
    } else {
      type = "ftp";
      secure = "plain";
    }
  }

  // Split userinfo @ hostport/path — use last @ (password may contain @ rarely; take last)
  let userinfo: string | undefined;
  let hostPart = rest;
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    userinfo = rest.slice(0, at);
    hostPart = rest.slice(at + 1);
  }

  let username: string | undefined;
  let password: string | undefined;
  if (userinfo != null && userinfo.length > 0) {
    const colon = userinfo.indexOf(":");
    if (colon >= 0) {
      username = decodeURIComponent(userinfo.slice(0, colon));
      password = decodeURIComponent(userinfo.slice(colon + 1));
      // empty password after colon is still "password auth"
      if (password === "") password = undefined;
    } else {
      username = decodeURIComponent(userinfo);
    }
  }

  // hostPart: host[:port][/path] or :port (host missing) or [ipv6]:port/path
  let host = "";
  let port: number | undefined;
  let remotePath: string | undefined;

  // path
  const slash = hostPart.indexOf("/");
  let hostPort = hostPart;
  if (slash >= 0) {
    hostPort = hostPart.slice(0, slash);
    const p = hostPart.slice(slash);
    remotePath = p || undefined;
  }

  // IPv6 [addr]:port
  const ipv6 = hostPort.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6) {
    host = ipv6[1]!;
    if (ipv6[2]) port = Number(ipv6[2]);
  } else if (hostPort.startsWith(":")) {
    // :2022 only (host empty) — still capture port
    const onlyPort = hostPort.match(/^:(\d+)$/);
    if (onlyPort) port = Number(onlyPort[1]);
  } else {
    // host or host:port
    const m = hostPort.match(/^([^:/]+|[^:]+(?=:\d+$))(?::(\d+))?$/);
    if (m) {
      host = stripBrackets(m[1]!);
      if (m[2]) port = Number(m[2]);
    } else {
      // fallback: split last colon as port if numeric
      const lastColon = hostPort.lastIndexOf(":");
      if (lastColon > 0) {
        const maybePort = hostPort.slice(lastColon + 1);
        if (/^\d+$/.test(maybePort)) {
          host = stripBrackets(hostPort.slice(0, lastColon));
          port = Number(maybePort);
        } else {
          host = stripBrackets(hostPort);
        }
      } else {
        host = stripBrackets(hostPort);
      }
    }
  }

  // If username looks like "name.hostfragment" and host empty — common paste glitch;
  // do not invent host. User must fill host.
  if (!host && !username && !port && !type) {
    // try URL API as last resort
    try {
      const withScheme = /^[a-z]+:\/\//i.test(input) ? input : `sftp://${input}`;
      const u = new URL(withScheme);
      const proto = u.protocol.replace(":", "").toLowerCase();
      type = proto.startsWith("sftp")
        ? "sftp"
        : proto.includes("ftp")
          ? "ftp"
          : "sftp";
      host = u.hostname || "";
      port = u.port ? Number(u.port) : undefined;
      username = u.username ? decodeURIComponent(u.username) : undefined;
      password = u.password ? decodeURIComponent(u.password) : undefined;
      remotePath = u.pathname && u.pathname !== "/" ? u.pathname : undefined;
      if (proto === "ftps") secure = "explicit";
    } catch {
      return null;
    }
  }

  if (!type && !host && !username) return null;

  // Defaults
  const resolvedType: "sftp" | "ftp" = type ?? "sftp";
  if (resolvedType === "sftp" && port == null) port = 22;
  if (resolvedType === "ftp" && port == null) port = 21;
  if (resolvedType === "ftp" && !secure) secure = "plain";

  const out: ParsedConnection = {
    type: resolvedType,
    authMethod: "password",
  };
  if (host) out.host = host;
  if (port != null && !Number.isNaN(port)) out.port = port;
  if (username) out.username = username;
  if (password) out.password = password;
  if (remotePath) {
    out.remotePath = remotePath.startsWith("/")
      ? remotePath
      : `/${remotePath}`;
  }
  if (secure) out.secure = secure;

  // Need at least something useful
  if (!out.host && !out.username && out.port == null) return null;
  return out;
}

/** Human summary for toast */
export function describeParsed(p: ParsedConnection): string {
  const bits: string[] = [];
  if (p.type) bits.push(p.type.toUpperCase());
  if (p.username) bits.push(`用户 ${p.username}`);
  if (p.host) bits.push(`主机 ${p.host}`);
  else bits.push("主机(未识别，请手填)");
  if (p.port) bits.push(`端口 ${p.port}`);
  if (p.password) bits.push("已填密码");
  if (p.remotePath) bits.push(`路径 ${p.remotePath}`);
  return bits.join(" · ");
}

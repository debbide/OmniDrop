import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TargetType,
  type FtpConfig,
  type SftpConfig,
  type WebdavConfig,
} from "@omnidrop/shared";
import type {
  DownloadParams,
  RemoteEntry,
  RemoteFsAdapter,
  RemoteFsOptions,
  UploadParams,
  UploadResult,
} from "./types.js";
import { joinRemotePath, normalizeRemotePath } from "./jail.js";
import { classifyRemoteError } from "./errors.js";

type RcloneBackend =
  | { kind: "sftp"; config: SftpConfig; secret: Record<string, unknown> }
  | { kind: "ftp"; config: FtpConfig; secret: Record<string, unknown> }
  | { kind: "webdav"; config: WebdavConfig; secret: Record<string, unknown> };

const DEFAULT_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 45_000;

export function createRcloneRemoteFs(
  backend: RcloneBackend,
  opts: RemoteFsOptions = {},
): RemoteFsAdapter {
  const bin = opts.rclonePath ?? process.env.RCLONE_PATH ?? "rclone";
  const listLimit = opts.listLimit ?? 2000;

  return {
    async testConnection() {
      const confDir = await writeConf(backend, bin);
      try {
        // Probe configured jail root rather than remote root when possible
        const probe =
          backend.kind === "webdav"
            ? toRemoteSpec(normalizeRemotePath(backend.config.remotePath || "/"))
            : toRemoteSpec(normalizeRemotePath(backend.config.remotePath || "/"));
        await run(
          bin,
          ["lsd", probe, "--config", confPath(confDir), "--max-depth", "1"],
          undefined,
          undefined,
          LIST_TIMEOUT_MS,
        );
        return { ok: true, message: `${backend.kind.toUpperCase()} reachable` };
      } catch (err) {
        return { ok: false, message: classifyRemoteError(err).message };
      } finally {
        await cleanup(confDir);
      }
    },

    async list(dirPath: string) {
      const confDir = await writeConf(backend, bin);
      try {
        const remote = toRemoteSpec(dirPath);
        let out: string;
        try {
          out = await runCapture(
            bin,
            [
              "lsjson",
              remote,
              "--config",
              confPath(confDir),
              "--max-depth",
              "1",
              "--no-mimetype",
            ],
            LIST_TIMEOUT_MS,
          );
        } catch (firstErr) {
          // Fallback: some SFTP chroots reject absolute remote:/x — try home-relative
          const n = normalizeRemotePath(dirPath);
          if (n !== "/" && n.startsWith("/")) {
            const rel = `remote:${n.replace(/^\//, "")}`;
            try {
              out = await runCapture(
                bin,
                [
                  "lsjson",
                  rel,
                  "--config",
                  confPath(confDir),
                  "--max-depth",
                  "1",
                  "--no-mimetype",
                ],
                LIST_TIMEOUT_MS,
              );
            } catch {
              throw firstErr;
            }
          } else {
            throw firstErr;
          }
        }
        const parsed = JSON.parse(out || "[]") as Array<{
          Path?: string;
          Name?: string;
          Size?: number;
          ModTime?: string;
          IsDir?: boolean;
        }>;
        const base = normalizeRemotePath(dirPath);
        const entries: RemoteEntry[] = [];
        for (const item of parsed.slice(0, listLimit)) {
          const name = item.Name || item.Path?.split("/").pop() || "";
          if (!name || name === "." || name === "..") continue;
          const full =
            base === "/"
              ? `/${name}`
              : `${base.replace(/\/+$/, "")}/${name}`;
          entries.push({
            name,
            path: full,
            type: item.IsDir ? "dir" : "file",
            size: item.IsDir ? null : (item.Size ?? null),
            modifiedAt: item.ModTime ? Date.parse(item.ModTime) || null : null,
          });
        }
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return entries;
      } catch (err) {
        throw classifyRemoteError(err);
      } finally {
        await cleanup(confDir);
      }
    },

    async mkdir(dirPath: string) {
      const confDir = await writeConf(backend, bin);
      try {
        await run(bin, [
          "mkdir",
          toRemoteSpec(dirPath),
          "--config",
          confPath(confDir),
        ]);
      } catch (err) {
        throw classifyRemoteError(err);
      } finally {
        await cleanup(confDir);
      }
    },

    async rename(fromPath: string, toPath: string) {
      const confDir = await writeConf(backend, bin);
      try {
        await run(bin, [
          "moveto",
          toRemoteSpec(fromPath),
          toRemoteSpec(toPath),
          "--config",
          confPath(confDir),
        ]);
      } catch (err) {
        throw classifyRemoteError(err);
      } finally {
        await cleanup(confDir);
      }
    },

    async delete(paths: string[], delOpts?: { recursive?: boolean }) {
      const confDir = await writeConf(backend, bin);
      try {
        for (const p of paths) {
          const spec = toRemoteSpec(p);
          // Try file delete first, then directory
          try {
            await run(bin, [
              "deletefile",
              spec,
              "--config",
              confPath(confDir),
            ]);
          } catch (fileErr) {
            try {
              if (delOpts?.recursive === false) {
                await run(bin, ["rmdir", spec, "--config", confPath(confDir)]);
              } else {
                await run(bin, ["purge", spec, "--config", confPath(confDir)]);
              }
            } catch {
              throw classifyRemoteError(fileErr);
            }
          }
        }
      } finally {
        await cleanup(confDir);
      }
    },

    async upload(params: UploadParams): Promise<UploadResult> {
      const confDir = await writeConf(backend, bin);
      const remoteDir = normalizeRemotePath(params.remoteDir);
      const finalPath = joinRemotePath(remoteDir, params.fileName);
      try {
        // ensure parent directory exists
        try {
          await run(bin, [
            "mkdir",
            toRemoteSpec(remoteDir),
            "--config",
            confPath(confDir),
          ]);
        } catch {
          /* may already exist */
        }
        const args = [
          "copyto",
          params.localPath,
          toRemoteSpec(finalPath),
          "--config",
          confPath(confDir),
          // Full-line stats (NOT --stats-one-line): one-line mode uses \r which
          // pipes often buffer until exit, so the UI jumps 0% → 100%.
          "--stats",
          "1s",
          "--progress",
          "--stats-log-level",
          "NOTICE",
          // Use server/upload time as remote mtime (publish), not local build time.
          "--no-update-modtime",
          // Network flake recovery (whole-file retry with local complete source)
          "--retries",
          "5",
          "--retries-sleep",
          "5s",
          "--low-level-retries",
          "10",
        ];
        // Only skip when caller explicitly disables overwrite
        if (params.overwrite === false) args.push("--ignore-existing");
        await run(
          bin,
          args,
          params.signal,
          (line) => {
            const p = parseRcloneTransferLine(line);
            if (p && params.onProgress) void params.onProgress(p);
          },
          0, // 0 = no wall-clock timeout for large uploads (cancel via signal)
        );
        return { remoteFinalPath: finalPath };
      } catch (err) {
        throw classifyRemoteError(err);
      } finally {
        await cleanup(confDir);
      }
    },

    async download(params: DownloadParams) {
      const confDir = await writeConf(backend, bin);
      try {
        await fs.mkdir(path.dirname(params.localPath), { recursive: true });
        await run(
          bin,
          [
            "copyto",
            toRemoteSpec(params.remotePath),
            params.localPath,
            "--config",
            confPath(confDir),
            // Same as upload: avoid --stats-one-line so pipe flushes each second
            "--stats",
            "1s",
            "--progress",
            "--stats-log-level",
            "NOTICE",
            "--retries",
            "3",
          ],
          params.signal,
          (line) => {
            const p = parseRcloneTransferLine(line);
            if (p && params.onProgress) void params.onProgress(p);
          },
        );
      } catch (err) {
        throw classifyRemoteError(err);
      } finally {
        await cleanup(confDir);
      }
    },
  };
}

export function createRcloneFromTarget(
  type: string,
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
  opts?: RemoteFsOptions,
): RemoteFsAdapter {
  switch (type) {
    case TargetType.SFTP:
      return createRcloneRemoteFs(
        { kind: "sftp", config: config as SftpConfig, secret },
        opts,
      );
    case TargetType.FTP:
      return createRcloneRemoteFs(
        { kind: "ftp", config: config as FtpConfig, secret },
        opts,
      );
    case TargetType.WEBDAV:
      return createRcloneRemoteFs(
        { kind: "webdav", config: config as WebdavConfig, secret },
        opts,
      );
    default:
      throw new Error(`Unsupported rclone type: ${type}`);
  }
}

function confPath(dir: string) {
  return path.join(dir, "rclone.conf");
}

/**
 * rclone SFTP/FTP path rules:
 * - remote:foo     → relative to login home
 * - remote:/foo    → absolute from server root
 * We always store unix paths with leading / in DB/UI, so keep the slash
 * for absolute paths. Only bare "remote:" for jail root "/".
 */
function toRemoteSpec(remotePath: string): string {
  const n = normalizeRemotePath(remotePath);
  if (n === "/") return "remote:";
  // Keep leading slash → absolute on server (critical for SFTP)
  return `remote:${n}`;
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function obscure(bin: string, plain: string): Promise<string> {
  try {
    const out = await runCapture(bin, ["obscure", plain], 15_000);
    return out.trim().split(/\r?\n/).filter(Boolean).pop() || plain;
  } catch {
    return plain;
  }
}

async function writeConf(backend: RcloneBackend, bin: string): Promise<string> {
  const confDir = await fs.mkdtemp(path.join(os.tmpdir(), "omnidrop-rclone-"));
  const lines = ["[remote]"];

  if (backend.kind === "sftp") {
    const c = backend.config;
    lines.push(
      "type = sftp",
      `host = ${c.host}`,
      `port = ${c.port ?? 22}`,
      `user = ${c.username}`,
    );
    if (c.authMethod === "privateKey" && backend.secret.privateKey) {
      const keyPath = path.join(confDir, "id_key");
      await fs.writeFile(keyPath, String(backend.secret.privateKey), {
        mode: 0o600,
      });
      lines.push(`key_file = ${keyPath.replace(/\\/g, "/")}`);
      if (backend.secret.passphrase) {
        lines.push(
          `key_file_pass = ${await obscure(bin, String(backend.secret.passphrase))}`,
        );
      }
    } else if (backend.secret.password) {
      lines.push(
        `pass = ${await obscure(bin, String(backend.secret.password))}`,
      );
    }
// Host key: only set known_hosts when strict; otherwise rclone skips verify
    if (c.hostKeyPolicy === "strict" && c.knownHosts) {
      const kh = path.join(confDir, "known_hosts");
      await fs.writeFile(kh, String(c.knownHosts).trim() + "\n", {
        mode: 0o600,
      });
      lines.push(`known_hosts_file = ${kh.replace(/\\/g, "/")}`);
    }
    // Avoid interactive prompts / slow hash probes on many hosts
    lines.push("shell_type = unix");
    if (c.disableHashCheck !== false) {
      lines.push("md5sum_command = none", "sha1sum_command = none");
    }
    // Faster connects; disable shell if server is limited (Pterodactyl SFTP often is)
    lines.push("disable_concurrent_reads = true");
    lines.push("disable_concurrent_writes = true");
  } else if (backend.kind === "ftp") {
    const c = backend.config;
    lines.push(
      "type = ftp",
      `host = ${c.host}`,
      `port = ${c.port ?? 21}`,
      `user = ${c.username}`,
    );
    if (backend.secret.password) {
      lines.push(
        `pass = ${await obscure(bin, String(backend.secret.password))}`,
      );
    }
    // TLS modes
    if (c.secure === "explicit") {
      lines.push("explicit_tls = true");
    } else if (c.secure === "implicit") {
      lines.push("tls = true");
    }
    if (c.insecureTls) {
      lines.push("no_check_certificate = true");
    }
    if (c.passive === false) {
      // rclone uses passive by default; active is rare
      lines.push("# active mode not fully portable");
    }
    if (c.concurrency != null && c.concurrency > 0) {
      lines.push(`concurrency = ${c.concurrency}`);
    }
  } else {
    const c = backend.config;
    lines.push("type = webdav", `url = ${c.url}`);
    lines.push(`vendor = ${c.vendor ?? "other"}`);
    if (c.authType === "bearer" && backend.secret.bearerToken) {
      // rclone bearer via headers
      lines.push("bearer_token = " + String(backend.secret.bearerToken));
    } else {
      lines.push(`user = ${c.username ?? ""}`);
      if (backend.secret.password) {
        lines.push(
          `pass = ${await obscure(bin, String(backend.secret.password))}`,
        );
      }
    }
    if (c.insecureTls) {
      lines.push("no_check_certificate = true");
    }
  }

  await fs.writeFile(confPath(confDir), lines.join("\n") + "\n", {
    mode: 0o600,
  });
  return confDir;
}

function parseSize(n: number, unit: string): number {
  const u = unit.toUpperCase().replace(/\s+/g, "");
  // Support both binary (KiB/MiB) and decimal (KB/MB) suffixes from rclone
  if (u === "B" || u === "") return Math.round(n);
  if (u.startsWith("KI") || u === "K" || u === "KB") return Math.round(n * 1024);
  if (u.startsWith("MI") || u === "M" || u === "MB")
    return Math.round(n * 1024 ** 2);
  if (u.startsWith("GI") || u === "G" || u === "GB")
    return Math.round(n * 1024 ** 3);
  if (u.startsWith("TI") || u === "T" || u === "TB")
    return Math.round(n * 1024 ** 4);
  return Math.round(n);
}

/** Parse rclone --stats / --progress transfer lines (one-line or multi-line). */
export function parseRcloneTransferLine(
  line: string,
): { bytesDone: number; bytesTotal: number } | null {
  // Examples:
  //   Transferred:   	  1.234 MiB / 10.000 MiB, 12%, 500 KiB/s, ETA 20s
  //   Transferred: 1.234MiB / 10MiB, 12%, ...
  //   * file.jar: 50% /10MiB, 1MiB/s, ...
  //   Transferred:            0 B / 0 B, -, 0 B/s, ETA -
  const cleaned = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
  let m = cleaned.match(
    /Transferred:\s*([\d.]+)\s*([KMGTP]?i?B)\s*\/\s*([\d.]+)\s*([KMGTP]?i?B)(?:,\s*(\d+)%)?/i,
  );
  if (m) {
    const done = parseSize(Number(m[1]), m[2]!);
    let total = parseSize(Number(m[3]), m[4]!);
    if ((!total || total < done) && m[5]) {
      const pct = Number(m[5]);
      if (pct > 0) total = Math.round((done * 100) / pct);
    }
    // Ignore empty "0 B / 0 B" probes before the real transfer starts
    if (done <= 0 && total <= 0) return null;
    return { bytesDone: done, bytesTotal: total || done };
  }
  // Percent-first form: "file:  45% /12.3MiB" or " * paper.jar: 45%"
  m = cleaned.match(
    /:\s*(\d+)%\s*(?:\/\s*([\d.]+)\s*([KMGTP]?i?B))?/i,
  );
  if (m) {
    const pct = Number(m[1]);
    if (m[2] && m[3]) {
      const total = parseSize(Number(m[2]), m[3]);
      if (total > 0 && pct >= 0) {
        return {
          bytesDone: Math.round((total * pct) / 100),
          bytesTotal: total,
        };
      }
    }
  }
  // Bare "Transferred: 123456 / 789012 Bytes"
  m = cleaned.match(
    /Transferred:\s*([\d.]+)\s*\/\s*([\d.]+)\s*Bytes/i,
  );
  if (m) {
    return {
      bytesDone: Math.round(Number(m[1])),
      bytesTotal: Math.round(Number(m[2])),
    };
  }
  // "12.345 MiB / 50.000 MiB" without the Transferred prefix (progress panel)
  m = cleaned.match(
    /^([\d.]+)\s*([KMGTP]?i?B)\s*\/\s*([\d.]+)\s*([KMGTP]?i?B)(?:,\s*(\d+)%)?/i,
  );
  if (m) {
    const done = parseSize(Number(m[1]), m[2]!);
    let total = parseSize(Number(m[3]), m[4]!);
    if ((!total || total < done) && m[5]) {
      const pct = Number(m[5]);
      if (pct > 0) total = Math.round((done * 100) / pct);
    }
    if (done > 0 || total > 0) {
      return { bytesDone: done, bytesTotal: total || done };
    }
  }
  return null;
}

function run(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  onLine?: (line: string) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Avoid one-line CR progress when stderr is a pipe (buffers until exit)
        RCLONE_STATS_ONE_LINE: "false",
      },
    });
    let stderr = "";
    let settled = false;
    // timeoutMs <= 0 means no wall-clock timeout (for large transfers)
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill("SIGTERM");
            } catch {
              /* */
            }
            if (!settled) {
              settled = true;
              reject(new Error(`rclone timed out after ${timeoutMs}ms`));
            }
          }, timeoutMs)
        : null;

    // rclone often uses \r for progress refresh — split on both \r and \n
    let stdoutCarry = "";
    let stderrCarry = "";
    const feed = (which: "out" | "err", buf: Buffer) => {
      const text = buf.toString("utf8");
      if (which === "err") stderr += text;
      const carry = which === "out" ? stdoutCarry : stderrCarry;
      const combined = carry + text;
      const parts = combined.split(/\r\n|\n|\r/);
      const nextCarry = parts.pop() ?? "";
      if (which === "out") stdoutCarry = nextCarry;
      else stderrCarry = nextCarry;
      for (const line of parts) {
        const t = line.trim();
        if (t) onLine?.(t);
      }
    };
    child.stdout?.on("data", (b: Buffer) => feed("out", b));
    child.stderr?.on("data", (b: Buffer) => feed("err", b));
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* */
      }
    };
    signal?.addEventListener("abort", onAbort);
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Failed to start rclone (${bin}): ${err.message}. Is rclone installed?`,
        ),
      );
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      // Flush trailing progress fragment without final newline
      for (const carry of [stdoutCarry, stderrCarry]) {
        const t = carry.trim();
        if (t) onLine?.(t);
      }
      if (signal?.aborted) return reject(new Error("Operation canceled"));
      if (code === 0) resolve();
      else {
        const tail = stderr.trim().split(/\r?\n/).slice(-12).join("\n");
        reject(new Error(`rclone exited ${code}: ${tail || "unknown error"}`));
      }
    });
  });
}

function runCapture(
  bin: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* */
      }
      if (!settled) {
        settled = true;
        reject(new Error(`rclone timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      err += b.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Failed to start rclone (${bin}): ${e.message}. Is rclone installed?`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `rclone exit ${code}`));
    });
  });
}

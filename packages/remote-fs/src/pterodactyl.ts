import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import axios, { type AxiosInstance } from "axios";
import FormData from "form-data";
import type { PteroConfig } from "@omnidrop/shared";
import type {
  DownloadParams,
  RemoteEntry,
  RemoteFsAdapter,
  UploadParams,
} from "./types.js";
import {
  joinRemotePath,
  normalizeRemotePath,
  remoteBasename,
  remoteDirname,
} from "./jail.js";
import { classifyRemoteError } from "./errors.js";

function pteroErr(err: unknown): Error {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data as
      | { errors?: Array<{ detail?: string; code?: string }> }
      | undefined;
    const detail =
      body?.errors?.[0]?.detail ||
      body?.errors?.[0]?.code ||
      err.message;
    return classifyRemoteError(
      new Error(`Pterodactyl ${status ?? ""}: ${detail}`),
    );
  }
  return classifyRemoteError(err);
}

export function createPterodactylRemoteFs(opts: {
  config: PteroConfig;
  secret: { apiKey: string };
}): RemoteFsAdapter {
  const baseURL = opts.config.panelUrl.replace(/\/+$/, "");
  const serverId = opts.config.serverId;
  const client: AxiosInstance = axios.create({
    baseURL,
    timeout: 120_000,
    headers: {
      Authorization: `Bearer ${opts.secret.apiKey}`,
      Accept: "application/json",
      "User-Agent": "OmniDrop",
    },
  });

  async function ensureDirChain(remotePath: string) {
    if (opts.config.createDirs === false) return;
    const normalized = normalizeRemotePath(remotePath);
    if (normalized === "/") return;
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      const parent = current || "/";
      current = `${current}/${part}`;
      try {
        await client.post(
          `/api/client/servers/${serverId}/files/create-folder`,
          { root: parent, name: part },
        );
      } catch {
        /* exists */
      }
    }
  }

  return {
    async testConnection() {
      try {
        await client.get(`/api/client/servers/${serverId}`);
        // also probe jail path
        const dir = normalizeRemotePath(opts.config.remotePath || "/");
        await client.get(`/api/client/servers/${serverId}/files/list`, {
          params: { directory: dir },
        });
        return { ok: true, message: "Pterodactyl server + path reachable" };
      } catch (err: unknown) {
        return { ok: false, message: pteroErr(err).message };
      }
    },

    async list(dirPath: string) {
      try {
        const directory = normalizeRemotePath(dirPath);
        const { data } = await client.get(
          `/api/client/servers/${serverId}/files/list`,
          { params: { directory } },
        );
        const items = (data?.data ?? []) as Array<{
          attributes?: {
            name?: string;
            size?: number;
            is_file?: boolean;
            mimetype?: string;
            modified_at?: string;
          };
        }>;
        const entries: RemoteEntry[] = [];
        for (const item of items) {
          const a = item.attributes ?? {};
          const name = a.name ?? "";
          if (!name || name === "." || name === "..") continue;
          const full = joinRemotePath(directory, name);
          entries.push({
            name,
            path: full,
            type: a.is_file === false ? "dir" : "file",
            size: a.is_file === false ? null : (a.size ?? null),
            modifiedAt: a.modified_at
              ? Date.parse(a.modified_at) || null
              : null,
          });
        }
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return entries;
      } catch (err) {
        throw pteroErr(err);
      }
    },

    async mkdir(dirPath: string) {
      try {
        const full = normalizeRemotePath(dirPath);
        const name = remoteBasename(full);
        const root = remoteDirname(full);
        if (opts.config.createDirs !== false) {
          await ensureDirChain(root);
        }
        await client.post(
          `/api/client/servers/${serverId}/files/create-folder`,
          { root: root || "/", name },
        );
      } catch (err) {
        throw pteroErr(err);
      }
    },

    async rename(fromPath: string, toPath: string) {
      try {
        const from = normalizeRemotePath(fromPath);
        const to = normalizeRemotePath(toPath);
        const fromRoot = remoteDirname(from);
        const toRoot = remoteDirname(to);
        const fromName = remoteBasename(from);
        const toName = remoteBasename(to);

        if (fromRoot === toRoot) {
          await client.put(
            `/api/client/servers/${serverId}/files/rename`,
            {
              root: fromRoot || "/",
              files: [{ from: fromName, to: toName }],
            },
          );
          return;
        }

        // Cross-directory: Ptero rename is same-root; use copy+delete fallback via download not available.
        // API supports rename only within root — use "from" as relative path with subdirs when same root prefix.
        // If roots differ, attempt rename with full relative from jail if shared ancestor.
        const shared =
          fromRoot.startsWith(toRoot) || toRoot.startsWith(fromRoot)
            ? fromRoot.length <= toRoot.length
              ? fromRoot
              : toRoot
            : null;
        if (shared != null) {
          const relFrom = from
            .slice(shared === "/" ? 0 : shared.length)
            .replace(/^\//, "");
          const relTo = to
            .slice(shared === "/" ? 0 : shared.length)
            .replace(/^\//, "");
          await client.put(
            `/api/client/servers/${serverId}/files/rename`,
            {
              root: shared || "/",
              files: [{ from: relFrom || fromName, to: relTo || toName }],
            },
          );
          return;
        }
        throw new Error(
          "Pterodactyl 跨目录移动受限：请在同一父目录下重命名，或先下载再上传",
        );
      } catch (err) {
        throw pteroErr(err);
      }
    },

    async delete(paths: string[]) {
      try {
        const byRoot = new Map<string, string[]>();
        for (const p of paths) {
          const full = normalizeRemotePath(p);
          const root = remoteDirname(full) || "/";
          const name = remoteBasename(full);
          const list = byRoot.get(root) ?? [];
          list.push(name);
          byRoot.set(root, list);
        }
        for (const [root, files] of byRoot) {
          await client.post(
            `/api/client/servers/${serverId}/files/delete`,
            { root, files },
          );
        }
      } catch (err) {
        throw pteroErr(err);
      }
    },

    async upload(params: UploadParams) {
      try {
        const remoteDir = normalizeRemotePath(params.remoteDir);
        const remoteFile = joinRemotePath(remoteDir, params.fileName);
        await ensureDirChain(remoteDir);
        const stat = await fsp.stat(params.localPath);

        // Always re-upload when requested; delete first so panel shows new mtime
        if (params.overwrite !== false) {
          try {
            await client.post(
              `/api/client/servers/${serverId}/files/delete`,
              {
                root: remoteDir || "/",
                files: [params.fileName],
              },
            );
          } catch {
            /* not exists */
          }
        }

        try {
          const { data } = await client.get(
            `/api/client/servers/${serverId}/files/upload`,
          );
          const uploadUrl = data?.attributes?.url as string | undefined;
          if (uploadUrl) {
            const form = new FormData();
            form.append("files", fs.createReadStream(params.localPath), {
              filename: params.fileName,
              knownLength: stat.size,
            });
            const url = new URL(uploadUrl);
            if (!url.searchParams.has("directory")) {
              url.searchParams.set("directory", remoteDir);
            }
            await axios.post(url.toString(), form, {
              headers: form.getHeaders(),
              maxBodyLength: Infinity,
              maxContentLength: Infinity,
              timeout: 0,
              signal: params.signal as never,
              onUploadProgress: (ev) => {
                if (params.onProgress && ev.total) {
                  void params.onProgress({
                    bytesDone: ev.loaded,
                    bytesTotal: ev.total,
                  });
                }
              },
            });
            return { remoteFinalPath: remoteFile };
          }
        } catch {
          /* fallback write */
        }

        const stream = fs.createReadStream(params.localPath);
        let bytesDone = 0;
        stream.on("data", (chunk: Buffer | string) => {
          bytesDone +=
            typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
          if (params.onProgress) {
            void params.onProgress({ bytesDone, bytesTotal: stat.size });
          }
        });
        await client.post(
          `/api/client/servers/${serverId}/files/write`,
          stream,
          {
            params: { file: remoteFile },
            headers: { "Content-Type": "application/octet-stream" },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 0,
            signal: params.signal as never,
          },
        );
        return { remoteFinalPath: remoteFile };
      } catch (err) {
        throw pteroErr(err);
      }
    },

    async download(params: DownloadParams) {
      try {
        const file = normalizeRemotePath(params.remotePath);
        const { data } = await client.get(
          `/api/client/servers/${serverId}/files/download`,
          { params: { file } },
        );
        const url = data?.attributes?.url as string | undefined;
        if (!url) throw new Error("Pterodactyl did not return download URL");
        await fsp.mkdir(path.dirname(params.localPath), { recursive: true });
        const res = await axios.get(url, {
          responseType: "stream",
          timeout: 0,
          signal: params.signal as never,
        });
        const total = Number(res.headers["content-length"] ?? 0) || 0;
        let done = 0;
        await new Promise<void>((resolve, reject) => {
          const ws = fs.createWriteStream(params.localPath);
          res.data.on("data", (chunk: Buffer) => {
            done += chunk.length;
            if (params.onProgress) {
              void params.onProgress({
                bytesDone: done,
                bytesTotal: total || done,
              });
            }
          });
          res.data.on("error", reject);
          ws.on("error", reject);
          ws.on("finish", () => resolve());
          res.data.pipe(ws);
        });
      } catch (err) {
        throw pteroErr(err);
      }
    },
  };
}

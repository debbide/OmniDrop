import path from "node:path";
import { URL } from "node:url";

/** Reject path traversal and empty segments. */
export function assertSafeRemotePath(remotePath: string): string {
  const normalized = remotePath.replace(/\\/g, "/").trim();
  if (!normalized) {
    throw new Error("Remote path is empty");
  }
  if (normalized.includes("\0")) {
    throw new Error("Remote path contains null byte");
  }
  const parts = normalized.split("/").filter((p) => p.length > 0);
  for (const part of parts) {
    if (part === ".." || part === ".") {
      throw new Error("Remote path must not contain '.' or '..'");
    }
  }
  return normalized.startsWith("/") ? `/${parts.join("/")}` : parts.join("/");
}

/** Sanitize a filename from URL or asset name. */
export function sanitizeFileName(name: string): string {
  const withoutQuery = name.split("?")[0] ?? name;
  const segments = withoutQuery.replace(/\\/g, "/").split("/");
  const base = (segments[segments.length - 1] ?? "download.bin").trim();
  const cleaned = base.replace(/[^\w.\-()+\[\] ]+/g, "_").replace(/\s+/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return `file_${Date.now()}`;
  }
  return cleaned.slice(0, 200);
}

export function fileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "download.bin";
    return sanitizeFileName(decodeURIComponent(last));
  } catch {
    return sanitizeFileName(url);
  }
}

/** Ensure resolved path stays inside baseDir (no escape). */
export function assertInsideDir(baseDir: string, candidate: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(baseDir, candidate);
  const rel = path.relative(base, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path escapes base directory");
  }
  return resolved;
}

export function contentDispositionAttachment(fileName: string): string {
  const safe = sanitizeFileName(fileName).replace(/"/g, "");
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

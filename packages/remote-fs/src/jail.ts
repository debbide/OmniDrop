import { assertSafeRemotePath } from "@omnidrop/shared";

/** Normalize to unix-style path with leading slash for absolute remotes. */
export function normalizeRemotePath(p: string): string {
  const n = assertSafeRemotePath(p.replace(/\\/g, "/").trim() || "/");
  if (n === "" || n === ".") return "/";
  return n.startsWith("/") ? n : `/${n}`;
}

/**
 * Resolve user path under jail root. Prevents escaping remotePath root.
 * root and userPath are remote (unix) paths, not local OS paths.
 */
export function resolveJailedRemotePath(root: string, userPath?: string | null): string {
  const jail = normalizeRemotePath(root || "/");
  const raw = (userPath ?? jail).trim() || jail;
  let candidate: string;
  if (raw.startsWith("/")) {
    candidate = normalizeRemotePath(raw);
  } else {
    const base = jail.endsWith("/") ? jail.slice(0, -1) : jail;
    candidate = normalizeRemotePath(`${base}/${raw}`);
  }

  if (jail === "/") {
    return candidate;
  }

  const jailPrefix = jail.endsWith("/") ? jail.slice(0, -1) : jail;
  if (candidate !== jailPrefix && !candidate.startsWith(`${jailPrefix}/`)) {
    throw new Error("Path escapes target remote root");
  }
  return candidate;
}

export function parentRemotePath(p: string): string {
  const n = normalizeRemotePath(p);
  if (n === "/") return "/";
  const parts = n.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

export function joinRemotePath(dir: string, name: string): string {
  const safeName = name.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  if (!safeName || safeName === "." || safeName === "..") {
    throw new Error("Invalid name");
  }
  // reject path separators already handled; also reject absolute-looking names
  if (safeName.includes("\0")) throw new Error("Invalid name");
  const d = normalizeRemotePath(dir);
  if (d === "/") return `/${safeName}`;
  return `${d.replace(/\/+$/, "")}/${safeName}`;
}

export function remoteBasename(p: string): string {
  const n = normalizeRemotePath(p);
  if (n === "/") return "";
  return n.split("/").filter(Boolean).pop() ?? "";
}

export function remoteDirname(p: string): string {
  return parentRemotePath(p);
}

/** True if path is exactly the jail root (should not be deleted). */
export function isJailRoot(jailRoot: string, path: string): boolean {
  const j = normalizeRemotePath(jailRoot);
  const p = normalizeRemotePath(path);
  return j === p;
}

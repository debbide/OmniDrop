import { eq } from "drizzle-orm";
import {
  classifyRemoteError,
  createRemoteFs,
  getTargetJailRoot,
  isJailRoot,
  joinRemotePath,
  resolveJailedRemotePath,
  type RemoteFsAdapter,
} from "@omnidrop/remote-fs";
import { decryptJson } from "@omnidrop/crypto";
import { getDb, credentials, targets } from "@omnidrop/db";
import { appConfig } from "../config.js";
import { AppError } from "../lib/errors.js";
import { audit } from "./audit-service.js";

export async function loadTargetAdapter(targetId: string): Promise<{
  adapter: RemoteFsAdapter;
  jailRoot: string;
  target: typeof targets.$inferSelect;
  config: Record<string, unknown>;
}> {
  const db = getDb();
  const row = await db.select().from(targets).where(eq(targets.id, targetId)).get();
  if (!row) throw new AppError(404, "NOT_FOUND", "Target not found");
  if (!row.enabled) throw new AppError(400, "VALIDATION_ERROR", "Target is disabled");

  const cred = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, row.credentialId))
    .get();
  if (!cred) throw new AppError(500, "INTERNAL_ERROR", "Credential missing");

  const secret = decryptJson<Record<string, unknown>>(
    appConfig.OMNIDROP_DATA_KEY,
    cred,
  );
  const config = JSON.parse(row.configJson) as Record<string, unknown>;
  const jailRoot = getTargetJailRoot(config);

  try {
    const adapter = createRemoteFs(row.type, config, secret, {
      rclonePath: process.env.RCLONE_PATH ?? "rclone",
    });
    return { adapter, jailRoot, target: row, config };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(503, "ADAPTER_ERROR", msg);
  }
}

function mapFsError(err: unknown): never {
  const classified = classifyRemoteError(err);
  const status =
    classified.code === "VALIDATION"
      ? 400
      : classified.code === "RCLONE_MISSING"
        ? 503
        : classified.code === "AUTH"
          ? 401
          : classified.code === "NOT_FOUND"
            ? 404
            : classified.code === "TIMEOUT" || classified.code === "NETWORK"
              ? 504
              : 502;
  throw new AppError(status, classified.code, classified.message);
}

export async function listRemoteFiles(targetId: string, userPath?: string) {
  try {
    const { adapter, jailRoot } = await loadTargetAdapter(targetId);
    const path = resolveJailedRemotePath(jailRoot, userPath ?? jailRoot);
    const entries = await adapter.list(path);
    // filter entries to jail (defense in depth)
    const safe = entries.filter((e) => {
      try {
        resolveJailedRemotePath(jailRoot, e.path);
        return true;
      } catch {
        return false;
      }
    });
    return { root: jailRoot, path, entries: safe, truncated: entries.length >= 2000 };
  } catch (err) {
    if (err instanceof AppError) throw err;
    mapFsError(err);
  }
}

export async function remoteMkdir(
  targetId: string,
  pathOrParent: string,
  name: string | undefined,
  actor: { userId: string; ip?: string; userAgent?: string },
) {
  try {
    const { adapter, jailRoot } = await loadTargetAdapter(targetId);
    const full = name
      ? resolveJailedRemotePath(
          jailRoot,
          joinRemotePath(resolveJailedRemotePath(jailRoot, pathOrParent), name),
        )
      : resolveJailedRemotePath(jailRoot, pathOrParent);
    await adapter.mkdir(full);
    await audit({
      actorUserId: actor.userId,
      actorType: "session",
      action: "remote.mkdir",
      resourceType: "target",
      resourceId: targetId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      meta: { path: full },
    });
    return { path: full };
  } catch (err) {
    if (err instanceof AppError) throw err;
    mapFsError(err);
  }
}

export async function remoteRename(
  targetId: string,
  fromUser: string,
  newName: string,
  actor: { userId: string; ip?: string; userAgent?: string },
) {
  try {
    const { adapter, jailRoot } = await loadTargetAdapter(targetId);
    const from = resolveJailedRemotePath(jailRoot, fromUser);
    const parent = from.split("/").slice(0, -1).join("/") || "/";
    const to = resolveJailedRemotePath(
      jailRoot,
      joinRemotePath(parent === "" ? "/" : parent, newName),
    );
    await adapter.rename(from, to);
    await audit({
      actorUserId: actor.userId,
      actorType: "session",
      action: "remote.rename",
      resourceType: "target",
      resourceId: targetId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      meta: { from, to },
    });
    return { from, to };
  } catch (err) {
    if (err instanceof AppError) throw err;
    mapFsError(err);
  }
}

export async function remoteDelete(
  targetId: string,
  paths: string[],
  recursive: boolean,
  actor: { userId: string; ip?: string; userAgent?: string },
) {
  try {
    const { adapter, jailRoot } = await loadTargetAdapter(targetId);
    const jailed = paths.map((p) => resolveJailedRemotePath(jailRoot, p));
    for (const p of jailed) {
      if (isJailRoot(jailRoot, p) || p === "/") {
        throw new AppError(400, "VALIDATION_ERROR", "Cannot delete remote root");
      }
    }
    await adapter.delete(jailed, { recursive });
    await audit({
      actorUserId: actor.userId,
      actorType: "session",
      action: "remote.delete",
      resourceType: "target",
      resourceId: targetId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      meta: { paths: jailed },
    });
    return { deleted: jailed };
  } catch (err) {
    if (err instanceof AppError) throw err;
    mapFsError(err);
  }
}

export async function remoteUploadLocal(
  targetId: string,
  localPath: string,
  destDirUser: string | undefined,
  fileName: string,
  overwrite: boolean,
  actor: { userId: string; ip?: string; userAgent?: string },
) {
  try {
    const { adapter, jailRoot } = await loadTargetAdapter(targetId);
    const remoteDir = resolveJailedRemotePath(jailRoot, destDirUser ?? jailRoot);
    const result = await adapter.upload({
      localPath,
      remoteDir,
      fileName,
      overwrite,
    });
    await audit({
      actorUserId: actor.userId,
      actorType: "session",
      action: "remote.upload",
      resourceType: "target",
      resourceId: targetId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      meta: { remoteFinalPath: result.remoteFinalPath },
    });
    return result;
  } catch (err) {
    if (err instanceof AppError) throw err;
    mapFsError(err);
  }
}

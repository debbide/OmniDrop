import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  contentDispositionAttachment,
  resolveShareTtlSeconds,
  type CreateShareBody,
} from "@omnidrop/shared";
import { getDb, shareLinks, artifacts } from "@omnidrop/db";
import { appConfig } from "../config.js";
import { AppError } from "../lib/errors.js";
import { hashToken, newId, newSessionToken } from "../lib/id.js";
import { audit } from "./audit-service.js";
import { artifactDiskPath, getArtifact } from "./artifact-service.js";
import type { Response } from "express";

export async function createShare(
  artifactId: string,
  body: CreateShareBody,
  userId: string,
  meta?: { ip?: string; userAgent?: string },
) {
  await getArtifact(artifactId);
  const ttlSeconds = resolveShareTtlSeconds(
    body.ttlPreset,
    body.ttlSeconds ?? undefined,
  );
  const token = newSessionToken(); // 32B base64url
  const id = newId("shr");
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;

  const db = getDb();
  await db.insert(shareLinks).values({
    id,
    artifactId,
    tokenHash: hashToken(token),
    expiresAt,
    maxDownloads: body.maxDownloads ?? null,
    downloadCount: 0,
    createdBy: userId,
    createdAt: now,
  });

  await audit({
    actorUserId: userId,
    actorType: "session",
    action: "share.create",
    resourceType: "share",
    resourceId: id,
    ip: meta?.ip,
    userAgent: meta?.userAgent,
    meta: { artifactId, expiresAt, maxDownloads: body.maxDownloads },
  });

  const base = appConfig.APP_BASE_URL.replace(/\/+$/, "");
  // Prefer API public path; web may proxy /api
  const url = `${base}/api/v1/public/shares/${token}`;

  return {
    id,
    token,
    url,
    expiresAt,
    maxDownloads: body.maxDownloads ?? null,
    artifactId,
    createdAt: now,
  };
}

export async function listShares(artifactId?: string) {
  const db = getDb();
  const rows = artifactId
    ? await db
        .select()
        .from(shareLinks)
        .where(eq(shareLinks.artifactId, artifactId))
        .orderBy(desc(shareLinks.createdAt))
        .all()
    : await db
        .select()
        .from(shareLinks)
        .orderBy(desc(shareLinks.createdAt))
        .all();

  return rows.map((r) => ({
    id: r.id,
    artifactId: r.artifactId,
    expiresAt: r.expiresAt,
    maxDownloads: r.maxDownloads,
    downloadCount: r.downloadCount,
    createdAt: r.createdAt,
    revokedAt: r.revokedAt,
    lastDownloadAt: r.lastDownloadAt,
    active:
      !r.revokedAt &&
      r.expiresAt > Date.now() &&
      (r.maxDownloads == null || r.downloadCount < r.maxDownloads),
  }));
}

export async function revokeShare(
  id: string,
  userId: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const db = getDb();
  const row = await db.select().from(shareLinks).where(eq(shareLinks.id, id)).get();
  if (!row) throw new AppError(404, "NOT_FOUND", "Share not found");
  await db
    .update(shareLinks)
    .set({ revokedAt: Date.now() })
    .where(eq(shareLinks.id, id));
  await audit({
    actorUserId: userId,
    actorType: "session",
    action: "share.revoke",
    resourceType: "share",
    resourceId: id,
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
}

export async function streamPublicShare(
  token: string,
  res: Response,
  meta?: { ip?: string; userAgent?: string },
): Promise<void> {
  const db = getDb();
  const tokenHash = hashToken(token);
  const link = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.tokenHash, tokenHash), isNull(shareLinks.revokedAt)))
    .get();

  // Unified 404
  const deny = () => {
    throw new AppError(404, "NOT_FOUND", "Share not found or expired");
  };

  if (!link) deny();
  const now = Date.now();
  if (link!.expiresAt < now) deny();
  if (
    link!.maxDownloads != null &&
    link!.downloadCount >= link!.maxDownloads
  ) {
    deny();
  }

  const art = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, link!.artifactId))
    .get();
  if (!art) deny();

  const diskPath = artifactDiskPath(art!.storageName);
  try {
    await fs.access(diskPath);
  } catch {
    deny();
  }

  await db
    .update(shareLinks)
    .set({
      downloadCount: link!.downloadCount + 1,
      lastDownloadAt: now,
    })
    .where(eq(shareLinks.id, link!.id));

  await audit({
    actorType: "public",
    action: "share.download",
    resourceType: "share",
    resourceId: link!.id,
    ip: meta?.ip,
    userAgent: meta?.userAgent,
    meta: { artifactId: art!.id },
  });

  res.setHeader("Content-Type", art!.contentType || "application/octet-stream");
  res.setHeader("Content-Length", String(art!.sizeBytes));
  res.setHeader(
    "Content-Disposition",
    contentDispositionAttachment(art!.fileName),
  );
  res.setHeader("Cache-Control", "no-store");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(diskPath);
    stream.on("error", reject);
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
}

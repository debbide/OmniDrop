import { eq } from "drizzle-orm";
import {
  assertSafeRemotePath,
  CredentialType,
  TargetType,
  type CreateTargetBody,
  type UpdateTargetBody,
  type SftpConfig,
  type PteroConfig,
  type FtpConfig,
  type WebdavConfig,
} from "@omnidrop/shared";
import { encryptJson, decryptJson } from "@omnidrop/crypto";
import { getDb, credentials, targets, jobTargets, type Target } from "@omnidrop/db";
import { appConfig } from "../config.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { targetTestQueue } from "../lib/queues.js";
import { audit } from "./audit-service.js";

function sanitizeConfig(type: string, config: Record<string, unknown>) {
  if (type === TargetType.SFTP) {
    const c = config as SftpConfig;
    return { ...c, remotePath: assertSafeRemotePath(c.remotePath) };
  }
  if (type === TargetType.PTERODACTYL) {
    const c = config as PteroConfig;
    return {
      ...c,
      panelUrl: c.panelUrl.replace(/\/+$/, ""),
      remotePath: assertSafeRemotePath(c.remotePath),
    };
  }
  if (type === TargetType.FTP) {
    const c = config as FtpConfig;
    return { ...c, remotePath: assertSafeRemotePath(c.remotePath) };
  }
  if (type === TargetType.WEBDAV) {
    const c = config as WebdavConfig;
    return {
      ...c,
      url: c.url.replace(/\/+$/, ""),
      remotePath: assertSafeRemotePath(c.remotePath),
    };
  }
  return config;
}

function publicTarget(row: Target) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    config: JSON.parse(row.configJson) as Record<string, unknown>,
    hasCredential: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function resolveCredential(body: CreateTargetBody): {
  credType: string;
  secretPayload: Record<string, unknown>;
} {
  if (body.type === TargetType.SFTP) {
    const authMethod = body.config.authMethod ?? "password";
    if (authMethod === "password") {
      if (!body.secret.password) {
        throw new AppError(400, "VALIDATION_ERROR", "SFTP password is required");
      }
      return {
        credType: CredentialType.SFTP_PASSWORD,
        secretPayload: { password: body.secret.password },
      };
    }
    if (!body.secret.privateKey) {
      throw new AppError(400, "VALIDATION_ERROR", "SFTP private key is required");
    }
    return {
      credType: CredentialType.SFTP_KEY,
      secretPayload: {
        privateKey: body.secret.privateKey,
        passphrase: body.secret.passphrase,
      },
    };
  }
  if (body.type === TargetType.PTERODACTYL) {
    return {
      credType: CredentialType.PTERO_CLIENT_KEY,
      secretPayload: { apiKey: body.secret.apiKey },
    };
  }
  if (body.type === TargetType.FTP) {
    return {
      credType: CredentialType.FTP_PASSWORD,
      secretPayload: { password: body.secret.password },
    };
  }
  // WebDAV
  if (body.config.authType === "bearer") {
    if (!("bearerToken" in body.secret) || !body.secret.bearerToken) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "WebDAV bearer token is required",
      );
    }
    return {
      credType: CredentialType.WEBDAV_PASSWORD,
      secretPayload: {
        bearerToken: (body.secret as { bearerToken?: string }).bearerToken,
      },
    };
  }
  if (!body.secret.password) {
    throw new AppError(400, "VALIDATION_ERROR", "WebDAV password is required");
  }
  return {
    credType: CredentialType.WEBDAV_PASSWORD,
    secretPayload: { password: body.secret.password },
  };
}

export async function listTargets() {
  const db = getDb();
  const rows = await db.select().from(targets).all();
  return rows.map(publicTarget);
}

export async function getTarget(id: string) {
  const db = getDb();
  const row = await db.select().from(targets).where(eq(targets.id, id)).get();
  if (!row) throw new AppError(404, "NOT_FOUND", "Target not found");
  return publicTarget(row);
}

export async function createTarget(
  body: CreateTargetBody,
  actor?: { userId: string; ip?: string; userAgent?: string },
) {
  const db = getDb();
  const now = Date.now();
  const targetId = newId("tgt");
  const credentialId = newId("crd");
  const config = sanitizeConfig(body.type, body.config as Record<string, unknown>);
  const { credType, secretPayload } = resolveCredential(body);
  const enc = encryptJson(appConfig.OMNIDROP_DATA_KEY, secretPayload);

  try {
    await db.insert(credentials).values({
      id: credentialId,
      label: `${body.name} credential`,
      type: credType,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(targets).values({
      id: targetId,
      name: body.name,
      type: body.type,
      enabled: body.enabled ?? true,
      configJson: JSON.stringify(config),
      credentialId,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      throw new AppError(409, "CONFLICT", "Target name already exists");
    }
    throw err;
  }

  if (actor) {
    await audit({
      actorUserId: actor.userId,
      actorType: "session",
      action: "target.create",
      resourceType: "target",
      resourceId: targetId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      meta: { type: body.type, name: body.name },
    });
  }

  return getTarget(targetId);
}

export async function updateTarget(id: string, body: UpdateTargetBody) {
  const db = getDb();
  const row = await db.select().from(targets).where(eq(targets.id, id)).get();
  if (!row) throw new AppError(404, "NOT_FOUND", "Target not found");
  const now = Date.now();

  const patch: Partial<typeof targets.$inferInsert> = { updatedAt: now };
  if (body.name !== undefined) patch.name = body.name;
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.config) {
    const merged = {
      ...(JSON.parse(row.configJson) as Record<string, unknown>),
      ...body.config,
    };
    patch.configJson = JSON.stringify(sanitizeConfig(row.type, merged));
  }

  try {
    await db.update(targets).set(patch).where(eq(targets.id, id));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      throw new AppError(409, "CONFLICT", "Target name already exists");
    }
    throw err;
  }

  if (body.secret) {
    const hasAny =
      body.secret.password || body.secret.privateKey || body.secret.apiKey;
    if (hasAny) {
      const cred = await db
        .select()
        .from(credentials)
        .where(eq(credentials.id, row.credentialId))
        .get();
      if (!cred) throw new AppError(500, "INTERNAL_ERROR", "Credential missing");
      const existing = decryptJson<Record<string, unknown>>(
        appConfig.OMNIDROP_DATA_KEY,
        cred,
      );
      const next = { ...existing };
      if (body.secret.password) next.password = body.secret.password;
      if (body.secret.privateKey) next.privateKey = body.secret.privateKey;
      if (body.secret.passphrase !== undefined) {
        next.passphrase = body.secret.passphrase;
      }
      if (body.secret.apiKey) next.apiKey = body.secret.apiKey;
      const enc = encryptJson(appConfig.OMNIDROP_DATA_KEY, next);
      await db
        .update(credentials)
        .set({
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          authTag: enc.authTag,
          keyVersion: enc.keyVersion,
          updatedAt: now,
        })
        .where(eq(credentials.id, row.credentialId));
    }
  }

  return getTarget(id);
}

export async function deleteTarget(
  id: string,
  actor?: { userId: string; ip?: string; userAgent?: string },
) {
  const db = getDb();
  const row = await db.select().from(targets).where(eq(targets.id, id)).get();
  if (!row) throw new AppError(404, "NOT_FOUND", "Target not found");

  const allJt = await db
    .select()
    .from(jobTargets)
    .where(eq(jobTargets.targetId, id))
    .all();
  const active = allJt.filter(
    (jt) => jt.status === "pending" || jt.status === "uploading",
  );
  if (active.length > 0) {
    throw new AppError(
      409,
      "CONFLICT",
      "Target has running job assignments; cancel them first",
    );
  }

  await db.delete(targets).where(eq(targets.id, id));
  await db.delete(credentials).where(eq(credentials.id, row.credentialId));

  if (actor) {
    await audit({
      actorUserId: actor.userId,
      actorType: "session",
      action: "target.delete",
      resourceType: "target",
      resourceId: id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      meta: { name: row.name },
    });
  }
}

export async function enqueueTargetTest(id: string) {
  await getTarget(id);
  const job = await targetTestQueue.add(
    "test",
    { targetId: id },
    { jobId: `test-${id}-${Date.now()}` },
  );
  return { queueJobId: job.id };
}

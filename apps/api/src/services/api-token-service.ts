import { and, eq, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getDb, apiTokens } from "@omnidrop/db";
import type { CreateApiTokenBody } from "@omnidrop/shared";
import { AppError } from "../lib/errors.js";
import { hashToken, newId } from "../lib/id.js";
import { audit } from "./audit-service.js";

export function generateApiTokenPlain(): { plain: string; prefix: string } {
  const secret = randomBytes(32).toString("base64url");
  const plain = `od_${secret}`;
  return { plain, prefix: plain.slice(0, 10) };
}

export async function listApiTokens(userId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tokenPrefix: r.tokenPrefix,
    scopes: JSON.parse(r.scopesJson) as string[],
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
  }));
}

export async function createApiToken(
  userId: string,
  body: CreateApiTokenBody,
  meta?: { ip?: string; userAgent?: string },
) {
  const db = getDb();
  const { plain, prefix } = generateApiTokenPlain();
  const id = newId("atk");
  const now = Date.now();
  const expiresAt =
    body.expiresInDays != null
      ? now + body.expiresInDays * 24 * 60 * 60 * 1000
      : null;

  await db.insert(apiTokens).values({
    id,
    userId,
    name: body.name,
    tokenHash: hashToken(plain),
    tokenPrefix: prefix,
    scopesJson: JSON.stringify(body.scopes),
    expiresAt,
    createdAt: now,
  });

  await audit({
    actorUserId: userId,
    actorType: "session",
    action: "api_token.create",
    resourceType: "api_token",
    resourceId: id,
    ip: meta?.ip,
    userAgent: meta?.userAgent,
    meta: { name: body.name, scopes: body.scopes },
  });

  return {
    id,
    name: body.name,
    token: plain,
    tokenPrefix: prefix,
    scopes: body.scopes,
    expiresAt,
    createdAt: now,
  };
}

export async function revokeApiToken(
  userId: string,
  tokenId: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const db = getDb();
  const row = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
    .get();
  if (!row || row.revokedAt) {
    throw new AppError(404, "NOT_FOUND", "API token not found");
  }
  await db
    .update(apiTokens)
    .set({ revokedAt: Date.now() })
    .where(eq(apiTokens.id, tokenId));

  await audit({
    actorUserId: userId,
    actorType: "session",
    action: "api_token.revoke",
    resourceType: "api_token",
    resourceId: tokenId,
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
}

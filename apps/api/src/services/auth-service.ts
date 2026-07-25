import { and, count, eq, gt, isNull } from "drizzle-orm";
import argon2 from "argon2";
import {
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_SECONDS,
  REDIS_KEYS,
} from "@omnidrop/shared";
import { getDb, users, sessions } from "@omnidrop/db";
import { AppError } from "../lib/errors.js";
import { hashToken, newId, newSessionToken } from "../lib/id.js";
import { redis } from "../lib/redis.js";
import { audit } from "./audit-service.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function needsSetup(): Promise<boolean> {
  const db = getDb();
  const row = await db.select({ c: count() }).from(users).get();
  return (row?.c ?? 0) === 0;
}

export async function setupAdmin(
  username: string,
  password: string,
  meta?: { ip?: string; userAgent?: string },
) {
  if ((await needsSetup()) === false) {
    throw new AppError(409, "ALREADY_SETUP", "Admin already configured");
  }
  const db = getDb();
  const now = Date.now();
  const id = newId("usr");
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await db.insert(users).values({ id, username, passwordHash, createdAt: now });
  const session = await createSession(id, meta);
  await audit({
    actorUserId: id,
    actorType: "session",
    action: "auth.setup",
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
  return session;
}

export async function login(
  username: string,
  password: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const failKey = REDIS_KEYS.loginFail(
    `${meta?.ip ?? "unknown"}:${username.toLowerCase()}`,
  );
  const fails = Number((await redis.get(failKey)) ?? "0");
  if (fails >= LOGIN_MAX_FAILURES) {
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many failed login attempts. Try again later.",
    );
  }

  const db = getDb();
  const user = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .get();

  const invalid = async () => {
    const n = await redis.incr(failKey);
    if (n === 1) await redis.expire(failKey, LOGIN_WINDOW_SECONDS);
    await audit({
      actorType: "public",
      action: "auth.login_failed",
      ip: meta?.ip,
      userAgent: meta?.userAgent,
      meta: { username },
    });
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid username or password");
  };

  if (!user) await invalid();
  const ok = await argon2.verify(user!.passwordHash, password);
  if (!ok) await invalid();

  await redis.del(failKey);
  const session = await createSession(user!.id, meta);
  await audit({
    actorUserId: user!.id,
    actorType: "session",
    action: "auth.login",
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
  return { ...session, username: user!.username };
}

export async function logout(
  sessionId: string,
  userId?: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.id, sessionId));
  await audit({
    actorUserId: userId,
    actorType: "session",
    action: "auth.logout",
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
}

async function createSession(
  userId: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const db = getDb();
  const token = newSessionToken();
  const tokenHash = hashToken(token);
  const now = Date.now();
  const sessionId = newId("ses");
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    tokenHash,
    expiresAt: now + SESSION_TTL_MS,
    createdAt: now,
    userAgent: meta?.userAgent ?? null,
    ip: meta?.ip ?? null,
    lastSeenAt: now,
    revokedAt: null,
  });
  return { token, sessionId, expiresAt: now + SESSION_TTL_MS, userId };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const db = getDb();
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new AppError(404, "NOT_FOUND", "User not found");
  const ok = await argon2.verify(user.passwordHash, currentPassword);
  if (!ok) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Current password is wrong");
  }
  const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  // Revoke all sessions
  await db
    .update(sessions)
    .set({ revokedAt: Date.now() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));

  await audit({
    actorUserId: userId,
    actorType: "session",
    action: "auth.password_change",
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
}

export async function listSessions(userId: string) {
  const db = getDb();
  const now = Date.now();
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .all();
  return rows.map((s) => ({
    id: s.id,
    ip: s.ip,
    userAgent: s.userAgent,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    expiresAt: s.expiresAt,
  }));
}

export async function revokeSession(
  userId: string,
  sessionId: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const db = getDb();
  const row = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .get();
  if (!row) throw new AppError(404, "NOT_FOUND", "Session not found");
  await db
    .update(sessions)
    .set({ revokedAt: Date.now() })
    .where(eq(sessions.id, sessionId));
  await audit({
    actorUserId: userId,
    actorType: "session",
    action: "session.revoke",
    resourceType: "session",
    resourceId: sessionId,
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
}

export async function revokeAllSessions(
  userId: string,
  exceptSessionId?: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const db = getDb();
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .all();
  const now = Date.now();
  for (const s of rows) {
    if (exceptSessionId && s.id === exceptSessionId) continue;
    await db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, s.id));
  }
  await audit({
    actorUserId: userId,
    actorType: "session",
    action: "session.revoke_all",
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
}

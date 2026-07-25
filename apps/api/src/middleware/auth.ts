import type { NextFunction, Request, Response } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { ApiScope } from "@omnidrop/shared";
import { getDb, sessions, users, apiTokens } from "@omnidrop/db";
import { AppError } from "../lib/errors.js";
import { hashToken } from "../lib/id.js";

export type AuthUser = {
  id: string;
  username: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
      apiTokenId?: string;
      authMethod?: "session" | "api_token";
      scopes?: string[];
    }
  }
}

const COOKIE_NAME = "omnidrop_session";

export function getSessionCookieName(): string {
  return COOKIE_NAME;
}

export function clientMeta(req: Request): { ip?: string; userAgent?: string } {
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    req.ip ||
    req.socket.remoteAddress ||
    undefined;
  const userAgent = req.headers["user-agent"];
  return { ip, userAgent };
}

function hasScope(scopes: string[], needed: string): boolean {
  if (scopes.includes(ApiScope.STAR) || scopes.includes("*")) return true;
  if (scopes.includes(needed)) return true;
  // write implies read for same resource
  if (needed.endsWith(":read")) {
    const write = needed.replace(/:read$/, ":write");
    if (scopes.includes(write)) return true;
  }
  return false;
}

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cookieToken = req.cookies?.[COOKIE_NAME] as string | undefined;
    const authHeader = req.headers.authorization;
    const bearer =
      authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;

    const db = getDb();
    const now = Date.now();

    if (cookieToken) {
      const tokenHash = hashToken(cookieToken);
      const row = await db
        .select({
          sessionId: sessions.id,
          userId: users.id,
          username: users.username,
          expiresAt: sessions.expiresAt,
          revokedAt: sessions.revokedAt,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            gt(sessions.expiresAt, now),
            isNull(sessions.revokedAt),
          ),
        )
        .get();

      if (!row) {
        throw new AppError(401, "UNAUTHORIZED", "Session expired or invalid");
      }

      // best-effort last_seen throttle
      await db
        .update(sessions)
        .set({ lastSeenAt: now })
        .where(eq(sessions.id, row.sessionId));

      req.user = { id: row.userId, username: row.username };
      req.sessionId = row.sessionId;
      req.authMethod = "session";
      req.scopes = [ApiScope.STAR];
      next();
      return;
    }

    if (bearer?.startsWith("od_")) {
      const tokenHash = hashToken(bearer);
      const row = await db
        .select({
          token: apiTokens,
          username: users.username,
        })
        .from(apiTokens)
        .innerJoin(users, eq(apiTokens.userId, users.id))
        .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)))
        .get();

      if (!row) {
        throw new AppError(401, "UNAUTHORIZED", "Invalid API token");
      }
      if (row.token.expiresAt && row.token.expiresAt < now) {
        throw new AppError(401, "UNAUTHORIZED", "API token expired");
      }

      await db
        .update(apiTokens)
        .set({ lastUsedAt: now })
        .where(eq(apiTokens.id, row.token.id));

      req.user = { id: row.token.userId, username: row.username };
      req.apiTokenId = row.token.id;
      req.authMethod = "api_token";
      req.scopes = JSON.parse(row.token.scopesJson) as string[];
      next();
      return;
    }

    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  } catch (err) {
    next(err);
  }
}

/** Session cookie only — for managing sessions / API tokens. */
export async function requireSessionAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (req.authMethod !== "session") {
      next(
        new AppError(
          403,
          "FORBIDDEN",
          "This endpoint requires interactive session login",
        ),
      );
      return;
    }
    next();
  });
}

export function requireScope(...needed: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const scopes = req.scopes ?? [];
    const ok = needed.every((n) => hasScope(scopes, n));
    if (!ok) {
      next(
        new AppError(
          403,
          "FORBIDDEN",
          `Missing required scope: ${needed.join(", ")}`,
        ),
      );
      return;
    }
    next();
  };
}

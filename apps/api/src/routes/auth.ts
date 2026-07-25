import { Router } from "express";
import { ZodError } from "zod";
import {
  createApiTokenBodySchema,
  loginBodySchema,
  setupBodySchema,
} from "@omnidrop/shared";
import { appConfig } from "../config.js";
import { sendError, AppError } from "../lib/errors.js";
import { paramId } from "../lib/params.js";
import {
  clientMeta,
  getSessionCookieName,
  requireAuth,
  requireSessionAuth,
} from "../middleware/auth.js";
import * as authService from "../services/auth-service.js";
import * as apiTokenService from "../services/api-token-service.js";

export const authRouter = Router();

function asAppError(err: unknown): unknown {
  if (err instanceof ZodError) {
    return new AppError(400, "VALIDATION_ERROR", "Invalid request", err.flatten());
  }
  return err;
}

function setSessionCookie(
  res: import("express").Response,
  token: string,
  expiresAt: number,
) {
  res.cookie(getSessionCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: appConfig.COOKIE_SECURE,
    maxAge: Math.max(0, expiresAt - Date.now()),
    path: "/",
  });
}

authRouter.get("/setup-status", async (_req, res) => {
  try {
    res.json({ needsSetup: await authService.needsSetup() });
  } catch (err) {
    sendError(res, err);
  }
});

authRouter.post("/setup", async (req, res) => {
  try {
    const body = setupBodySchema.parse(req.body);
    const meta = clientMeta(req);
    const session = await authService.setupAdmin(body.username, body.password, meta);
    setSessionCookie(res, session.token, session.expiresAt);
    res.status(201).json({ ok: true, username: body.username });
  } catch (err) {
    sendError(res, asAppError(err));
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const body = loginBodySchema.parse(req.body);
    const meta = clientMeta(req);
    const session = await authService.login(body.username, body.password, meta);
    setSessionCookie(res, session.token, session.expiresAt);
    res.json({ ok: true, username: session.username });
  } catch (err) {
    sendError(res, asAppError(err));
  }
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  try {
    if (req.sessionId) {
      await authService.logout(req.sessionId, req.user?.id, clientMeta(req));
    }
    res.clearCookie(getSessionCookieName(), { path: "/" });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({
    user: req.user,
    authMethod: req.authMethod,
    scopes: req.scopes,
  });
});

authRouter.post("/change-password", requireSessionAuth, async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword ?? "");
    const newPassword = String(req.body?.newPassword ?? "");
    if (newPassword.length < 10) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Password must be at least 10 characters",
      );
    }
    await authService.changePassword(
      req.user!.id,
      currentPassword,
      newPassword,
      clientMeta(req),
    );
    res.clearCookie(getSessionCookieName(), { path: "/" });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

authRouter.get("/sessions", requireSessionAuth, async (req, res) => {
  try {
    const items = await authService.listSessions(req.user!.id);
    res.json({
      items: items.map((s) => ({
        ...s,
        current: s.id === req.sessionId,
      })),
    });
  } catch (err) {
    sendError(res, err);
  }
});

authRouter.delete("/sessions/:id", requireSessionAuth, async (req, res) => {
  try {
    const sid = paramId(req);
    await authService.revokeSession(req.user!.id, sid, clientMeta(req));
    if (sid === req.sessionId) {
      res.clearCookie(getSessionCookieName(), { path: "/" });
    }
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
});

authRouter.delete("/sessions", requireSessionAuth, async (req, res) => {
  try {
    await authService.revokeAllSessions(
      req.user!.id,
      req.sessionId,
      clientMeta(req),
    );
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

authRouter.get("/api-tokens", requireSessionAuth, async (req, res) => {
  try {
    res.json({ items: await apiTokenService.listApiTokens(req.user!.id) });
  } catch (err) {
    sendError(res, err);
  }
});

authRouter.post("/api-tokens", requireSessionAuth, async (req, res) => {
  try {
    const body = createApiTokenBodySchema.parse(req.body);
    const created = await apiTokenService.createApiToken(
      req.user!.id,
      body,
      clientMeta(req),
    );
    res.status(201).json(created);
  } catch (err) {
    sendError(res, asAppError(err));
  }
});

authRouter.delete("/api-tokens/:id", requireSessionAuth, async (req, res) => {
  try {
    await apiTokenService.revokeApiToken(
      req.user!.id,
      paramId(req),
      clientMeta(req),
    );
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
});

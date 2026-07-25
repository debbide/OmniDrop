import { Router } from "express";
import { REDIS_KEYS } from "@omnidrop/shared";
import { AppError, sendError } from "../lib/errors.js";
import { paramId } from "../lib/params.js";
import { clientMeta } from "../middleware/auth.js";
import { redis } from "../lib/redis.js";
import * as shareService from "../services/share-service.js";

export const publicSharesRouter = Router();

publicSharesRouter.get("/:token", async (req, res) => {
  try {
    const meta = clientMeta(req);
    const ip = meta.ip ?? "unknown";
    const key = REDIS_KEYS.shareDownload(ip);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 60);
    if (n > 60) {
      throw new AppError(429, "RATE_LIMITED", "Too many download requests");
    }
    await shareService.streamPublicShare(paramId(req, "token"), res, meta);
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
  }
});

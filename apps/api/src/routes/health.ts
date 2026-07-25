import { Router } from "express";
import fs from "node:fs";
import { getRawClient } from "@omnidrop/db";
import { appConfig } from "../config.js";
import { redis } from "../lib/redis.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  let dbOk = false;
  let redisOk = false;
  let tempFreeBytes: number | null = null;

  try {
    await getRawClient().execute("SELECT 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }

  try {
    const pong = await redis.ping();
    redisOk = pong === "PONG";
  } catch {
    redisOk = false;
  }

  try {
    fs.mkdirSync(appConfig.TMP_DIR, { recursive: true });
    // best-effort free space is platform-specific; report writable only on win without statfs
    tempFreeBytes = null;
  } catch {
    tempFreeBytes = -1;
  }

  const ok = dbOk && redisOk;
  res.status(ok ? 200 : 503).json({
    ok,
    db: dbOk,
    redis: redisOk,
    tempDir: appConfig.TMP_DIR,
    tempFreeBytes,
    version: "0.1.0",
  });
});

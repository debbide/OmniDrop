import { Router } from "express";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { settingsBodySchema } from "@omnidrop/shared";
import { getDb, settings } from "@omnidrop/db";
import { appConfig } from "../config.js";
import { AppError, sendError } from "../lib/errors.js";
import { requireAuth } from "../middleware/auth.js";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const db = getDb();
  const row = await db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return fallback;
  try {
    return JSON.parse(row.valueJson) as T;
  } catch {
    return fallback;
  }
}

async function writeSetting(key: string, value: unknown) {
  const db = getDb();
  const valueJson = JSON.stringify(value);
  const existing = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  if (existing) {
    await db.update(settings).set({ valueJson }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, valueJson });
  }
}

settingsRouter.get("/", async (_req, res) => {
  try {
    res.json({
      maxDownloadConcurrency: await readSetting(
        "maxDownloadConcurrency",
        appConfig.MAX_DOWNLOAD_CONCURRENCY,
      ),
      maxUploadConcurrency: await readSetting(
        "maxUploadConcurrency",
        appConfig.MAX_UPLOAD_CONCURRENCY,
      ),
      jobTmpTtlMinutes: await readSetting(
        "jobTmpTtlMinutes",
        appConfig.JOB_TMP_TTL_MINUTES,
      ),
      hasGithubToken: Boolean(
        await readSetting<string | null>(
          "githubToken",
          appConfig.GITHUB_TOKEN ?? null,
        ),
      ),
    });
  } catch (err) {
    sendError(res, err);
  }
});

settingsRouter.put("/", async (req, res) => {
  try {
    const body = settingsBodySchema.parse(req.body);
    if (body.maxDownloadConcurrency !== undefined) {
      await writeSetting("maxDownloadConcurrency", body.maxDownloadConcurrency);
    }
    if (body.maxUploadConcurrency !== undefined) {
      await writeSetting("maxUploadConcurrency", body.maxUploadConcurrency);
    }
    if (body.jobTmpTtlMinutes !== undefined) {
      await writeSetting("jobTmpTtlMinutes", body.jobTmpTtlMinutes);
    }
    if (body.githubToken !== undefined) {
      await writeSetting("githubToken", body.githubToken);
    }
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ZodError) {
      sendError(
        res,
        new AppError(400, "VALIDATION_ERROR", "Invalid request", err.flatten()),
      );
      return;
    }
    sendError(res, err);
  }
});

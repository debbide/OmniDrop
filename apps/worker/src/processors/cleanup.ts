import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, jobs } from "@omnidrop/db";
import type { Job } from "bullmq";
import { jobTempDir } from "../download/stream-download.js";
import { logger } from "../logger.js";

export async function processCleanup(job: Job<{ jobId: string }>) {
  const { jobId } = job.data;
  const dir = jobTempDir(jobId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    const db = getDb();
    await db.update(jobs).set({ tempPath: null }).where(eq(jobs.id, jobId));
    logger.info({ jobId, dir }, "Temp cleaned");
  } catch (err) {
    logger.warn({ err, jobId, dir }, "Cleanup failed");
    throw err;
  }
}

export async function sweepOldTemp(ttlMinutes: number) {
  const base = path.dirname(jobTempDir("_"));
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    const cutoff = Date.now() - ttlMinutes * 60 * 1000;
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(base, ent.name);
      const st = await fs.stat(full);
      if (st.mtimeMs < cutoff) {
        await fs.rm(full, { recursive: true, force: true });
        logger.info({ dir: full }, "Swept old temp dir");
      }
    }
  } catch {
    /* base may not exist yet */
  }
}

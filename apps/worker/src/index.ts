import path from "node:path";
import fs from "node:fs";
import { Worker } from "bullmq";
import { QUEUE_NAMES } from "@omnidrop/shared";
import { ensureDatabase } from "@omnidrop/db";
import { workerConfig } from "./config.js";
import { logger } from "./logger.js";
import { redis } from "./lib/redis.js";
import { processDownload } from "./processors/download.js";
import { processUpload } from "./processors/upload.js";
import { processCleanup, sweepOldTemp } from "./processors/cleanup.js";
import { processTargetTest } from "./processors/target-test.js";
import { processFsDownload } from "./processors/fs-download.js";
import { processFsUpload } from "./processors/fs-upload.js";

const rootish = path.resolve(
  process.cwd(),
  process.cwd().endsWith("worker") ? "../.." : ".",
);
const databasePath = path.isAbsolute(workerConfig.DATABASE_PATH)
  ? workerConfig.DATABASE_PATH
  : path.resolve(rootish, workerConfig.DATABASE_PATH);
const tmpDir = path.isAbsolute(workerConfig.TMP_DIR)
  ? workerConfig.TMP_DIR
  : path.resolve(rootish, workerConfig.TMP_DIR);

fs.mkdirSync(tmpDir, { recursive: true });
const artifactsDir = path.isAbsolute(workerConfig.ARTIFACTS_DIR)
  ? workerConfig.ARTIFACTS_DIR
  : path.resolve(rootish, workerConfig.ARTIFACTS_DIR);
fs.mkdirSync(artifactsDir, { recursive: true });
await ensureDatabase(databasePath);
logger.info({ databasePath, tmpDir, artifactsDir }, "Worker database ready");

const workers = [
  new Worker(QUEUE_NAMES.DOWNLOAD, processDownload, {
    connection: redis,
    concurrency: workerConfig.MAX_DOWNLOAD_CONCURRENCY,
  }),
  new Worker(QUEUE_NAMES.UPLOAD, processUpload, {
    connection: redis,
    concurrency: workerConfig.MAX_UPLOAD_CONCURRENCY,
  }),
  new Worker(QUEUE_NAMES.CLEANUP, processCleanup, {
    connection: redis,
    concurrency: 1,
  }),
  new Worker(QUEUE_NAMES.TARGET_TEST, processTargetTest, {
    connection: redis,
    concurrency: 2,
  }),
  new Worker(QUEUE_NAMES.FS_DOWNLOAD, processFsDownload, {
    connection: redis,
    concurrency: 2,
  }),
  new Worker(QUEUE_NAMES.FS_UPLOAD, processFsUpload, {
    connection: redis,
    concurrency: 2,
  }),
];

for (const w of workers) {
  w.on("failed", (job, err) => {
    logger.error(
      { queue: w.name, jobId: job?.id, err: err.message },
      "Job failed",
    );
  });
  w.on("completed", (job) => {
    logger.debug({ queue: w.name, jobId: job.id }, "Job completed");
  });
}

void sweepOldTemp(workerConfig.JOB_TMP_TTL_MINUTES);

logger.info(
  {
    downloadConcurrency: workerConfig.MAX_DOWNLOAD_CONCURRENCY,
    uploadConcurrency: workerConfig.MAX_UPLOAD_CONCURRENCY,
  },
  "OmniDrop worker started",
);

async function shutdown() {
  logger.info("Shutting down worker");
  await Promise.all(workers.map((w) => w.close()));
  await redis.quit();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

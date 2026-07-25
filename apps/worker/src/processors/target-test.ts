import type { Job } from "bullmq";
import { createRemoteFs } from "@omnidrop/remote-fs";
import { loadTargetWithSecret } from "../lib/targets.js";
import { logger } from "../logger.js";
import { redis } from "../lib/redis.js";
import { workerConfig } from "../config.js";

export async function processTargetTest(job: Job<{ targetId: string }>) {
  const { targetId } = job.data;
  const loaded = await loadTargetWithSecret(targetId);
  let result: { ok: boolean; message: string };

  try {
    const adapter = createRemoteFs(
      loaded.target.type,
      loaded.config,
      loaded.secret,
      { rclonePath: workerConfig.RCLONE_PATH },
    );
    result = await adapter.testConnection();
  } catch (err) {
    result = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  await redis.set(
    `target-test:${targetId}:last`,
    JSON.stringify({ ...result, at: Date.now() }),
    "EX",
    3600,
  );
  logger.info({ targetId, result }, "Target test finished");
  return result;
}

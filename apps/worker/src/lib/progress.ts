import { REDIS_KEYS } from "@omnidrop/shared";
import { redis } from "./redis.js";

export async function publishJobEvent(
  jobId: string,
  event: string,
  data: unknown,
): Promise<void> {
  const payload = JSON.stringify({ event, data, t: Date.now() });
  await redis.publish(REDIS_KEYS.jobEvents(jobId), payload);
  await redis.hset(
    REDIS_KEYS.jobProgress(jobId),
    "lastEvent",
    event,
    "updatedAt",
    String(Date.now()),
  );
  await redis.expire(REDIS_KEYS.jobProgress(jobId), 86400);
}

export async function isCanceled(jobId: string): Promise<boolean> {
  const v = await redis.get(REDIS_KEYS.jobCancel(jobId));
  return v === "1";
}

export async function setProgressFields(
  jobId: string,
  fields: Record<string, string | number>,
): Promise<void> {
  const flat: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    flat.push(k, String(v));
  }
  if (flat.length) {
    await redis.hset(REDIS_KEYS.jobProgress(jobId), ...flat);
    await redis.expire(REDIS_KEYS.jobProgress(jobId), 86400);
  }
}

import { Redis } from "ioredis";
import { workerConfig } from "../config.js";

export const redis = new Redis(workerConfig.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

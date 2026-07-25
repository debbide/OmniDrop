import { Redis } from "ioredis";
import { appConfig } from "../config.js";

export const redis = new Redis(appConfig.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

export function createSubscriber(): Redis {
  return new Redis(appConfig.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@omnidrop/shared";
import { redis } from "./redis.js";

export const downloadQueue = new Queue(QUEUE_NAMES.DOWNLOAD, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export const uploadQueue = new Queue(QUEUE_NAMES.UPLOAD, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export const cleanupQueue = new Queue(QUEUE_NAMES.CLEANUP, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: 50,
    removeOnFail: 50,
  },
});

export const targetTestQueue = new Queue(QUEUE_NAMES.TARGET_TEST, {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 20,
    removeOnFail: 20,
  },
});

export const fsDownloadQueue = new Queue(QUEUE_NAMES.FS_DOWNLOAD, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 50,
    removeOnFail: 100,
  },
});

export const fsUploadQueue = new Queue(QUEUE_NAMES.FS_UPLOAD, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 50,
    removeOnFail: 100,
  },
});

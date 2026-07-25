import { Router } from "express";
import { ZodError } from "zod";
import {
  createJobBodySchema,
  previewGithubReleaseBodySchema,
  REDIS_KEYS,
} from "@omnidrop/shared";
import { AppError, sendError } from "../lib/errors.js";
import { requireAuth } from "../middleware/auth.js";
import * as jobService from "../services/job-service.js";
import * as githubService from "../services/github-service.js";
import { createSubscriber } from "../lib/redis.js";
import { logger } from "../logger.js";

export const jobsRouter = Router();

jobsRouter.use(requireAuth);

function asAppError(err: unknown): unknown {
  if (err instanceof ZodError) {
    return new AppError(400, "VALIDATION_ERROR", "Invalid request", err.flatten());
  }
  return err;
}

jobsRouter.get("/", async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 20;
    res.json(await jobService.listJobs({ status, page, pageSize }));
  } catch (err) {
    sendError(res, err);
  }
});

/** Preview GitHub Release assets before enqueueing a download */
jobsRouter.post("/preview-github", async (req, res) => {
  try {
    const body = previewGithubReleaseBodySchema.parse(req.body);
    res.json(await githubService.previewGithubRelease(body));
  } catch (err) {
    sendError(res, asAppError(err));
  }
});

jobsRouter.post("/", async (req, res) => {
  try {
    const body = createJobBodySchema.parse(req.body);
    const job = await jobService.createJob(body, req.user!.id);
    res.status(201).json(job);
  } catch (err) {
    sendError(res, asAppError(err));
  }
});

jobsRouter.get("/stats/dashboard", async (_req, res) => {
  try {
    res.json(await jobService.getDashboardStats());
  } catch (err) {
    sendError(res, err);
  }
});

jobsRouter.get("/:id", async (req, res) => {
  try {
    res.json(await jobService.getJobDetail(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

jobsRouter.post("/:id/cancel", async (req, res) => {
  try {
    res.json(await jobService.cancelJob(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

jobsRouter.delete("/:id", async (req, res) => {
  try {
    res.json(await jobService.deleteJob(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

jobsRouter.post("/:id/retry", async (req, res) => {
  try {
    res.json(await jobService.retryFailedTargets(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

jobsRouter.get("/:id/events", async (req, res) => {
  const jobId = req.params.id;
  try {
    await jobService.getJobDetail(jobId);
  } catch (err) {
    sendError(res, err);
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send("job.updated", await jobService.getJobDetail(jobId));

  const sub = createSubscriber();
  const channel = REDIS_KEYS.jobEvents(jobId);
  await sub.subscribe(channel);

  const onMessage = (_ch: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as { event: string; data: unknown };
      send(parsed.event, parsed.data);
    } catch {
      send("message", message);
    }
  };
  sub.on("message", onMessage);

  const heartbeat = setInterval(() => {
    send("heartbeat", { t: Date.now() });
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sub.off("message", onMessage);
    sub.unsubscribe(channel).catch(() => undefined);
    sub.quit().catch(() => undefined);
    logger.debug({ jobId }, "SSE client disconnected");
  });
});

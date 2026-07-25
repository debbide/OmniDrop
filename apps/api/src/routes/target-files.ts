import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { ZodError } from "zod";
import {
  ApiScope,
  remoteDeleteBodySchema,
  remoteDownloadBodySchema,
  remoteMkdirBodySchema,
  remoteRenameBodySchema,
  remoteUploadFromArtifactBodySchema,
  sanitizeFileName,
} from "@omnidrop/shared";
import { AppError, sendError } from "../lib/errors.js";
import { paramId } from "../lib/params.js";
import {
  clientMeta,
  requireAuth,
  requireScope,
} from "../middleware/auth.js";
import { fsDownloadQueue } from "../lib/queues.js";
import { redis } from "../lib/redis.js";
import { newId } from "../lib/id.js";
import * as remoteFs from "../services/remote-fs-service.js";
import { dispatchArtifact } from "../services/artifact-service.js";
import { audit } from "../services/audit-service.js";

export const targetFilesRouter = Router({ mergeParams: true });
targetFilesRouter.use(requireAuth);

const upload = multer({
  dest: path.join(os.tmpdir(), "omnidrop-uploads"),
  limits: { fileSize: 512 * 1024 * 1024 },
});

function asAppError(err: unknown): unknown {
  if (err instanceof ZodError) {
    return new AppError(400, "VALIDATION_ERROR", "Invalid request", err.flatten());
  }
  return err;
}

function tid(req: import("express").Request): string {
  return paramId(req, "id");
}

targetFilesRouter.get(
  "/",
  requireScope(ApiScope.TARGETS_READ),
  async (req, res) => {
    try {
      const pathQ = req.query.path ? String(req.query.path) : undefined;
      res.json(await remoteFs.listRemoteFiles(tid(req), pathQ));
    } catch (err) {
      sendError(res, err);
    }
  },
);

targetFilesRouter.post(
  "/mkdir",
  requireScope(ApiScope.TARGETS_WRITE),
  async (req, res) => {
    try {
      const body = remoteMkdirBodySchema.parse(req.body);
      res.status(201).json(
        await remoteFs.remoteMkdir(tid(req), body.path, body.name, {
          userId: req.user!.id,
          ...clientMeta(req),
        }),
      );
    } catch (err) {
      sendError(res, asAppError(err));
    }
  },
);

targetFilesRouter.post(
  "/rename",
  requireScope(ApiScope.TARGETS_WRITE),
  async (req, res) => {
    try {
      const body = remoteRenameBodySchema.parse(req.body);
      res.json(
        await remoteFs.remoteRename(tid(req), body.path, body.newName, {
          userId: req.user!.id,
          ...clientMeta(req),
        }),
      );
    } catch (err) {
      sendError(res, asAppError(err));
    }
  },
);

targetFilesRouter.post(
  "/delete",
  requireScope(ApiScope.TARGETS_WRITE),
  async (req, res) => {
    try {
      const body = remoteDeleteBodySchema.parse(req.body);
      res.json(
        await remoteFs.remoteDelete(tid(req), body.paths, body.recursive ?? true, {
          userId: req.user!.id,
          ...clientMeta(req),
        }),
      );
    } catch (err) {
      sendError(res, asAppError(err));
    }
  },
);

/** Poll fs upload/download progress written by worker to Redis */
targetFilesRouter.get(
  "/transfers/:jobId",
  requireScope(ApiScope.TARGETS_READ),
  async (req, res) => {
    try {
      // Never cache progress — browsers/nginx 304 was freezing the UI at "queued"
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Surrogate-Control", "no-store");

      const jobId = paramId(req, "jobId");
      const kind = jobId.startsWith("fsd_")
        ? "download"
        : jobId.startsWith("fsu_")
          ? "upload"
          : null;
      if (!kind) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid transfer job id");
      }
      const raw = await redis.get(
        kind === "upload" ? `fs-upload:${jobId}` : `fs-download:${jobId}`,
      );
      if (!raw) {
        res.json({
          jobId,
          kind,
          status: "queued",
          bytesDone: 0,
          bytesTotal: null,
          progressPct: 0,
          updatedAt: Date.now(),
        });
        return;
      }
      // Bust ETag sameness if proxy still tries conditional GET
      const body = JSON.parse(raw) as Record<string, unknown>;
      body.pollAt = Date.now();
      res.json(body);
    } catch (err) {
      sendError(res, asAppError(err));
    }
  },
);

/** Enqueue download remote file → local artifact library */
targetFilesRouter.post(
  "/download",
  requireScope(ApiScope.ARTIFACTS_WRITE),
  async (req, res) => {
    try {
      const body = remoteDownloadBodySchema.parse(req.body);
      const jobId = newId("fsd");
      const fileName = body.path.split("/").filter(Boolean).pop() || body.path;
      await redis.set(
        `fs-download:${jobId}`,
        JSON.stringify({
          kind: "download",
          jobId,
          status: "queued",
          targetId: tid(req),
          fileName,
          remotePath: body.path,
          bytesDone: 0,
          bytesTotal: null,
          progressPct: 0,
          updatedAt: Date.now(),
        }),
        "EX",
        86400,
      );
      await fsDownloadQueue.add(
        "fs-download",
        {
          jobId,
          targetId: tid(req),
          remotePath: body.path,
          userId: req.user!.id,
        },
        { jobId: `fs-download-${jobId}` },
      );
      await audit({
        actorUserId: req.user!.id,
        actorType: "session",
        action: "remote.download_enqueue",
        resourceType: "target",
        resourceId: tid(req),
        ...clientMeta(req),
        meta: { remotePath: body.path, jobId },
      });
      res.status(202).json({ jobId, status: "queued", fileName });
    } catch (err) {
      sendError(res, asAppError(err));
    }
  },
);

/**
 * Upload from artifact library to this target at destPath.
 * Creates a real job in 任务列表 (progress + cancel via /jobs/:id).
 */
targetFilesRouter.post(
  "/upload-artifact",
  requireScope(ApiScope.TARGETS_WRITE),
  async (req, res) => {
    try {
      const body = remoteUploadFromArtifactBodySchema.parse(req.body);
      const targetId = tid(req);
      const result = await dispatchArtifact(
        body.artifactId,
        {
          targetIds: [targetId],
          destPath: body.destPath,
          options: {
            overwrite: body.overwrite !== false,
            retries: 2,
            destPath: body.destPath,
          },
        },
        req.user!.id,
        clientMeta(req),
      );
      await audit({
        actorUserId: req.user!.id,
        actorType: "session",
        action: "remote.upload_enqueue",
        resourceType: "target",
        resourceId: targetId,
        ...clientMeta(req),
        meta: {
          artifactId: body.artifactId,
          destPath: body.destPath,
          jobId: result.jobId,
        },
      });
      res.status(202).json({
        jobId: result.jobId,
        status: "queued",
        // mark as real job so frontend can open /jobs/:id
        kind: "job",
      });
    } catch (err) {
      sendError(res, asAppError(err));
    }
  },
);

/** Direct multipart upload (sync for moderate files) */
targetFilesRouter.post(
  "/upload",
  requireScope(ApiScope.TARGETS_WRITE),
  upload.single("file"),
  async (req, res) => {
    const tmp = req.file?.path;
    try {
      if (!req.file || !tmp) {
        throw new AppError(400, "VALIDATION_ERROR", "file is required");
      }
      const destPath = req.body?.destPath ? String(req.body.destPath) : undefined;
      const fileName = sanitizeFileName(req.file.originalname || req.file.filename);
      const overwrite = String(req.body?.overwrite ?? "true") !== "false";
      const result = await remoteFs.remoteUploadLocal(
        tid(req),
        tmp,
        destPath,
        fileName,
        overwrite,
        { userId: req.user!.id, ...clientMeta(req) },
      );
      res.status(201).json(result);
    } catch (err) {
      sendError(res, asAppError(err));
    } finally {
      if (tmp) await fs.unlink(tmp).catch(() => undefined);
    }
  },
);

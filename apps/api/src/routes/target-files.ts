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
import { fsDownloadQueue, fsUploadQueue } from "../lib/queues.js";
import { newId } from "../lib/id.js";
import * as remoteFs from "../services/remote-fs-service.js";
import { getArtifact } from "../services/artifact-service.js";
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

/** Enqueue download remote file → local artifact library */
targetFilesRouter.post(
  "/download",
  requireScope(ApiScope.ARTIFACTS_WRITE),
  async (req, res) => {
    try {
      const body = remoteDownloadBodySchema.parse(req.body);
      const jobId = newId("fsd");
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
      res.status(202).json({ jobId, status: "queued" });
    } catch (err) {
      sendError(res, asAppError(err));
    }
  },
);

/** Upload from existing artifact to remote path */
targetFilesRouter.post(
  "/upload-artifact",
  requireScope(ApiScope.TARGETS_WRITE),
  async (req, res) => {
    try {
      const body = remoteUploadFromArtifactBodySchema.parse(req.body);
      await getArtifact(body.artifactId);
      const jobId = newId("fsu");
      await fsUploadQueue.add(
        "fs-upload",
        {
          jobId,
          targetId: tid(req),
          artifactId: body.artifactId,
          destPath: body.destPath,
          overwrite: body.overwrite !== false,
          userId: req.user!.id,
        },
        { jobId: `fs-upload-${jobId}` },
      );
      res.status(202).json({ jobId, status: "queued" });
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

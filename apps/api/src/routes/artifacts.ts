import { createReadStream } from "node:fs";
import { Router } from "express";
import { ZodError } from "zod";
import {
  ApiScope,
  contentDispositionAttachment,
  createShareBodySchema,
  dispatchArtifactBodySchema,
  renameArtifactBodySchema,
} from "@omnidrop/shared";
import { AppError, sendError } from "../lib/errors.js";
import { paramId } from "../lib/params.js";
import {
  clientMeta,
  requireAuth,
  requireScope,
} from "../middleware/auth.js";
import * as artifactService from "../services/artifact-service.js";
import * as shareService from "../services/share-service.js";

export const artifactsRouter = Router();
artifactsRouter.use(requireAuth);

function asAppError(err: unknown): unknown {
  if (err instanceof ZodError) {
    return new AppError(400, "VALIDATION_ERROR", "Invalid request", err.flatten());
  }
  return err;
}

artifactsRouter.get(
  "/",
  requireScope(ApiScope.ARTIFACTS_READ),
  async (req, res) => {
    try {
      const page = req.query.page ? Number(req.query.page) : 1;
      const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 50;
      res.json(await artifactService.listArtifacts({ page, pageSize }));
    } catch (err) {
      sendError(res, err);
    }
  },
);

artifactsRouter.get(
  "/:id",
  requireScope(ApiScope.ARTIFACTS_READ),
  async (req, res) => {
    try {
      res.json((await artifactService.getArtifact(paramId(req))).public);
    } catch (err) {
      sendError(res, err);
    }
  },
);

artifactsRouter.patch(
  "/:id",
  requireScope(ApiScope.ARTIFACTS_WRITE),
  async (req, res) => {
    try {
      const body = renameArtifactBodySchema.parse(req.body);
      const meta = clientMeta(req);
      res.json(
        await artifactService.renameArtifact(paramId(req), body.fileName, {
          userId: req.user!.id,
          ...meta,
        }),
      );
    } catch (err) {
      sendError(res, asAppError(err));
    }
  },
);

artifactsRouter.delete(
  "/:id",
  requireScope(ApiScope.ARTIFACTS_WRITE),
  async (req, res) => {
    try {
      await artifactService.deleteArtifact(paramId(req), {
        userId: req.user!.id,
        ...clientMeta(req),
      });
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  },
);

artifactsRouter.get(
  "/:id/download",
  requireScope(ApiScope.ARTIFACTS_READ),
  async (req, res) => {
    try {
      const { row } = await artifactService.getArtifact(paramId(req));
      const diskPath = artifactService.artifactDiskPath(row.storageName);
      res.setHeader(
        "Content-Type",
        row.contentType || "application/octet-stream",
      );
      res.setHeader("Content-Length", String(row.sizeBytes));
      res.setHeader(
        "Content-Disposition",
        contentDispositionAttachment(row.fileName),
      );
      createReadStream(diskPath).pipe(res);
    } catch (err) {
      sendError(res, err);
    }
  },
);

artifactsRouter.post(
  "/:id/dispatch",
  requireScope(ApiScope.JOBS_WRITE),
  async (req, res) => {
    try {
      const body = dispatchArtifactBodySchema.parse(req.body);
      const result = await artifactService.dispatchArtifact(
        paramId(req),
        body,
        req.user!.id,
        clientMeta(req),
      );
      res.status(201).json(result);
    } catch (err) {
      sendError(res, asAppError(err));
    }
  },
);

artifactsRouter.post(
  "/:id/shares",
  requireScope(ApiScope.SHARES_WRITE),
  async (req, res) => {
    try {
      const body = createShareBodySchema.parse(req.body);
      const created = await shareService.createShare(
        paramId(req),
        body,
        req.user!.id,
        clientMeta(req),
      );
      res.status(201).json(created);
    } catch (err) {
      sendError(res, asAppError(err));
    }
  },
);

artifactsRouter.get(
  "/:id/shares",
  requireScope(ApiScope.ARTIFACTS_READ),
  async (req, res) => {
    try {
      res.json({ items: await shareService.listShares(paramId(req)) });
    } catch (err) {
      sendError(res, err);
    }
  },
);

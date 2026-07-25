import { Router } from "express";
import { ZodError } from "zod";
import { createTargetBodySchema, updateTargetBodySchema } from "@omnidrop/shared";
import { AppError, sendError } from "../lib/errors.js";
import { clientMeta, requireAuth } from "../middleware/auth.js";
import * as targetService from "../services/target-service.js";
import { targetFilesRouter } from "./target-files.js";

export const targetsRouter = Router();

targetsRouter.use(requireAuth);
targetsRouter.use("/:id/files", targetFilesRouter);

function asAppError(err: unknown): unknown {
  if (err instanceof ZodError) {
    return new AppError(400, "VALIDATION_ERROR", "Invalid request", err.flatten());
  }
  return err;
}

targetsRouter.get("/", async (_req, res) => {
  try {
    res.json({ items: await targetService.listTargets() });
  } catch (err) {
    sendError(res, err);
  }
});

targetsRouter.post("/", async (req, res) => {
  try {
    const body = createTargetBodySchema.parse(req.body);
    const item = await targetService.createTarget(body, {
      userId: req.user!.id,
      ...clientMeta(req),
    });
    res.status(201).json(item);
  } catch (err) {
    sendError(res, asAppError(err));
  }
});

targetsRouter.get("/:id", async (req, res) => {
  try {
    res.json(await targetService.getTarget(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

targetsRouter.patch("/:id", async (req, res) => {
  try {
    const body = updateTargetBodySchema.parse(req.body);
    res.json(await targetService.updateTarget(req.params.id, body));
  } catch (err) {
    sendError(res, asAppError(err));
  }
});

targetsRouter.delete("/:id", async (req, res) => {
  try {
    await targetService.deleteTarget(req.params.id, {
      userId: req.user!.id,
      ...clientMeta(req),
    });
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
});

targetsRouter.post("/:id/test", async (req, res) => {
  try {
    const result = await targetService.enqueueTargetTest(req.params.id);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

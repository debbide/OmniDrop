import { Router } from "express";
import { ApiScope } from "@omnidrop/shared";
import { sendError } from "../lib/errors.js";
import { paramId } from "../lib/params.js";
import {
  clientMeta,
  requireAuth,
  requireScope,
} from "../middleware/auth.js";
import * as shareService from "../services/share-service.js";

export const sharesRouter = Router();
sharesRouter.use(requireAuth);

sharesRouter.get(
  "/",
  requireScope(ApiScope.ARTIFACTS_READ),
  async (_req, res) => {
    try {
      res.json({ items: await shareService.listShares() });
    } catch (err) {
      sendError(res, err);
    }
  },
);

sharesRouter.delete(
  "/:id",
  requireScope(ApiScope.SHARES_WRITE),
  async (req, res) => {
    try {
      await shareService.revokeShare(
        paramId(req),
        req.user!.id,
        clientMeta(req),
      );
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  },
);

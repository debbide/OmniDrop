import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import { ensureDatabase } from "@omnidrop/db";
import { appConfig, resolveDataPath } from "./config.js";
import { logger } from "./logger.js";
import { AppError, sendError } from "./lib/errors.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { authRouter } from "./routes/auth.js";
import { targetsRouter } from "./routes/targets.js";
import { jobsRouter } from "./routes/jobs.js";
import { healthRouter } from "./routes/health.js";
import { settingsRouter } from "./routes/settings.js";
import { artifactsRouter } from "./routes/artifacts.js";
import { sharesRouter } from "./routes/shares.js";
import { publicSharesRouter } from "./routes/public-shares.js";
import { ensureArtifactsDir } from "./services/artifact-service.js";

const databasePath = resolveDataPath(appConfig.DATABASE_PATH);
const tmpDir = resolveDataPath(appConfig.TMP_DIR);
const artifactsDir = resolveDataPath(appConfig.ARTIFACTS_DIR);

fs.mkdirSync(tmpDir, { recursive: true });
fs.mkdirSync(artifactsDir, { recursive: true });
await ensureDatabase(databasePath);
await ensureArtifactsDir();
logger.info({ databasePath, tmpDir, artifactsDir }, "Database ready");

const app = express();
app.set("trust proxy", 1);

app.use(securityHeaders);
app.use(
  cors({
    origin: appConfig.APP_BASE_URL,
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser(appConfig.SESSION_SECRET));

app.use("/api/v1/health", healthRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/targets", targetsRouter);
app.use("/api/v1/jobs", jobsRouter);
app.use("/api/v1/settings", settingsRouter);
app.use("/api/v1/artifacts", artifactsRouter);
app.use("/api/v1/shares", sharesRouter);
app.use("/api/v1/public/shares", publicSharesRouter);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (
      err &&
      typeof err === "object" &&
      "name" in err &&
      (err as { name: string }).name === "ZodError"
    ) {
      sendError(
        res,
        new AppError(400, "VALIDATION_ERROR", "Invalid request", err),
      );
      return;
    }
    sendError(res, err);
  },
);

const server = app.listen(appConfig.API_PORT, () => {
  logger.info(
    { port: appConfig.API_PORT, env: appConfig.NODE_ENV },
    "OmniDrop API listening",
  );
});

async function shutdown() {
  logger.info("Shutting down API");
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection");
});

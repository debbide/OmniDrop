import pino from "pino";
import { workerConfig } from "./config.js";

export const logger = pino({
  level: workerConfig.LOG_LEVEL,
  transport:
    workerConfig.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

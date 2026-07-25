import { config as loadEnv } from "dotenv";
import path from "node:path";
import { requireDataKey } from "@omnidrop/crypto";
import { z } from "zod";

loadEnv({ path: path.resolve(process.cwd(), "../../.env") });
loadEnv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  API_PORT: z.coerce.number().default(3000),
  APP_BASE_URL: z.string().default("http://localhost:5173"),
  DATABASE_PATH: z.string().default("./data/db/omnidrop.sqlite"),
  TMP_DIR: z.string().default("./data/tmp"),
  ARTIFACTS_DIR: z.string().default("./data/artifacts"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  SESSION_SECRET: z.string().min(8),
  OMNIDROP_DATA_KEY: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  MAX_DOWNLOAD_CONCURRENCY: z.coerce.number().default(2),
  MAX_UPLOAD_CONCURRENCY: z.coerce.number().default(3),
  JOB_TMP_TTL_MINUTES: z.coerce.number().default(60),
  GITHUB_TOKEN: z.string().optional(),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  const dataKey = requireDataKey(parsed.data.OMNIDROP_DATA_KEY);
  return {
    ...parsed.data,
    OMNIDROP_DATA_KEY: dataKey,
    isProd: parsed.data.NODE_ENV === "production",
  };
}

export const appConfig = loadConfig();
export type AppConfig = typeof appConfig;

export function resolveDataPath(p: string): string {
  if (path.isAbsolute(p)) return p;
  const rootish = path.resolve(
    process.cwd(),
    process.cwd().endsWith("api") || process.cwd().endsWith("worker")
      ? "../.."
      : ".",
  );
  return path.resolve(rootish, p);
}

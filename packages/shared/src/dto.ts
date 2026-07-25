import { z } from "zod";
import {
  ALL_API_SCOPES,
  ApiScope,
  SHARE_TTL_PRESETS,
  SourceType,
  TargetType,
} from "./enums.js";

export const setupBodySchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(10).max(128),
});

export const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const sftpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  remotePath: z.string().min(1),
  authMethod: z.enum(["password", "privateKey"]).default("password"),
  /** accept-new: skip strict host key (default for self-host). strict: require knownHosts */
  hostKeyPolicy: z.enum(["accept-new", "strict"]).default("accept-new"),
  /** OpenSSH known_hosts content when hostKeyPolicy=strict */
  knownHosts: z.string().optional(),
  disableHashCheck: z.boolean().optional().default(true),
});

export const pteroConfigSchema = z.object({
  panelUrl: z.string().url(),
  serverId: z.string().min(1),
  remotePath: z.string().min(1),
  createDirs: z.boolean().default(true),
});

export const ftpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(21),
  username: z.string().min(1),
  remotePath: z.string().min(1),
  /** plain | explicit FTPS | implicit FTPS */
  secure: z.enum(["plain", "explicit", "implicit"]).default("plain"),
  insecureTls: z.boolean().optional().default(false),
  passive: z.boolean().optional().default(true),
  concurrency: z.number().int().min(1).max(10).optional(),
});

export const webdavConfigSchema = z.object({
  url: z.string().url(),
  username: z.string().optional().default(""),
  remotePath: z.string().min(1),
  /** other | nextcloud | owncloud | sharepoint */
  vendor: z
    .enum(["other", "nextcloud", "owncloud", "sharepoint"])
    .optional()
    .default("other"),
  authType: z.enum(["basic", "bearer"]).optional().default("basic"),
  insecureTls: z.boolean().optional().default(false),
});

export const createTargetBodySchema = z.discriminatedUnion("type", [
  z.object({
    name: z.string().min(1).max(128),
    type: z.literal(TargetType.SFTP),
    enabled: z.boolean().optional().default(true),
    config: sftpConfigSchema,
    secret: z.object({
      password: z.string().optional(),
      privateKey: z.string().optional(),
      passphrase: z.string().optional(),
    }),
  }),
  z.object({
    name: z.string().min(1).max(128),
    type: z.literal(TargetType.PTERODACTYL),
    enabled: z.boolean().optional().default(true),
    config: pteroConfigSchema,
    secret: z.object({
      apiKey: z.string().min(1),
    }),
  }),
  z.object({
    name: z.string().min(1).max(128),
    type: z.literal(TargetType.FTP),
    enabled: z.boolean().optional().default(true),
    config: ftpConfigSchema,
    secret: z.object({
      password: z.string().min(1),
    }),
  }),
  z.object({
    name: z.string().min(1).max(128),
    type: z.literal(TargetType.WEBDAV),
    enabled: z.boolean().optional().default(true),
    config: webdavConfigSchema,
    secret: z.object({
      password: z.string().optional(),
      bearerToken: z.string().optional(),
    }),
  }),
]);

export const updateTargetBodySchema = z.object({
  name: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  secret: z
    .object({
      password: z.string().optional(),
      privateKey: z.string().optional(),
      passphrase: z.string().optional(),
      apiKey: z.string().optional(),
      bearerToken: z.string().optional(),
    })
    .optional(),
});

export const previewGithubReleaseBodySchema = z.object({
  repoUrl: z.string().min(1),
  tag: z.string().optional(),
});

export type PreviewGithubReleaseBody = z.infer<
  typeof previewGithubReleaseBodySchema
>;

export const createJobBodySchema = z.object({
  name: z.string().max(256).optional(),
  sourceType: z.enum([
    SourceType.HTTP,
    SourceType.GITHUB_RELEASE,
    SourceType.ARTIFACT,
  ]),
  sourceUrl: z.string().optional(),
  artifactId: z.string().optional(),
  sourceMeta: z
    .object({
      tag: z.string().optional(),
      assetName: z.string().optional(),
      /** GitHub asset id — preferred for private repos */
      assetId: z.number().int().positive().optional(),
    })
    .optional(),
  /** Optional for HTTP/GitHub: empty = download into library only, no upload */
  targetIds: z.array(z.string().min(1)).optional().default([]),
  options: z
    .object({
      overwrite: z.boolean().optional().default(true),
      retries: z.number().int().min(0).max(10).optional().default(2),
      expectedSha256: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .optional()
        .nullable(),
    })
    .optional()
    .default({}),
}).superRefine((val, ctx) => {
  if (val.sourceType === SourceType.ARTIFACT) {
    if (!val.artifactId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "artifactId is required for artifact source",
        path: ["artifactId"],
      });
    }
    if (!val.targetIds?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "targetIds is required when uploading from artifact library",
        path: ["targetIds"],
      });
    }
  } else if (!val.sourceUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sourceUrl is required",
      path: ["sourceUrl"],
    });
  }
});

export const settingsBodySchema = z.object({
  maxDownloadConcurrency: z.number().int().min(1).max(20).optional(),
  maxUploadConcurrency: z.number().int().min(1).max(20).optional(),
  jobTmpTtlMinutes: z.number().int().min(5).max(7 * 24 * 60).optional(),
  githubToken: z.string().optional().nullable(),
});

export const renameArtifactBodySchema = z
  .object({
    fileName: z.string().min(1).max(200).optional(),
    /** Free-form note (empty string clears). */
    note: z.string().max(500).optional().nullable(),
  })
  .refine((v) => v.fileName !== undefined || v.note !== undefined, {
    message: "fileName or note is required",
  });

export const dispatchArtifactBodySchema = z.object({
  targetIds: z.array(z.string().min(1)).min(1),
  /** Optional remote directory (jailed under target remotePath). Defaults to target root. */
  destPath: z.string().optional(),
  options: z
    .object({
      overwrite: z.boolean().optional().default(true),
      retries: z.number().int().min(0).max(10).optional().default(2),
      /** Remote upload directory override (same as destPath, stored on job) */
      destPath: z.string().optional(),
    })
    .optional()
    .default({}),
});

export const createShareBodySchema = z.object({
  ttlPreset: z
    .enum(["1h", "24h", "7d", "30d", "custom"] as const)
    .default("24h"),
  ttlSeconds: z.number().int().min(60).max(365 * 86400).optional(),
  maxDownloads: z.number().int().min(1).max(1_000_000).optional().nullable(),
}).superRefine((val, ctx) => {
  if (val.ttlPreset === "custom" && !val.ttlSeconds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "ttlSeconds required for custom preset",
      path: ["ttlSeconds"],
    });
  }
});

export const createApiTokenBodySchema = z.object({
  name: z.string().min(1).max(128),
  scopes: z
    .array(z.enum([ApiScope.STAR, ...ALL_API_SCOPES] as [string, ...string[]]))
    .min(1)
    .default([ApiScope.JOBS_WRITE, ApiScope.ARTIFACTS_READ]),
  expiresInDays: z.number().int().min(1).max(3650).optional().nullable(),
});

export const remoteMkdirBodySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
});

export const remoteRenameBodySchema = z.object({
  path: z.string().min(1),
  newName: z.string().min(1).max(200),
});

export const remoteDeleteBodySchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(100),
  recursive: z.boolean().optional().default(true),
});

export const remoteDownloadBodySchema = z.object({
  path: z.string().min(1),
});

export const remoteUploadFromArtifactBodySchema = z.object({
  artifactId: z.string().min(1),
  destPath: z.string().optional(),
  overwrite: z.boolean().optional().default(true),
});

export type RemoteMkdirBody = z.infer<typeof remoteMkdirBodySchema>;
export type RemoteRenameBody = z.infer<typeof remoteRenameBodySchema>;
export type RemoteDeleteBody = z.infer<typeof remoteDeleteBodySchema>;
export type RemoteDownloadBody = z.infer<typeof remoteDownloadBodySchema>;
export type RemoteUploadFromArtifactBody = z.infer<
  typeof remoteUploadFromArtifactBodySchema
>;

export function resolveShareTtlSeconds(
  preset: string,
  custom?: number,
): number {
  if (preset === "custom") {
    if (!custom) throw new Error("custom ttl required");
    return custom;
  }
  const v = SHARE_TTL_PRESETS[preset as keyof typeof SHARE_TTL_PRESETS];
  if (!v) throw new Error("invalid ttl preset");
  return v;
}

export type SetupBody = z.infer<typeof setupBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type CreateTargetBody = z.infer<typeof createTargetBodySchema>;
export type UpdateTargetBody = z.infer<typeof updateTargetBodySchema>;
export type CreateJobBody = z.infer<typeof createJobBodySchema>;
export type SettingsBody = z.infer<typeof settingsBodySchema>;
export type SftpConfig = z.infer<typeof sftpConfigSchema>;
export type PteroConfig = z.infer<typeof pteroConfigSchema>;
export type FtpConfig = z.infer<typeof ftpConfigSchema>;
export type WebdavConfig = z.infer<typeof webdavConfigSchema>;
export type RenameArtifactBody = z.infer<typeof renameArtifactBodySchema>;
export type DispatchArtifactBody = z.infer<typeof dispatchArtifactBodySchema>;
export type CreateShareBody = z.infer<typeof createShareBodySchema>;
export type CreateApiTokenBody = z.infer<typeof createApiTokenBodySchema>;

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

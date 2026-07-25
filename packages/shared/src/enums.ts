export const TargetType = {
  SFTP: "sftp",
  PTERODACTYL: "pterodactyl",
  FTP: "ftp",
  WEBDAV: "webdav",
} as const;
export type TargetType = (typeof TargetType)[keyof typeof TargetType];

export const CredentialType = {
  SFTP_PASSWORD: "sftp_password",
  SFTP_KEY: "sftp_key",
  PTERO_CLIENT_KEY: "ptero_client_key",
  FTP_PASSWORD: "ftp_password",
  WEBDAV_PASSWORD: "webdav_password",
  GITHUB_TOKEN: "github_token",
} as const;
export type CredentialType = (typeof CredentialType)[keyof typeof CredentialType];

export const SourceType = {
  HTTP: "http",
  GITHUB_RELEASE: "github_release",
  ARTIFACT: "artifact",
} as const;
export type SourceType = (typeof SourceType)[keyof typeof SourceType];

export const JobStatus = {
  QUEUED: "queued",
  DOWNLOADING: "downloading",
  READY: "ready",
  UPLOADING: "uploading",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELED: "canceled",
  PARTIAL: "partial",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const JobTargetStatus = {
  PENDING: "pending",
  UPLOADING: "uploading",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  SKIPPED: "skipped",
  CANCELED: "canceled",
} as const;
export type JobTargetStatus = (typeof JobTargetStatus)[keyof typeof JobTargetStatus];

export const StepName = {
  VALIDATE: "validate",
  DOWNLOAD: "download",
  CHECKSUM: "checksum",
  UPLOAD: "upload",
  CLEANUP: "cleanup",
} as const;
export type StepName = (typeof StepName)[keyof typeof StepName];

export const StepStatus = {
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;
export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

export const TERMINAL_JOB_STATUSES: JobStatus[] = [
  JobStatus.SUCCEEDED,
  JobStatus.FAILED,
  JobStatus.CANCELED,
  JobStatus.PARTIAL,
];

export const QUEUE_NAMES = {
  DOWNLOAD: "jobs-download",
  UPLOAD: "jobs-upload",
  CLEANUP: "jobs-cleanup",
  TARGET_TEST: "targets-test",
  FS_DOWNLOAD: "targets-fs-download",
  FS_UPLOAD: "targets-fs-upload",
} as const;

export const REDIS_KEYS = {
  jobProgress: (jobId: string) => `job:${jobId}:progress`,
  jobEvents: (jobId: string) => `job:${jobId}:events`,
  jobCancel: (jobId: string) => `job:${jobId}:cancel`,
  loginFail: (key: string) => `login:fail:${key}`,
  shareDownload: (ip: string) => `share:dl:${ip}`,
} as const;

export const ApiScope = {
  STAR: "*",
  JOBS_READ: "jobs:read",
  JOBS_WRITE: "jobs:write",
  ARTIFACTS_READ: "artifacts:read",
  ARTIFACTS_WRITE: "artifacts:write",
  TARGETS_READ: "targets:read",
  TARGETS_WRITE: "targets:write",
  SHARES_WRITE: "shares:write",
  SETTINGS_READ: "settings:read",
  SETTINGS_WRITE: "settings:write",
} as const;
export type ApiScope = (typeof ApiScope)[keyof typeof ApiScope];

export const ALL_API_SCOPES: ApiScope[] = [
  ApiScope.JOBS_READ,
  ApiScope.JOBS_WRITE,
  ApiScope.ARTIFACTS_READ,
  ApiScope.ARTIFACTS_WRITE,
  ApiScope.TARGETS_READ,
  ApiScope.TARGETS_WRITE,
  ApiScope.SHARES_WRITE,
  ApiScope.SETTINGS_READ,
  ApiScope.SETTINGS_WRITE,
];

/** Share TTL presets in seconds */
export const SHARE_TTL_PRESETS = {
  "1h": 3600,
  "24h": 86400,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
} as const;
export type ShareTtlPreset = keyof typeof SHARE_TTL_PRESETS;

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

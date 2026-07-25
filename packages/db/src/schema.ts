import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    lastSeenAt: integer("last_seen_at", { mode: "number" }),
    revokedAt: integer("revoked_at", { mode: "number" }),
  },
  (t) => [
    index("idx_sessions_token").on(t.tokenHash),
    index("idx_sessions_user").on(t.userId),
  ],
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at", { mode: "number" }),
    lastUsedAt: integer("last_used_at", { mode: "number" }),
    revokedAt: integer("revoked_at", { mode: "number" }),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("idx_api_tokens_hash").on(t.tokenHash),
    index("idx_api_tokens_user").on(t.userId),
  ],
);

export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  type: text("type").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const targets = sqliteTable(
  "targets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    configJson: text("config_json").notNull(),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("idx_targets_name").on(t.name)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    fileName: text("file_name").notNull(),
    storageName: text("storage_name").notNull(),
    sizeBytes: integer("size_bytes", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    contentType: text("content_type"),
    sourceType: text("source_type"),
    sourceUrl: text("source_url"),
    sourceJobId: text("source_job_id"),
    /** Free-form note, e.g. which target server the file came from */
    note: text("note"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_artifacts_created").on(t.createdAt),
    index("idx_artifacts_checksum").on(t.checksumSha256),
    index("idx_artifacts_name").on(t.fileName),
  ],
);

export const shareLinks = sqliteTable(
  "share_links",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    maxDownloads: integer("max_downloads", { mode: "number" }),
    downloadCount: integer("download_count", { mode: "number" })
      .notNull()
      .default(0),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "number" }),
    lastDownloadAt: integer("last_download_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("idx_share_links_hash").on(t.tokenHash),
    index("idx_share_links_artifact").on(t.artifactId),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id"),
    actorType: text("actor_type").notNull(),
    actorTokenId: text("actor_token_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metaJson: text("meta_json"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_audit_created").on(t.createdAt)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    sourceType: text("source_type").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceMetaJson: text("source_meta_json"),
    status: text("status").notNull(),
    checksumSha256: text("checksum_sha256"),
    bytesTotal: integer("bytes_total", { mode: "number" }),
    bytesDone: integer("bytes_done", { mode: "number" }).notNull().default(0),
    errorMessage: text("error_message"),
    tempPath: text("temp_path"),
    fileName: text("file_name"),
    artifactId: text("artifact_id"),
    optionsJson: text("options_json"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    startedAt: integer("started_at", { mode: "number" }),
    finishedAt: integer("finished_at", { mode: "number" }),
  },
  (t) => [index("idx_jobs_status_created").on(t.status, t.createdAt)],
);

export const jobTargets = sqliteTable(
  "job_targets",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id),
    status: text("status").notNull(),
    bytesTotal: integer("bytes_total", { mode: "number" }),
    bytesDone: integer("bytes_done", { mode: "number" }).notNull().default(0),
    remoteFinalPath: text("remote_final_path"),
    errorMessage: text("error_message"),
    attempts: integer("attempts", { mode: "number" }).notNull().default(0),
    startedAt: integer("started_at", { mode: "number" }),
    finishedAt: integer("finished_at", { mode: "number" }),
  },
  (t) => [
    index("idx_job_targets_job").on(t.jobId),
    uniqueIndex("idx_job_targets_unique").on(t.jobId, t.targetId),
  ],
);

export const jobSteps = sqliteTable(
  "job_steps",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    jobTargetId: text("job_target_id").references(() => jobTargets.id, {
      onDelete: "cascade",
    }),
    step: text("step").notNull(),
    status: text("status").notNull(),
    progressPct: integer("progress_pct", { mode: "number" }).notNull().default(0),
    detail: text("detail"),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_job_steps_job").on(t.jobId)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull().default(sql`'{}'`),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type Credential = typeof credentials.$inferSelect;
export type Target = typeof targets.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type ShareLink = typeof shareLinks.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type JobTarget = typeof jobTargets.$inferSelect;
export type JobStep = typeof jobSteps.$inferSelect;

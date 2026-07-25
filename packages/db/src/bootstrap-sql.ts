/** Full schema for fresh installs. */
export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_name ON targets(name);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  file_name TEXT NOT NULL,
  storage_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  content_type TEXT,
  source_type TEXT,
  source_url TEXT,
  source_job_id TEXT,
  note TEXT,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_checksum ON artifacts(checksum_sha256);
CREATE INDEX IF NOT EXISTS idx_artifacts_name ON artifacts(file_name);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_download_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_links_hash ON share_links(token_hash);
CREATE INDEX IF NOT EXISTS idx_share_links_artifact ON share_links(artifact_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT,
  actor_type TEXT NOT NULL,
  actor_token_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip TEXT,
  user_agent TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_meta_json TEXT,
  status TEXT NOT NULL,
  checksum_sha256 TEXT,
  bytes_total INTEGER,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  temp_path TEXT,
  file_name TEXT,
  artifact_id TEXT,
  options_json TEXT,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS job_targets (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id),
  status TEXT NOT NULL,
  bytes_total INTEGER,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  remote_final_path TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_job_targets_job ON job_targets(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_targets_unique ON job_targets(job_id, target_id);

CREATE TABLE IF NOT EXISTS job_steps (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  job_target_id TEXT REFERENCES job_targets(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  progress_pct INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_steps_job ON job_steps(job_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL DEFAULT '{}'
);
`;

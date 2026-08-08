CREATE TABLE IF NOT EXISTS vault_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  master_password_hash TEXT,
  kdf_salt TEXT,
  enc_id TEXT,
  s3_secret_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS secret_rotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  secret_key TEXT NOT NULL,
  action TEXT NOT NULL,
  rotated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_secret_rotations_key ON secret_rotations(secret_key, rotated_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at ON audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);

CREATE TABLE IF NOT EXISTS dump_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relative_path TEXT NOT NULL UNIQUE,
  item_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  enc_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dump_files_item_key ON dump_files(item_key);
CREATE INDEX IF NOT EXISTS idx_dump_files_sha256 ON dump_files(sha256);
CREATE INDEX IF NOT EXISTS idx_dump_files_created_at ON dump_files(created_at DESC);

CREATE TABLE IF NOT EXISTS restore_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dump_id INTEGER,
  dump_relative_path TEXT NOT NULL,
  dump_sha256 TEXT NOT NULL DEFAULT '',
  destination_key TEXT NOT NULL,
  restored_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  clean_restore INTEGER NOT NULL DEFAULT 0,
  warnings TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (dump_id) REFERENCES dump_files(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_restore_history_restored_at ON restore_history(restored_at DESC);
CREATE INDEX IF NOT EXISTS idx_restore_history_destination ON restore_history(destination_key);

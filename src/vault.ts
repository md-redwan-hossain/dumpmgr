import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  decryptSecret,
  deriveAesKey,
  encryptSecret,
  hashMasterPassword,
  verifyMasterPassword,
} from "./crypto.ts";
import { dumpEncIdFromName, isEncryptedDumpName } from "./dumps.ts";

export const SCHEMA_VERSION = 1;

export const Action = {
  Dump: "dump",
  Restore: "restore",
  Sync: "sync",
  S3Upload: "s3_upload",
  S3Download: "s3_download",
  SecretWipe: "secret_wipe",
  MasterChange: "master_change",
  ConfigInit: "config_init",
  DumpScan: "dump_scan",
  DumpVerify: "dump_verify",
} as const;

export const Status = {
  Success: "success",
  Failure: "failure",
  Cancelled: "cancelled",
} as const;

export const Rotation = {
  Created: "created",
  Updated: "updated",
  Wiped: "wiped",
  MasterReencrypt: "master_reencrypt",
} as const;

const SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

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
`;

const LEGACY_MAGIC = new TextEncoder().encode("DBSM");

export type SecretInfo = {
  key: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
};

export type SecretRotation = {
  id: number;
  secretKey: string;
  action: string;
  rotatedAt: Date;
};

export type AuditEntry = {
  id: number;
  occurredAt: Date;
  action: string;
  status: string;
  subject: string;
  destination: string;
  details: string;
  errorMessage: string;
};

export type DumpRecord = {
  id: number;
  relativePath: string;
  itemKey: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  encrypted: boolean;
  encId: string;
  createdAt: Date;
};

export type RestoreRecord = {
  id: number;
  dumpId: number | null;
  dumpRelativePath: string;
  dumpSha256: string;
  destinationKey: string;
  restoredAt: Date;
  durationMs: number;
  status: string;
  cleanRestore: boolean;
  warnings: string;
  errorMessage: string;
};

export type VaultStatus = {
  dbPath: string;
  schemaVersion: number;
  hasMaster: boolean;
  encId: string;
  secretCount: number;
  dumpCount: number;
  auditCount: number;
  restoreCount: number;
};

export type Session = {
  db: Database;
  dbPath: string;
  masterPassword: string;
  aesKey: CryptoKey;
};

type LegacyMetadata = {
  masterPassword?: string | null;
  kdfSalt?: string | null;
  dbPasswords?: Record<string, string>;
  encId?: string | null;
  s3SecretKey?: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

type SqlBind = string | number | bigint | boolean | Uint8Array | null;

function dbRun(db: Database, sql: string, params: SqlBind[]): void {
  db.run(sql, params);
}

function dbGet<T>(db: Database, sql: string, params: SqlBind[] = []): T | null {
  return db.query(sql).get(...params) as T | null;
}

function dbAll<T>(db: Database, sql: string, params: SqlBind[] = []): T[] {
  return db.query(sql).all(...params) as T[];
}

function parseTime(s: string): Date {
  return new Date(s);
}

export function dbPathForConfig(configPath: string): string {
  return join(dirname(resolve(configPath)), "vault.db");
}

export function legacyPathForConfig(configPath: string): string {
  return join(dirname(resolve(configPath)), "metadata");
}

export function newEncId(): string {
  return crypto.randomUUID().replaceAll("-", "").toUpperCase();
}

export async function sha256File(path: string): Promise<{ hash: string; size: number }> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    let size = 0;
    stream.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      hash.update(buf);
    });
    stream.on("error", reject);
    stream.on("end", () => resolvePromise({ hash: hash.digest("hex"), size }));
  });
}

function decodeLegacyBinary(buf: Uint8Array): LegacyMetadata {
  for (let i = 0; i < LEGACY_MAGIC.length; i++) {
    if (buf[i] !== LEGACY_MAGIC[i]) throw new Error("invalid legacy metadata (bad magic)");
  }
  const json = gunzipSync(buf.subarray(LEGACY_MAGIC.length + 1));
  return JSON.parse(new TextDecoder().decode(json)) as LegacyMetadata;
}

async function loadLegacyMetadata(configPath: string): Promise<{ meta: LegacyMetadata; src: string } | null> {
  const dir = dirname(resolve(configPath));
  const binaryPath = join(dir, "metadata");
  if (await Bun.file(binaryPath).exists()) {
    const buf = new Uint8Array(await Bun.file(binaryPath).arrayBuffer());
    return { meta: decodeLegacyBinary(buf), src: binaryPath };
  }
  const jsonPath = join(dir, "metadata.json");
  if (await Bun.file(jsonPath).exists()) {
    return { meta: (await Bun.file(jsonPath).json()) as LegacyMetadata, src: jsonPath };
  }
  return null;
}

async function migrateLegacyIfNeeded(configPath: string, vaultPath: string): Promise<void> {
  if (await Bun.file(vaultPath).exists()) return;
  const legacy = await loadLegacyMetadata(configPath);
  if (!legacy) return;
  const db = await openVaultDb(vaultPath);
  try {
    const meta = legacy.meta;
    const id = meta.encId || newEncId();
    dbRun(db, `UPDATE vault_meta SET master_password_hash = ?, kdf_salt = ?, enc_id = ?, s3_secret_key = ?, updated_at = ? WHERE id = 1`, [
      meta.masterPassword ?? null,
      meta.kdfSalt ?? null,
      id,
      meta.s3SecretKey ?? null,
      nowIso(),
    ]);
    for (const [key, cipher] of Object.entries(meta.dbPasswords ?? {})) {
      upsertSecret(db, key, cipher, Rotation.Created);
    }
    recordAudit(db, Action.ConfigInit, Status.Success, "legacy_migration", "", `migrated from ${basename(legacy.src)}`, "");
    await rename(legacy.src, `${legacy.src}.bak`);
  } finally {
    db.close();
  }
}

async function openVaultDb(path: string): Promise<Database> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_DDL);
  const row = dbGet(db, "SELECT 1 FROM vault_meta WHERE id = 1");
  if (!row) {
    const t = nowIso();
    dbRun(db, "INSERT INTO vault_meta (id, created_at, updated_at) VALUES (1, ?, ?)", [t, t]);
  }
  return db;
}

export async function openVault(configPath: string): Promise<Database> {
  const vaultPath = dbPathForConfig(configPath);
  await migrateLegacyIfNeeded(configPath, vaultPath);
  return await openVaultDb(vaultPath);
}

export function hasMaster(db: Database): boolean {
  const row = dbGet<{ master_password_hash: string | null; kdf_salt: string | null }>(
    db,
    "SELECT master_password_hash, kdf_salt FROM vault_meta WHERE id = 1",
  );
  return Boolean(row?.master_password_hash && row?.kdf_salt);
}

export function getEncId(db: Database): string {
  const row = dbGet<{ enc_id: string | null }>(db, "SELECT enc_id FROM vault_meta WHERE id = 1");
  return row?.enc_id ?? "";
}

export async function unlockSession(configPath: string, masterPassword: string): Promise<Session> {
  const dbPath = dbPathForConfig(configPath);
  const db = await openVault(configPath);
  if (!hasMaster(db)) {
    db.close();
    throw new Error("vault has no master password; run config init again");
  }
  const row = dbGet<{
    master_password_hash: string;
    kdf_salt: string;
    enc_id: string | null;
  }>(db, "SELECT master_password_hash, kdf_salt, enc_id FROM vault_meta WHERE id = 1");
  if (!row) {
    db.close();
    throw new Error("vault meta row missing");
  }
  if (!row.enc_id) {
    dbRun(db, "UPDATE vault_meta SET enc_id = ?, updated_at = ? WHERE id = 1", [newEncId(), nowIso()]);
  }
  const ok = await verifyMasterPassword(masterPassword, row.master_password_hash);
  if (!ok) {
    db.close();
    throw new Error("incorrect master password");
  }
  const aesKey = await deriveAesKey(masterPassword, row.kdf_salt);
  return { db, dbPath, masterPassword, aesKey };
}

export async function createVaultWithMaster(configPath: string, masterPassword: string): Promise<Session> {
  const db = await openVault(configPath);
  const hash = await hashMasterPassword(masterPassword);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = Buffer.from(salt).toString("base64");
  const id = newEncId();
  const t = nowIso();
  dbRun(db, `UPDATE vault_meta SET master_password_hash = ?, kdf_salt = ?, enc_id = ?, updated_at = ? WHERE id = 1`, [
    hash,
    saltB64,
    id,
    t,
  ]);
  const aesKey = await deriveAesKey(masterPassword, saltB64);
  return { db, dbPath: dbPathForConfig(configPath), masterPassword, aesKey };
}

function upsertSecret(db: Database, key: string, ciphertext: string, rotationAction: string): void {
  const t = nowIso();
  const exists = dbGet(db, "SELECT 1 FROM secrets WHERE key = ?", [key]);
  if (exists) {
    dbRun(db, "UPDATE secrets SET ciphertext = ?, updated_at = ? WHERE key = ?", [ciphertext, t, key]);
    dbRun(db, "INSERT INTO secret_rotations (secret_key, action, rotated_at) VALUES (?, ?, ?)", [
      key,
      rotationAction || Rotation.Updated,
      t,
    ]);
  } else {
    dbRun(db, "INSERT INTO secrets (key, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?)", [
      key,
      ciphertext,
      t,
      t,
    ]);
    dbRun(db, "INSERT INTO secret_rotations (secret_key, action, rotated_at) VALUES (?, ?, ?)", [
      key,
      rotationAction || Rotation.Created,
      t,
    ]);
  }
  dbRun(db, "UPDATE vault_meta SET updated_at = ? WHERE id = 1", [t]);
}

export async function getDbPassword(session: Session, key: string): Promise<string | null> {
  const row = dbGet<{ ciphertext: string }>(session.db, "SELECT ciphertext FROM secrets WHERE key = ?", [key]);
  if (!row) return null;
  const pw = await decryptSecret(session.aesKey, row.ciphertext);
  dbRun(session.db, "UPDATE secrets SET last_used_at = ? WHERE key = ?", [nowIso(), key]);
  return pw;
}

export async function setDbPassword(session: Session, key: string, password: string): Promise<void> {
  const enc = await encryptSecret(session.aesKey, password);
  upsertSecret(session.db, key, enc, "");
}

export async function getS3SecretKey(session: Session): Promise<string | null> {
  const row = dbGet<{ s3_secret_key: string | null }>(
    session.db,
    "SELECT s3_secret_key FROM vault_meta WHERE id = 1",
  );
  if (!row?.s3_secret_key) return null;
  return decryptSecret(session.aesKey, row.s3_secret_key);
}

export async function setS3SecretKey(session: Session, secretKey: string): Promise<void> {
  const enc = await encryptSecret(session.aesKey, secretKey);
  dbRun(session.db, "UPDATE vault_meta SET s3_secret_key = ?, updated_at = ? WHERE id = 1", [enc, nowIso()]);
}

export function deleteDbPassword(session: Session, key: string): boolean {
  const exists = dbGet(session.db, "SELECT 1 FROM secrets WHERE key = ?", [key]);
  if (!exists) return false;
  const t = nowIso();
  dbRun(session.db, "DELETE FROM secrets WHERE key = ?", [key]);
  dbRun(session.db, "INSERT INTO secret_rotations (secret_key, action, rotated_at) VALUES (?, ?, ?)", [
    key,
    Rotation.Wiped,
    t,
  ]);
  dbRun(session.db, "UPDATE vault_meta SET updated_at = ? WHERE id = 1", [t]);
  return true;
}

export async function changeMasterPassword(session: Session, newMaster: string): Promise<Session> {
  const secrets = listSecrets(session.db);
  const plain: Record<string, string> = {};
  for (const s of secrets) {
    const row = dbGet<{ ciphertext: string }>(
      session.db,
      "SELECT ciphertext FROM secrets WHERE key = ?",
      [s.key],
    );
    if (!row) continue;
    plain[s.key] = await decryptSecret(session.aesKey, row.ciphertext);
  }
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = Buffer.from(saltBytes).toString("base64");
  const newKey = await deriveAesKey(newMaster, saltB64);
  const hash = await hashMasterPassword(newMaster);
  const eid = getEncId(session.db) || newEncId();
  const s3 = await getS3SecretKey(session);
  const s3Enc = s3 ? await encryptSecret(newKey, s3) : null;
  dbRun(session.db, `UPDATE vault_meta SET master_password_hash = ?, kdf_salt = ?, enc_id = ?, s3_secret_key = ?, updated_at = ? WHERE id = 1`, [
    hash,
    saltB64,
    eid,
    s3Enc,
    nowIso(),
  ]);
  for (const [key, pw] of Object.entries(plain)) {
    const enc = await encryptSecret(newKey, pw);
    upsertSecret(session.db, key, enc, Rotation.MasterReencrypt);
  }
  recordAudit(session.db, Action.MasterChange, Status.Success, "", "", "master password changed", "");
  return { ...session, masterPassword: newMaster, aesKey: newKey };
}

export function listSecrets(db: Database): SecretInfo[] {
  const rows = dbAll<{
    key: string;
    created_at: string;
    updated_at: string;
    last_used_at: string | null;
  }>(db, "SELECT key, created_at, updated_at, last_used_at FROM secrets ORDER BY key");
  return rows.map((r) => ({
    key: r.key,
    createdAt: parseTime(r.created_at),
    updatedAt: parseTime(r.updated_at),
    lastUsedAt: r.last_used_at ? parseTime(r.last_used_at) : null,
  }));
}

export function listSecretRotations(db: Database, key: string, limit = 50): SecretRotation[] {
  const rows = dbAll<{ id: number; secret_key: string; action: string; rotated_at: string }>(
    db,
    "SELECT id, secret_key, action, rotated_at FROM secret_rotations WHERE secret_key = ? ORDER BY rotated_at DESC LIMIT ?",
    [key, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    secretKey: r.secret_key,
    action: r.action,
    rotatedAt: parseTime(r.rotated_at),
  }));
}

export function recordAudit(
  db: Database,
  action: string,
  status: string,
  subject: string,
  destination: string,
  details: string,
  errorMessage: string,
): void {
  dbRun(db, `INSERT INTO audit_log (occurred_at, action, status, subject, destination, details, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    nowIso(),
    action,
    status,
    subject,
    destination,
    details,
    errorMessage,
  ]);
}

export function listAudit(db: Database, actionFilter: string, limit = 50): AuditEntry[] {
  const lim = limit > 0 ? limit : 50;
  type AuditRow = {
    id: number;
    occurred_at: string;
    action: string;
    status: string;
    subject: string;
    destination: string;
    details: string;
    error_message: string;
  };
  const rows = actionFilter
    ? dbAll<AuditRow>(
        db,
        `SELECT id, occurred_at, action, status, subject, destination, details, error_message
           FROM audit_log WHERE action = ? ORDER BY occurred_at DESC LIMIT ?`,
        [actionFilter, lim],
      )
    : dbAll<AuditRow>(
        db,
        `SELECT id, occurred_at, action, status, subject, destination, details, error_message
           FROM audit_log ORDER BY occurred_at DESC LIMIT ?`,
        [lim],
      );
  return rows.map((r) => ({
    id: r.id,
    occurredAt: parseTime(r.occurred_at),
    action: r.action,
    status: r.status,
    subject: r.subject,
    destination: r.destination,
    details: r.details,
    errorMessage: r.error_message,
  }));
}

export function registerDump(
  db: Database,
  relativePath: string,
  itemKey: string,
  fileName: string,
  sha256: string,
  sizeBytes: number,
  encrypted: boolean,
  encId: string,
): number {
  const t = nowIso();
  const enc = encrypted ? 1 : 0;
  dbRun(
    db,
    `INSERT INTO dump_files (relative_path, item_key, file_name, sha256, size_bytes, encrypted, enc_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(relative_path) DO UPDATE SET
       sha256 = excluded.sha256,
       size_bytes = excluded.size_bytes,
       encrypted = excluded.encrypted,
       enc_id = excluded.enc_id`,
    [relativePath, itemKey, fileName, sha256, sizeBytes, enc, encId, t],
  );
  const row = dbGet<{ id: number }>(db, "SELECT id FROM dump_files WHERE relative_path = ?", [relativePath]);
  return row!.id;
}

export function getDumpByPath(db: Database, relativePath: string): DumpRecord | null {
  const row = dbGet<{
    id: number;
    relative_path: string;
    item_key: string;
    file_name: string;
    sha256: string;
    size_bytes: number;
    encrypted: number;
    enc_id: string;
    created_at: string;
  }>(
    db,
    `SELECT id, relative_path, item_key, file_name, sha256, size_bytes, encrypted, enc_id, created_at
       FROM dump_files WHERE relative_path = ?`,
    [relativePath],
  );
  if (!row) return null;
  return {
    id: row.id,
    relativePath: row.relative_path,
    itemKey: row.item_key,
    fileName: row.file_name,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    encrypted: row.encrypted === 1,
    encId: row.enc_id,
    createdAt: parseTime(row.created_at),
  };
}

export function listDumps(db: Database, itemKey: string, limit = 100): DumpRecord[] {
  const lim = limit > 0 ? limit : 100;
  type DumpRow = {
    id: number;
    relative_path: string;
    item_key: string;
    file_name: string;
    sha256: string;
    size_bytes: number;
    encrypted: number;
    enc_id: string;
    created_at: string;
  };
  const rows = itemKey
    ? dbAll<DumpRow>(
        db,
        `SELECT id, relative_path, item_key, file_name, sha256, size_bytes, encrypted, enc_id, created_at
           FROM dump_files WHERE item_key = ? ORDER BY created_at DESC LIMIT ?`,
        [itemKey, lim],
      )
    : dbAll<DumpRow>(
        db,
        `SELECT id, relative_path, item_key, file_name, sha256, size_bytes, encrypted, enc_id, created_at
           FROM dump_files ORDER BY created_at DESC LIMIT ?`,
        [lim],
      );
  return rows.map((r) => ({
    id: r.id,
    relativePath: r.relative_path,
    itemKey: r.item_key,
    fileName: r.file_name,
    sha256: r.sha256,
    sizeBytes: r.size_bytes,
    encrypted: r.encrypted === 1,
    encId: r.enc_id,
    createdAt: parseTime(r.created_at),
  }));
}

export function recordRestore(db: Database, rec: Omit<RestoreRecord, "id" | "restoredAt">): void {
  const clean = rec.cleanRestore ? 1 : 0;
  dbRun(
    db,
    `INSERT INTO restore_history (
       dump_id, dump_relative_path, dump_sha256, destination_key, restored_at,
       duration_ms, status, clean_restore, warnings, error_message
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rec.dumpId,
      rec.dumpRelativePath,
      rec.dumpSha256,
      rec.destinationKey,
      nowIso(),
      rec.durationMs,
      rec.status,
      clean,
      rec.warnings,
      rec.errorMessage,
    ],
  );
}

export function listRestoreHistory(
  db: Database,
  destinationKey: string,
  limit = 50,
): RestoreRecord[] {
  const lim = limit > 0 ? limit : 50;
  type RestoreRow = {
    id: number;
    dump_id: number | null;
    dump_relative_path: string;
    dump_sha256: string;
    destination_key: string;
    restored_at: string;
    duration_ms: number;
    status: string;
    clean_restore: number;
    warnings: string;
    error_message: string;
  };
  const rows = destinationKey
    ? dbAll<RestoreRow>(
        db,
        `SELECT id, dump_id, dump_relative_path, dump_sha256, destination_key, restored_at,
              duration_ms, status, clean_restore, warnings, error_message
           FROM restore_history WHERE destination_key = ? ORDER BY restored_at DESC LIMIT ?`,
        [destinationKey, lim],
      )
    : dbAll<RestoreRow>(
        db,
        `SELECT id, dump_id, dump_relative_path, dump_sha256, destination_key, restored_at,
              duration_ms, status, clean_restore, warnings, error_message
           FROM restore_history ORDER BY restored_at DESC LIMIT ?`,
        [lim],
      );
  return rows.map((r) => ({
    id: r.id,
    dumpId: r.dump_id,
    dumpRelativePath: r.dump_relative_path,
    dumpSha256: r.dump_sha256,
    destinationKey: r.destination_key,
    restoredAt: parseTime(r.restored_at),
    durationMs: r.duration_ms,
    status: r.status,
    cleanRestore: r.clean_restore === 1,
    warnings: r.warnings,
    errorMessage: r.error_message,
  }));
}

export function vaultStatus(db: Database, dbPath: string): VaultStatus {
  const secretRow = dbGet<{ n: number }>(db, "SELECT COUNT(*) AS n FROM secrets")!;
  const dumpRow = dbGet<{ n: number }>(db, "SELECT COUNT(*) AS n FROM dump_files")!;
  const auditRow = dbGet<{ n: number }>(db, "SELECT COUNT(*) AS n FROM audit_log")!;
  const restoreRow = dbGet<{ n: number }>(db, "SELECT COUNT(*) AS n FROM restore_history")!;
  return {
    dbPath,
    schemaVersion: SCHEMA_VERSION,
    hasMaster: hasMaster(db),
    encId: getEncId(db),
    secretCount: secretRow.n,
    dumpCount: dumpRow.n,
    auditCount: auditRow.n,
    restoreCount: restoreRow.n,
  };
}

export function relativeDumpPath(dumpsRoot: string, absPath: string): string {
  const root = resolve(dumpsRoot);
  const abs = resolve(absPath);
  const rel = relative(root, abs);
  if (rel.startsWith("..")) {
    throw new Error("dump path outside dumps root");
  }
  return rel.split("\\").join("/");
}

function dumpsItemKeyFromPath(rel: string): string {
  const parts = rel.split("/");
  if (parts.length < 2) {
    if (parts.length === 1) {
      const base = parts[0]!.replace(/\.dump(\.enc)?$/i, "");
      const idx = base.indexOf("_");
      if (idx > 0) {
        return base.slice(0, idx).replaceAll("__", ":");
      }
    }
    return "";
  }
  return parts.slice(0, -1).join(":").replaceAll("/", ":");
}

export async function scanDumpsRoot(db: Database, dumpsRoot: string): Promise<number> {
  let count = 0;
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const name = entry.name;
      if (!name.endsWith(".dump") && !name.endsWith(".dump.enc")) continue;
      const rel = relativeDumpPath(dumpsRoot, full);
      const { hash, size } = await sha256File(full);
      const itemKey = dumpsItemKeyFromPath(rel);
      const enc = isEncryptedDumpName(name);
      const encId = dumpEncIdFromName(name) ?? "";
      registerDump(db, rel, itemKey, name, hash, size, enc, encId);
      count++;
    }
  }
  await walk(dumpsRoot);
  return count;
}

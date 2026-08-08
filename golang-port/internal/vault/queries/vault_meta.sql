-- name: VaultMetaRowExists :one
SELECT CAST(COALESCE((SELECT 1 FROM vault_meta WHERE id = 1), 0) AS INTEGER) AS exists_flag;

-- name: InsertVaultMeta :exec
INSERT INTO vault_meta (id, created_at, updated_at) VALUES (1, ?, ?);

-- name: TouchVaultMeta :exec
UPDATE vault_meta SET updated_at = ? WHERE id = 1;

-- name: GetVaultMetaRow :one
SELECT master_password_hash, kdf_salt, enc_id, s3_secret_key
FROM vault_meta WHERE id = 1;

-- name: GetVaultMasterFields :one
SELECT master_password_hash, kdf_salt
FROM vault_meta WHERE id = 1;

-- name: GetVaultEncID :one
SELECT enc_id FROM vault_meta WHERE id = 1;

-- name: GetVaultCreatedAt :one
SELECT created_at FROM vault_meta WHERE id = 1;

-- name: SetVaultMeta :exec
UPDATE vault_meta
SET master_password_hash = ?, kdf_salt = ?, enc_id = ?, s3_secret_key = ?, updated_at = ?
WHERE id = 1;

-- name: SetVaultEncID :exec
UPDATE vault_meta SET enc_id = ?, updated_at = ? WHERE id = 1;

-- name: SetVaultS3SecretKey :exec
UPDATE vault_meta SET s3_secret_key = ?, updated_at = ? WHERE id = 1;

-- name: CountSecrets :one
SELECT COUNT(*) FROM secrets;

-- name: CountDumpFiles :one
SELECT COUNT(*) FROM dump_files;

-- name: CountAuditLog :one
SELECT COUNT(*) FROM audit_log;

-- name: CountRestoreHistory :one
SELECT COUNT(*) FROM restore_history;

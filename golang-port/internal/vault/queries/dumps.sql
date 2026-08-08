-- name: UpsertDumpFile :exec
INSERT INTO dump_files (
  relative_path, item_key, file_name, sha256, size_bytes, encrypted, enc_id, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(relative_path) DO UPDATE SET
  sha256 = excluded.sha256,
  size_bytes = excluded.size_bytes,
  encrypted = excluded.encrypted,
  enc_id = excluded.enc_id;

-- name: GetDumpByPath :one
SELECT id, relative_path, item_key, file_name, sha256, size_bytes, encrypted, enc_id, created_at
FROM dump_files
WHERE relative_path = ?;

-- name: ListDumps :many
SELECT id, relative_path, item_key, file_name, sha256, size_bytes, encrypted, enc_id, created_at
FROM dump_files
ORDER BY created_at DESC
LIMIT ?;

-- name: ListDumpsByItemKey :many
SELECT id, relative_path, item_key, file_name, sha256, size_bytes, encrypted, enc_id, created_at
FROM dump_files
WHERE item_key = ?
ORDER BY created_at DESC
LIMIT ?;

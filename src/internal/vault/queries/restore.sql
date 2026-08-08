-- name: InsertRestoreHistory :exec
INSERT INTO restore_history (
  dump_id, dump_relative_path, dump_sha256, destination_key, restored_at,
  duration_ms, status, clean_restore, warnings, error_message
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: ListRestoreHistory :many
SELECT id, dump_id, dump_relative_path, dump_sha256, destination_key, restored_at,
  duration_ms, status, clean_restore, warnings, error_message
FROM restore_history
ORDER BY restored_at DESC
LIMIT ?;

-- name: ListRestoreHistoryByDestination :many
SELECT id, dump_id, dump_relative_path, dump_sha256, destination_key, restored_at,
  duration_ms, status, clean_restore, warnings, error_message
FROM restore_history
WHERE destination_key = ?
ORDER BY restored_at DESC
LIMIT ?;

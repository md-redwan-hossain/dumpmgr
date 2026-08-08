-- name: InsertAuditLog :exec
INSERT INTO audit_log (
  occurred_at, action, status, subject, destination, details, error_message
) VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: ListAuditLog :many
SELECT id, occurred_at, action, status, subject, destination, details, error_message
FROM audit_log
ORDER BY occurred_at DESC
LIMIT ?;

-- name: ListAuditLogByAction :many
SELECT id, occurred_at, action, status, subject, destination, details, error_message
FROM audit_log
WHERE action = ?
ORDER BY occurred_at DESC
LIMIT ?;

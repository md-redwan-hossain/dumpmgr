-- name: ListSecrets :many
SELECT key, created_at, updated_at, last_used_at
FROM secrets
ORDER BY key;

-- name: GetSecretCiphertext :one
SELECT ciphertext FROM secrets WHERE key = ?;

-- name: SecretExists :one
SELECT 1 AS exists_flag FROM secrets WHERE key = ? LIMIT 1;

-- name: InsertSecret :exec
INSERT INTO secrets (key, ciphertext, created_at, updated_at)
VALUES (?, ?, ?, ?);

-- name: UpdateSecret :exec
UPDATE secrets SET ciphertext = ?, updated_at = ? WHERE key = ?;

-- name: TouchSecretUsed :exec
UPDATE secrets SET last_used_at = ? WHERE key = ?;

-- name: DeleteSecret :exec
DELETE FROM secrets WHERE key = ?;

-- name: ListSecretRotations :many
SELECT id, secret_key, action, rotated_at
FROM secret_rotations
WHERE secret_key = ?
ORDER BY rotated_at DESC
LIMIT ?;

-- name: InsertSecretRotation :exec
INSERT INTO secret_rotations (secret_key, action, rotated_at)
VALUES (?, ?, ?);

-- name: ListAllSecretCiphertexts :many
SELECT key, ciphertext FROM secrets;

-- name: UpdateSecretCiphertext :exec
UPDATE secrets SET ciphertext = ?, updated_at = ? WHERE key = ?;

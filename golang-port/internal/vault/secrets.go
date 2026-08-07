package vault

import (
	"database/sql"
	"fmt"
)

func (s *Store) ListSecrets() ([]SecretInfo, error) {
	rows, err := s.db.Query(`SELECT key, created_at, updated_at, last_used_at FROM secrets ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SecretInfo
	for rows.Next() {
		var info SecretInfo
		var created, updated string
		var lastUsed sql.NullString
		if err := rows.Scan(&info.Key, &created, &updated, &lastUsed); err != nil {
			return nil, err
		}
		info.CreatedAt = parseTime(created)
		info.UpdatedAt = parseTime(updated)
		if lastUsed.Valid {
			t := parseTime(lastUsed.String)
			info.LastUsedAt = &t
		}
		out = append(out, info)
	}
	return out, rows.Err()
}

func (s *Store) GetSecretCiphertext(key string) (string, bool, error) {
	var cipher string
	err := s.db.QueryRow(`SELECT ciphertext FROM secrets WHERE key = ?`, key).Scan(&cipher)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return cipher, true, nil
}

func (s *Store) UpsertSecret(key, ciphertext string, rotationAction string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	now := s.now()
	var exists int
	_ = tx.QueryRow(`SELECT 1 FROM secrets WHERE key = ?`, key).Scan(&exists)
	if exists == 1 {
		if _, err := tx.Exec(`UPDATE secrets SET ciphertext = ?, updated_at = ? WHERE key = ?`, ciphertext, now, key); err != nil {
			return err
		}
		if rotationAction == "" {
			rotationAction = RotationUpdated
		}
	} else {
		if _, err := tx.Exec(`INSERT INTO secrets (key, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?)`, key, ciphertext, now, now); err != nil {
			return err
		}
		if rotationAction == "" {
			rotationAction = RotationCreated
		}
	}
	if _, err := tx.Exec(`INSERT INTO secret_rotations (secret_key, action, rotated_at) VALUES (?, ?, ?)`, key, rotationAction, now); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return s.touchVaultMeta()
}

func (s *Store) TouchSecretUsed(key string) error {
	_, err := s.db.Exec(`UPDATE secrets SET last_used_at = ? WHERE key = ?`, s.now(), key)
	return err
}

func (s *Store) DeleteSecret(key string) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	var exists int
	if err := tx.QueryRow(`SELECT 1 FROM secrets WHERE key = ?`, key).Scan(&exists); err == sql.ErrNoRows || exists != 1 {
		return false, nil
	} else if err != nil {
		return false, err
	}
	now := s.now()
	if _, err := tx.Exec(`DELETE FROM secrets WHERE key = ?`, key); err != nil {
		return false, err
	}
	if _, err := tx.Exec(`INSERT INTO secret_rotations (secret_key, action, rotated_at) VALUES (?, ?, ?)`, key, RotationWiped, now); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, s.touchVaultMeta()
}

func (s *Store) ListSecretRotations(key string, limit int) ([]SecretRotation, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.Query(`
		SELECT id, secret_key, action, rotated_at FROM secret_rotations
		WHERE secret_key = ? ORDER BY rotated_at DESC LIMIT ?`, key, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SecretRotation
	for rows.Next() {
		var r SecretRotation
		var at string
		if err := rows.Scan(&r.ID, &r.SecretKey, &r.Action, &at); err != nil {
			return nil, err
		}
		r.RotatedAt = parseTime(at)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) ReencryptAllSecrets(reencrypt func(ciphertext string) (string, error)) error {
	rows, err := s.db.Query(`SELECT key, ciphertext FROM secrets`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type pair struct{ key, cipher string }
	var pairs []pair
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.key, &p.cipher); err != nil {
			return err
		}
		pairs = append(pairs, p)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now()
	for _, p := range pairs {
		next, err := reencrypt(p.cipher)
		if err != nil {
			return fmt.Errorf("re-encrypt %s: %w", p.key, err)
		}
		if _, err := tx.Exec(`UPDATE secrets SET ciphertext = ?, updated_at = ? WHERE key = ?`, next, now, p.key); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO secret_rotations (secret_key, action, rotated_at) VALUES (?, ?, ?)`, p.key, RotationMasterReencrypt, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

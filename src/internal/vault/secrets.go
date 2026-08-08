package vault

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/vault/sqlcgen"
)

func (s *Store) ListSecrets() ([]SecretInfo, error) {
	rows, err := s.queries.ListSecrets(s.ctx())
	if err != nil {
		return nil, err
	}
	out := make([]SecretInfo, 0, len(rows))
	for _, row := range rows {
		out = append(out, secretInfoFromRow(row))
	}
	return out, nil
}

func (s *Store) GetSecretCiphertext(key string) (string, bool, error) {
	cipher, err := s.queries.GetSecretCiphertext(s.ctx(), key)
	if errors.Is(err, sql.ErrNoRows) {
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
	qtx := s.queries.WithTx(tx)
	_, err = qtx.SecretExists(s.ctx(), key)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if err := qtx.InsertSecret(s.ctx(), sqlcgen.InsertSecretParams{
			Key: key, Ciphertext: ciphertext, CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			return err
		}
		if rotationAction == "" {
			rotationAction = RotationCreated
		}
	case err != nil:
		return err
	default:
		if err := qtx.UpdateSecret(s.ctx(), sqlcgen.UpdateSecretParams{
			Ciphertext: ciphertext, UpdatedAt: now, Key: key,
		}); err != nil {
			return err
		}
		if rotationAction == "" {
			rotationAction = RotationUpdated
		}
	}
	if err := qtx.InsertSecretRotation(s.ctx(), sqlcgen.InsertSecretRotationParams{
		SecretKey: key, Action: rotationAction, RotatedAt: now,
	}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return s.touchVaultMeta()
}

func (s *Store) TouchSecretUsed(key string) error {
	return s.queries.TouchSecretUsed(s.ctx(), sqlcgen.TouchSecretUsedParams{
		LastUsedAt: nullString(s.now()),
		Key:        key,
	})
}

func (s *Store) DeleteSecret(key string) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	qtx := s.queries.WithTx(tx)
	if _, err := qtx.SecretExists(s.ctx(), key); errors.Is(err, sql.ErrNoRows) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	now := s.now()
	if err := qtx.DeleteSecret(s.ctx(), key); err != nil {
		return false, err
	}
	if err := qtx.InsertSecretRotation(s.ctx(), sqlcgen.InsertSecretRotationParams{
		SecretKey: key, Action: RotationWiped, RotatedAt: now,
	}); err != nil {
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
	rows, err := s.queries.ListSecretRotations(s.ctx(), sqlcgen.ListSecretRotationsParams{
		SecretKey: key,
		Limit:     int64(limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]SecretRotation, 0, len(rows))
	for _, row := range rows {
		out = append(out, secretRotationFromRow(row))
	}
	return out, nil
}

func (s *Store) ReencryptAllSecrets(reencrypt func(ciphertext string) (string, error)) error {
	pairs, err := s.queries.ListAllSecretCiphertexts(s.ctx())
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now()
	qtx := s.queries.WithTx(tx)
	for _, p := range pairs {
		next, err := reencrypt(p.Ciphertext)
		if err != nil {
			return fmt.Errorf("re-encrypt %s: %w", p.Key, err)
		}
		if err := qtx.UpdateSecretCiphertext(s.ctx(), sqlcgen.UpdateSecretCiphertextParams{
			Ciphertext: next, UpdatedAt: now, Key: p.Key,
		}); err != nil {
			return err
		}
		if err := qtx.InsertSecretRotation(s.ctx(), sqlcgen.InsertSecretRotationParams{
			SecretKey: p.Key, Action: RotationMasterReencrypt, RotatedAt: now,
		}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

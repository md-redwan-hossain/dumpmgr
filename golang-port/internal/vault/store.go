package vault

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db   *sql.DB
	path string
}

func DBPathForConfig(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "vault.db")
}

func Open(configPath string) (*Store, error) {
	path := DBPathForConfig(configPath)
	if err := migrateLegacyIfNeeded(configPath, path); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	s := &Store{db: db, path: path}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Path() string { return s.path }

func (s *Store) migrate() error {
	if _, err := s.db.Exec(schemaDDL); err != nil {
		return fmt.Errorf("vault schema: %w", err)
	}
	var version int
	err := s.db.QueryRow(`SELECT COALESCE((SELECT 1 FROM vault_meta WHERE id = 1), 0)`).Scan(&version)
	if err != nil {
		return err
	}
	if version == 0 {
		now := time.Now().UTC().Format(time.RFC3339Nano)
		_, err = s.db.Exec(`INSERT INTO vault_meta (id, created_at, updated_at) VALUES (1, ?, ?)`, now, now)
		return err
	}
	return nil
}

func (s *Store) now() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func (s *Store) touchVaultMeta() error {
	_, err := s.db.Exec(`UPDATE vault_meta SET updated_at = ? WHERE id = 1`, s.now())
	return err
}

func (s *Store) HasMaster() (bool, error) {
	var hash, salt sql.NullString
	err := s.db.QueryRow(`SELECT master_password_hash, kdf_salt FROM vault_meta WHERE id = 1`).Scan(&hash, &salt)
	if err != nil {
		return false, err
	}
	return hash.Valid && hash.String != "" && salt.Valid && salt.String != "", nil
}

func (s *Store) VaultMeta() (masterHash, kdfSalt, encID, s3Key sql.NullString, err error) {
	err = s.db.QueryRow(`SELECT master_password_hash, kdf_salt, enc_id, s3_secret_key FROM vault_meta WHERE id = 1`).
		Scan(&masterHash, &kdfSalt, &encID, &s3Key)
	return
}

func (s *Store) SetVaultMeta(masterHash, kdfSalt, encID string, s3Key *string) error {
	now := s.now()
	var s3 sql.NullString
	if s3Key != nil {
		s3 = sql.NullString{String: *s3Key, Valid: true}
	}
	_, err := s.db.Exec(`
		UPDATE vault_meta SET master_password_hash = ?, kdf_salt = ?, enc_id = ?, s3_secret_key = ?, updated_at = ?
		WHERE id = 1`, masterHash, kdfSalt, encID, s3, now)
	return err
}

func (s *Store) EncID() (string, error) {
	var encID sql.NullString
	if err := s.db.QueryRow(`SELECT enc_id FROM vault_meta WHERE id = 1`).Scan(&encID); err != nil {
		return "", err
	}
	if encID.Valid {
		return encID.String, nil
	}
	return "", nil
}

func (s *Store) SetEncID(encID string) error {
	_, err := s.db.Exec(`UPDATE vault_meta SET enc_id = ?, updated_at = ? WHERE id = 1`, encID, s.now())
	return err
}

func (s *Store) SetS3SecretKey(ciphertext string) error {
	_, err := s.db.Exec(`UPDATE vault_meta SET s3_secret_key = ?, updated_at = ? WHERE id = 1`, ciphertext, s.now())
	return err
}

func (s *Store) Status() (Status, error) {
	st := Status{DBPath: s.path, SchemaVersion: SchemaVersion}
	has, err := s.HasMaster()
	if err != nil {
		return st, err
	}
	st.HasMaster = has
	encID, _ := s.EncID()
	st.EncID = encID
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM secrets`).Scan(&st.SecretCount)
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM dump_files`).Scan(&st.DumpCount)
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM audit_log`).Scan(&st.AuditCount)
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM restore_history`).Scan(&st.RestoreCount)
	return st, nil
}

func (s *Store) RecordAudit(action, status, subject, destination, details, errMsg string) error {
	_, err := s.db.Exec(`
		INSERT INTO audit_log (occurred_at, action, status, subject, destination, details, error_message)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		s.now(), action, status, subject, destination, details, errMsg)
	return err
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t, _ = time.Parse(time.RFC3339, s)
	}
	return t
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

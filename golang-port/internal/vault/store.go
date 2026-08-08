package vault

import (
	"database/sql"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/vault/sqlcgen"
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

type Store struct {
	db      *sql.DB
	path    string
	queries *sqlcgen.Queries
}

func DBPathForConfig(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "vault.db")
}

func Open(configPath string) (*Store, error) {
	path := DBPathForConfig(configPath)
	if err := migrateLegacyIfNeeded(configPath, path); err != nil {
		return nil, err
	}
	return openVaultDB(path)
}

func (s *Store) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Path() string { return s.path }

func openVaultDB(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	s := &Store{db: db, path: path, queries: sqlcgen.New(db)}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	if _, err := s.db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		return fmt.Errorf("vault schema: %w", err)
	}
	if _, err := s.db.Exec(schemaSQL); err != nil {
		return fmt.Errorf("vault schema: %w", err)
	}
	exists, err := s.queries.VaultMetaRowExists(s.ctx())
	if err != nil {
		return err
	}
	if exists == 0 {
		now := s.now()
		return s.queries.InsertVaultMeta(s.ctx(), sqlcgen.InsertVaultMetaParams{
			CreatedAt: now,
			UpdatedAt: now,
		})
	}
	return nil
}

func (s *Store) now() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func (s *Store) touchVaultMeta() error {
	return s.queries.TouchVaultMeta(s.ctx(), s.now())
}

func (s *Store) HasMaster() (bool, error) {
	row, err := s.queries.GetVaultMasterFields(s.ctx())
	if err != nil {
		return false, err
	}
	return row.MasterPasswordHash.Valid && row.MasterPasswordHash.String != "" &&
		row.KdfSalt.Valid && row.KdfSalt.String != "", nil
}

func (s *Store) VaultMeta() (masterHash, kdfSalt, encID, s3Key sql.NullString, err error) {
	row, err := s.queries.GetVaultMetaRow(s.ctx())
	if err != nil {
		return
	}
	return row.MasterPasswordHash, row.KdfSalt, row.EncID, row.S3SecretKey, nil
}

func (s *Store) SetVaultMeta(masterHash, kdfSalt, encID string, s3Key *string) error {
	return s.queries.SetVaultMeta(s.ctx(), sqlcgen.SetVaultMetaParams{
		MasterPasswordHash: nullString(masterHash),
		KdfSalt:            nullString(kdfSalt),
		EncID:              nullString(encID),
		S3SecretKey:        optionalNullString(s3Key),
		UpdatedAt:          s.now(),
	})
}

func (s *Store) EncID() (string, error) {
	encID, err := s.queries.GetVaultEncID(s.ctx())
	if err != nil {
		return "", err
	}
	if encID.Valid {
		return encID.String, nil
	}
	return "", nil
}

func (s *Store) SetEncID(encID string) error {
	return s.queries.SetVaultEncID(s.ctx(), sqlcgen.SetVaultEncIDParams{
		EncID:     nullString(encID),
		UpdatedAt: s.now(),
	})
}

func (s *Store) SetS3SecretKey(ciphertext string) error {
	return s.queries.SetVaultS3SecretKey(s.ctx(), sqlcgen.SetVaultS3SecretKeyParams{
		S3SecretKey: nullString(ciphertext),
		UpdatedAt:   s.now(),
	})
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
	secretCount, _ := s.queries.CountSecrets(s.ctx())
	dumpCount, _ := s.queries.CountDumpFiles(s.ctx())
	auditCount, _ := s.queries.CountAuditLog(s.ctx())
	restoreCount, _ := s.queries.CountRestoreHistory(s.ctx())
	st.SecretCount = int(secretCount)
	st.DumpCount = int(dumpCount)
	st.AuditCount = int(auditCount)
	st.RestoreCount = int(restoreCount)
	return st, nil
}

func (s *Store) RecordAudit(action, status, subject, destination, details, errMsg string) error {
	return s.queries.InsertAuditLog(s.ctx(), sqlcgen.InsertAuditLogParams{
		OccurredAt:   s.now(),
		Action:       action,
		Status:       status,
		Subject:      subject,
		Destination:  destination,
		Details:      details,
		ErrorMessage: errMsg,
	})
}

func (s *Store) CreatedAt() (time.Time, error) {
	created, err := s.queries.GetVaultCreatedAt(s.ctx())
	if err != nil {
		return time.Time{}, err
	}
	return parseTime(created), nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

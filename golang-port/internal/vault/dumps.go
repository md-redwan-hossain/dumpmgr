package vault

import (
	"database/sql"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/dumps"
)

func (s *Store) RegisterDump(relativePath, itemKey, fileName, sha256 string, size int64, encrypted bool, encID string) (int64, error) {
	now := s.now()
	enc := 0
	if encrypted {
		enc = 1
	}
	res, err := s.db.Exec(`
		INSERT INTO dump_files (relative_path, item_key, file_name, sha256, size_bytes, encrypted, enc_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(relative_path) DO UPDATE SET
			sha256 = excluded.sha256,
			size_bytes = excluded.size_bytes,
			encrypted = excluded.encrypted,
			enc_id = excluded.enc_id`,
		relativePath, itemKey, fileName, sha256, size, enc, encID, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) GetDumpByPath(relativePath string) (*DumpRecord, error) {
	var d DumpRecord
	var enc int
	var created string
	err := s.db.QueryRow(`
		SELECT id, relative_path, item_key, file_name, sha256, size_bytes, encrypted, enc_id, created_at
		FROM dump_files WHERE relative_path = ?`, relativePath).
		Scan(&d.ID, &d.RelativePath, &d.ItemKey, &d.FileName, &d.SHA256, &d.SizeBytes, &enc, &d.EncID, &created)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	d.Encrypted = enc == 1
	d.CreatedAt = parseTime(created)
	return &d, nil
}

func (s *Store) ListDumps(itemKey string, limit int) ([]DumpRecord, error) {
	if limit <= 0 {
		limit = 100
	}
	var rows *sql.Rows
	var err error
	if itemKey != "" {
		rows, err = s.db.Query(`
			SELECT id, relative_path, item_key, file_name, sha256, size_bytes, encrypted, enc_id, created_at
			FROM dump_files WHERE item_key = ? ORDER BY created_at DESC LIMIT ?`, itemKey, limit)
	} else {
		rows, err = s.db.Query(`
			SELECT id, relative_path, item_key, file_name, sha256, size_bytes, encrypted, enc_id, created_at
			FROM dump_files ORDER BY created_at DESC LIMIT ?`, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanDumpRows(rows)
}

func scanDumpRows(rows *sql.Rows) ([]DumpRecord, error) {
	var out []DumpRecord
	for rows.Next() {
		var d DumpRecord
		var enc int
		var created string
		if err := rows.Scan(&d.ID, &d.RelativePath, &d.ItemKey, &d.FileName, &d.SHA256, &d.SizeBytes, &enc, &d.EncID, &created); err != nil {
			return nil, err
		}
		d.Encrypted = enc == 1
		d.CreatedAt = parseTime(created)
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) RecordRestore(rec RestoreRecord) error {
	clean := 0
	if rec.CleanRestore {
		clean = 1
	}
	_, err := s.db.Exec(`
		INSERT INTO restore_history (
			dump_id, dump_relative_path, dump_sha256, destination_key, restored_at,
			duration_ms, status, clean_restore, warnings, error_message
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rec.DumpID, rec.DumpRelativePath, rec.DumpSHA256, rec.DestinationKey, s.now(),
		rec.DurationMS, rec.Status, clean, rec.Warnings, rec.ErrorMessage)
	return err
}

func (s *Store) ListRestoreHistory(destinationKey string, limit int) ([]RestoreRecord, error) {
	if limit <= 0 {
		limit = 50
	}
	var rows *sql.Rows
	var err error
	if destinationKey != "" {
		rows, err = s.db.Query(`
			SELECT id, dump_id, dump_relative_path, dump_sha256, destination_key, restored_at,
				duration_ms, status, clean_restore, warnings, error_message
			FROM restore_history WHERE destination_key = ? ORDER BY restored_at DESC LIMIT ?`, destinationKey, limit)
	} else {
		rows, err = s.db.Query(`
			SELECT id, dump_id, dump_relative_path, dump_sha256, destination_key, restored_at,
				duration_ms, status, clean_restore, warnings, error_message
			FROM restore_history ORDER BY restored_at DESC LIMIT ?`, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RestoreRecord
	for rows.Next() {
		var r RestoreRecord
		var dumpID sql.NullInt64
		var restored string
		var clean int
		if err := rows.Scan(&r.ID, &dumpID, &r.DumpRelativePath, &r.DumpSHA256, &r.DestinationKey, &restored,
			&r.DurationMS, &r.Status, &clean, &r.Warnings, &r.ErrorMessage); err != nil {
			return nil, err
		}
		if dumpID.Valid {
			v := dumpID.Int64
			r.DumpID = &v
		}
		r.CleanRestore = clean == 1
		r.RestoredAt = parseTime(restored)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) ListAudit(action string, limit int) ([]AuditEntry, error) {
	if limit <= 0 {
		limit = 100
	}
	var rows *sql.Rows
	var err error
	if action != "" {
		rows, err = s.db.Query(`
			SELECT id, occurred_at, action, status, subject, destination, details, error_message
			FROM audit_log WHERE action = ? ORDER BY occurred_at DESC LIMIT ?`, action, limit)
	} else {
		rows, err = s.db.Query(`
			SELECT id, occurred_at, action, status, subject, destination, details, error_message
			FROM audit_log ORDER BY occurred_at DESC LIMIT ?`, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditEntry
	for rows.Next() {
		var e AuditEntry
		var at string
		if err := rows.Scan(&e.ID, &at, &e.Action, &e.Status, &e.Subject, &e.Destination, &e.Details, &e.ErrorMessage); err != nil {
			return nil, err
		}
		e.OccurredAt = parseTime(at)
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) ScanDumpsRoot(dumpsRoot string) (int, error) {
	count := 0
	err := filepath.WalkDir(dumpsRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		if !strings.HasSuffix(name, ".dump") && !strings.HasSuffix(name, ".dump.enc") {
			return nil
		}
		rel, err := filepath.Rel(dumpsRoot, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		hash, size, err := SHA256File(path)
		if err != nil {
			return err
		}
		itemKey := dumpsItemKeyFromPath(rel)
		enc := dumps.IsEncryptedDumpName(name)
		encID := dumps.DumpEncIDFromName(name)
		if _, err := s.RegisterDump(rel, itemKey, name, hash, size, enc, encID); err != nil {
			return err
		}
		count++
		return nil
	})
	return count, err
}

func dumpsItemKeyFromPath(rel string) string {
	parts := strings.Split(rel, "/")
	if len(parts) < 2 {
		if len(parts) == 1 {
			// prod/prod_ts.dump -> prod
			base := strings.TrimSuffix(parts[0], filepath.Ext(parts[0]))
			if idx := strings.Index(base, "_"); idx > 0 {
				return strings.ReplaceAll(base[:idx], "__", ":")
			}
		}
		return ""
	}
	dirParts := parts[:len(parts)-1]
	return strings.ReplaceAll(strings.Join(dirParts, ":"), "/", ":")
}

func RelativeDumpPath(dumpsRoot, absPath string) (string, error) {
	root, err := filepath.Abs(dumpsRoot)
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(absPath)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("dump path outside dumps root")
	}
	return filepath.ToSlash(rel), nil
}

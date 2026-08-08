package vault

import (
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/dumps"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/vault/sqlcgen"
)

func (s *Store) RegisterDump(relativePath, itemKey, fileName, sha256 string, size int64, encrypted bool, encID string) (int64, error) {
	enc := int64(0)
	if encrypted {
		enc = 1
	}
	err := s.queries.UpsertDumpFile(s.ctx(), sqlcgen.UpsertDumpFileParams{
		RelativePath: relativePath,
		ItemKey:      itemKey,
		FileName:     fileName,
		Sha256:       sha256,
		SizeBytes:    size,
		Encrypted:    enc,
		EncID:        encID,
		CreatedAt:    s.now(),
	})
	return 0, err
}

func (s *Store) GetDumpByPath(relativePath string) (*DumpRecord, error) {
	row, err := s.queries.GetDumpByPath(s.ctx(), relativePath)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rec := dumpRecordFromRow(row)
	return &rec, nil
}

func (s *Store) ListDumps(itemKey string, limit int) ([]DumpRecord, error) {
	if limit <= 0 {
		limit = 100
	}
	var rows []sqlcgen.DumpFile
	var err error
	if itemKey != "" {
		rows, err = s.queries.ListDumpsByItemKey(s.ctx(), sqlcgen.ListDumpsByItemKeyParams{
			ItemKey: itemKey,
			Limit:   int64(limit),
		})
	} else {
		rows, err = s.queries.ListDumps(s.ctx(), int64(limit))
	}
	if err != nil {
		return nil, err
	}
	out := make([]DumpRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, dumpRecordFromRow(row))
	}
	return out, nil
}

func (s *Store) RecordRestore(rec RestoreRecord) error {
	clean := int64(0)
	if rec.CleanRestore {
		clean = 1
	}
	var dumpID sql.NullInt64
	if rec.DumpID != nil {
		dumpID = sql.NullInt64{Int64: *rec.DumpID, Valid: true}
	}
	return s.queries.InsertRestoreHistory(s.ctx(), sqlcgen.InsertRestoreHistoryParams{
		DumpID:           dumpID,
		DumpRelativePath: rec.DumpRelativePath,
		DumpSha256:       rec.DumpSHA256,
		DestinationKey:   rec.DestinationKey,
		RestoredAt:       s.now(),
		DurationMs:       rec.DurationMS,
		Status:           rec.Status,
		CleanRestore:     clean,
		Warnings:         rec.Warnings,
		ErrorMessage:     rec.ErrorMessage,
	})
}

func (s *Store) ListRestoreHistory(destinationKey string, limit int) ([]RestoreRecord, error) {
	if limit <= 0 {
		limit = 50
	}
	var rows []sqlcgen.RestoreHistory
	var err error
	if destinationKey != "" {
		rows, err = s.queries.ListRestoreHistoryByDestination(s.ctx(), sqlcgen.ListRestoreHistoryByDestinationParams{
			DestinationKey: destinationKey,
			Limit:          int64(limit),
		})
	} else {
		rows, err = s.queries.ListRestoreHistory(s.ctx(), int64(limit))
	}
	if err != nil {
		return nil, err
	}
	out := make([]RestoreRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, restoreRecordFromRow(row))
	}
	return out, nil
}

func (s *Store) ListAudit(action string, limit int) ([]AuditEntry, error) {
	if limit <= 0 {
		limit = 100
	}
	var rows []sqlcgen.AuditLog
	var err error
	if action != "" {
		rows, err = s.queries.ListAuditLogByAction(s.ctx(), sqlcgen.ListAuditLogByActionParams{
			Action: action,
			Limit:  int64(limit),
		})
	} else {
		rows, err = s.queries.ListAuditLog(s.ctx(), int64(limit))
	}
	if err != nil {
		return nil, err
	}
	out := make([]AuditEntry, 0, len(rows))
	for _, row := range rows {
		out = append(out, auditEntryFromRow(row))
	}
	return out, nil
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

package vault

import (
	"context"
	"database/sql"
	"time"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/vault/sqlcgen"
)

func (s *Store) ctx() context.Context {
	return context.Background()
}

func parseTime(raw string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		t, _ = time.Parse(time.RFC3339, raw)
	}
	return t
}

func secretInfoFromRow(row sqlcgen.ListSecretsRow) SecretInfo {
	info := SecretInfo{
		Key:       row.Key,
		CreatedAt: parseTime(row.CreatedAt),
		UpdatedAt: parseTime(row.UpdatedAt),
	}
	if row.LastUsedAt.Valid {
		t := parseTime(row.LastUsedAt.String)
		info.LastUsedAt = &t
	}
	return info
}

func secretRotationFromRow(row sqlcgen.SecretRotation) SecretRotation {
	return SecretRotation{
		ID:        row.ID,
		SecretKey: row.SecretKey,
		Action:    row.Action,
		RotatedAt: parseTime(row.RotatedAt),
	}
}

func dumpRecordFromRow(row sqlcgen.DumpFile) DumpRecord {
	return DumpRecord{
		ID:           row.ID,
		RelativePath: row.RelativePath,
		ItemKey:      row.ItemKey,
		FileName:     row.FileName,
		SHA256:       row.Sha256,
		SizeBytes:    row.SizeBytes,
		Encrypted:    row.Encrypted == 1,
		EncID:        row.EncID,
		CreatedAt:    parseTime(row.CreatedAt),
	}
}

func auditEntryFromRow(row sqlcgen.AuditLog) AuditEntry {
	return AuditEntry{
		ID:           row.ID,
		OccurredAt:   parseTime(row.OccurredAt),
		Action:       row.Action,
		Status:       row.Status,
		Subject:      row.Subject,
		Destination:  row.Destination,
		Details:      row.Details,
		ErrorMessage: row.ErrorMessage,
	}
}

func restoreRecordFromRow(row sqlcgen.RestoreHistory) RestoreRecord {
	rec := RestoreRecord{
		ID:               row.ID,
		DumpRelativePath: row.DumpRelativePath,
		DumpSHA256:       row.DumpSha256,
		DestinationKey:   row.DestinationKey,
		RestoredAt:       parseTime(row.RestoredAt),
		DurationMS:       row.DurationMs,
		Status:           row.Status,
		CleanRestore:     row.CleanRestore == 1,
		Warnings:         row.Warnings,
		ErrorMessage:     row.ErrorMessage,
	}
	if row.DumpID.Valid {
		v := row.DumpID.Int64
		rec.DumpID = &v
	}
	return rec
}

func nullString(value string) sql.NullString {
	if value == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: value, Valid: true}
}

func optionalNullString(value *string) sql.NullString {
	if value == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *value, Valid: true}
}

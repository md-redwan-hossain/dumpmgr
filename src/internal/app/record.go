package app

import (
	"fmt"
	"path/filepath"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/dumps"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/metadata"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/vault"
)

func recordDump(session *metadata.Session, dumpsRoot, absPath, itemKey string) error {
	if session == nil || session.Store == nil {
		return nil
	}
	rel, err := vault.RelativeDumpPath(dumpsRoot, absPath)
	if err != nil {
		return err
	}
	hash, size, err := vault.SHA256File(absPath)
	if err != nil {
		return err
	}
	name := filepath.Base(absPath)
	enc := dumps.IsEncryptedDumpName(name)
	encID := dumps.DumpEncIDFromName(name)
	if encID == "" {
		if id, err := metadata.EncID(session); err == nil {
			encID = id
		}
	}
	if _, err := session.Store.RegisterDump(rel, itemKey, name, hash, size, enc, encID); err != nil {
		return err
	}
	return session.Store.RecordAudit(vault.ActionDump, vault.StatusSuccess, itemKey, rel, fmt.Sprintf("sha256=%s size=%d", hash, size), "")
}

func recordRestore(session *metadata.Session, dumpsRoot, absPath, destKey string, durationMS int64, clean bool, warnings string, restoreErr error) {
	if session == nil || session.Store == nil {
		return
	}
	rel, _ := vault.RelativeDumpPath(dumpsRoot, absPath)
	hash, _, _ := vault.SHA256File(absPath)
	var dumpID *int64
	if rec, _ := session.Store.GetDumpByPath(rel); rec != nil {
		id := rec.ID
		dumpID = &id
	}
	status := vault.StatusSuccess
	errMsg := ""
	if restoreErr != nil {
		status = vault.StatusFailure
		errMsg = restoreErr.Error()
	}
	cleanInt := clean
	_ = session.Store.RecordRestore(vault.RestoreRecord{
		DumpID:           dumpID,
		DumpRelativePath: rel,
		DumpSHA256:       hash,
		DestinationKey:   destKey,
		DurationMS:       durationMS,
		Status:           status,
		CleanRestore:     cleanInt,
		Warnings:         warnings,
		ErrorMessage:     errMsg,
	})
	action := vault.ActionRestore
	subject := rel
	if status == vault.StatusSuccess {
		_ = session.Store.RecordAudit(action, status, subject, destKey, fmt.Sprintf("duration_ms=%d clean=%v", durationMS, clean), "")
	} else {
		_ = session.Store.RecordAudit(action, status, subject, destKey, "", errMsg)
	}
}

func recordSyncAudit(session *metadata.Session, sourceKey, destKey, dumpRel string, err error) {
	if session == nil || session.Store == nil {
		return
	}
	status := vault.StatusSuccess
	errMsg := ""
	if err != nil {
		status = vault.StatusFailure
		errMsg = err.Error()
	}
	_ = session.Store.RecordAudit(vault.ActionSync, status, sourceKey, destKey, dumpRel, errMsg)
}

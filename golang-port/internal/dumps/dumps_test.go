package dumps_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/dumps"
)

func TestDumpPathsAndNames(t *testing.T) {
	if dumps.ResolveRoot("/tmp/backups") != filepath.Join("/tmp/backups", "dumps") {
		t.Fatal("unexpected dumps root")
	}
	if dumps.ResolveRoot("/tmp/dumps") != "/tmp/dumps" {
		t.Fatal("expected existing dumps segment to be preserved")
	}
	if dumps.DBDumpDir("/tmp/dumps", "parent:child") != filepath.Join("/tmp/dumps", "parent", "child") {
		t.Fatal("unexpected db dump dir")
	}
	if dumps.DumpFileKey("parent:child") != "parent__child" {
		t.Fatal("unexpected dump file key")
	}
	ts := time.Date(2026, 8, 6, 1, 2, 3, 0, time.UTC)
	if dumps.DumpTimestamp(ts) != "2026-08-06_01-02-03" {
		t.Fatal("unexpected timestamp")
	}
	if dumps.FormatBytes(1024) != "1.0 KB" {
		t.Fatal("unexpected bytes format")
	}
	if dumps.FormatDuration(1250) != "1.3s" {
		t.Fatal("unexpected duration format")
	}
}

func TestEncryptedFilenameHelpers(t *testing.T) {
	name := "parent__child_2026-08-06_01-02-03_enc_A1B2.dump"
	if !dumps.IsEncryptedDumpName(name) {
		t.Fatal("expected encrypted name")
	}
	if dumps.DumpEncIDFromName(name) != "A1B2" {
		t.Fatal("unexpected enc id")
	}
	if dumps.PlainTempNameFromEncrypted(name) != "parent__child_2026-08-06_01-02-03.dump" {
		t.Fatal("unexpected plain name")
	}
	if dumps.EncryptedPathFromPlain("/tmp/plain.dump", "A1B2") != "/tmp/plain_enc_A1B2.dump" {
		t.Fatal("unexpected encrypted path")
	}
	if dumps.IsEncryptedDumpName("plain.dump") {
		t.Fatal("did not expect plain dump to be encrypted")
	}
}

func TestListDumpFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "old.dump"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "new_enc_A1.dump"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("ignore"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "folder"), 0o755); err != nil {
		t.Fatal(err)
	}

	plain, err := dumps.ListDumpFiles(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(plain) != 1 || plain[0] != "old.dump" {
		t.Fatalf("unexpected plain dumps: %+v", plain)
	}
	enc, err := dumps.ListDumpFiles(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(enc) != 1 || enc[0] != "new_enc_A1.dump" {
		t.Fatalf("unexpected encrypted dumps: %+v", enc)
	}
	entries, err := dumps.ListBrowserEntries(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Name != "folder" || entries[1].Name != "old.dump" {
		t.Fatalf("unexpected browser entries: %+v", entries)
	}
}

func TestEncryptAndDecryptDumpFile(t *testing.T) {
	dir := t.TempDir()
	plainPath := filepath.Join(dir, "sample.dump")
	tempPath := filepath.Join(dir, "restored.dump")
	if err := os.WriteFile(plainPath, []byte("dump payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	encryptedPath, err := dumps.EncryptDumpFile(plainPath, key, "A1B2")
	if err != nil {
		t.Fatal(err)
	}
	if encryptedPath != filepath.Join(dir, "sample_enc_A1B2.dump") {
		t.Fatalf("unexpected encrypted path: %s", encryptedPath)
	}
	if _, err := os.Stat(plainPath); !os.IsNotExist(err) {
		t.Fatal("expected plain dump to be removed")
	}
	if err := dumps.DecryptDumpToTemp(encryptedPath, key, tempPath); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(tempPath)
	if err != nil || string(data) != "dump payload" {
		t.Fatalf("unexpected decrypted payload: %q %v", data, err)
	}
}

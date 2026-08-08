package metadata_test

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/metadata"
)

func TestPersistEncryptedSecrets(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.jsonc")
	if err := os.WriteFile(configPath, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	session, err := metadata.CreateWithMaster(configPath, "test-master")
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	if err := metadata.SetDBPassword(session, "postgres:prod", "db-secret"); err != nil {
		t.Fatal(err)
	}
	if err := metadata.SetS3SecretKey(session, "s3-secret"); err != nil {
		t.Fatal(err)
	}
	pw, err := metadata.GetDBPassword(session, "postgres:prod")
	if err != nil || pw != "db-secret" {
		t.Fatalf("db password: %q %v", pw, err)
	}
	sk, err := metadata.GetS3SecretKey(session)
	if err != nil || sk != "s3-secret" {
		t.Fatalf("s3 secret: %q %v", sk, err)
	}
	info, err := os.Stat(metadata.DBPathForConfig(configPath))
	if err != nil || info.Size() <= 100 {
		t.Fatal("expected vault database to be written")
	}

	reloaded, err := metadata.Unlock(configPath, "test-master")
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Close()
	pw, err = metadata.GetDBPassword(reloaded, "postgres:prod")
	if err != nil || pw != "db-secret" {
		t.Fatalf("reloaded db password: %q %v", pw, err)
	}
	sk, err = metadata.GetS3SecretKey(reloaded)
	if err != nil || sk != "s3-secret" {
		t.Fatalf("reloaded s3 secret: %q %v", sk, err)
	}
	removed, err := metadata.DeleteDBPassword(reloaded, "postgres:prod")
	if err != nil || !removed {
		t.Fatalf("delete db password: removed=%v err=%v", removed, err)
	}
	removed, err = metadata.DeleteDBPassword(reloaded, "postgres:missing")
	if err != nil || removed {
		t.Fatalf("delete missing password: removed=%v err=%v", removed, err)
	}
	pw, err = metadata.GetDBPassword(reloaded, "postgres:prod")
	if err != nil || pw != "" {
		t.Fatalf("expected deleted password to be empty: %q %v", pw, err)
	}
}

func TestEmptyVaultAndLegacyMigration(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.jsonc")
	if err := metadata.Empty(configPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(metadata.DBPathForConfig(configPath)); err != nil {
		t.Fatal("expected vault database")
	}

	legacyPath := filepath.Join(dir, "metadata.json")
	legacy := `{"masterPassword":null,"kdfSalt":null,"dbPasswords":{},"encId":null}`
	if err := os.WriteFile(legacyPath, []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(metadata.DBPathForConfig(configPath))

	store, err := metadata.Open(configPath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	encID, err := store.EncID()
	if err != nil || encID == "" || !regexp.MustCompile(`^[A-F0-9]{32}$`).MatchString(encID) {
		t.Fatalf("expected migrated enc id: %q %v", encID, err)
	}
	if _, err := os.Stat(legacyPath + ".bak"); err != nil {
		t.Fatal("expected legacy metadata.json backup")
	}
}

func TestChangeMasterReencryptsS3Secret(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.jsonc")
	if err := os.WriteFile(configPath, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	session, err := metadata.CreateWithMaster(configPath, "old-master")
	if err != nil {
		t.Fatal(err)
	}
	if err := metadata.SetDBPassword(session, "postgres:prod", "db-secret"); err != nil {
		t.Fatal(err)
	}
	if err := metadata.SetS3SecretKey(session, "s3-secret"); err != nil {
		t.Fatal(err)
	}
	_, _, _, oldS3, err := session.Store.VaultMeta()
	if err != nil || !oldS3.Valid {
		t.Fatal("expected s3 ciphertext in vault")
	}
	oldCipher := oldS3.String

	updated, err := metadata.ChangeMasterPassword(session, "new-master")
	if err != nil {
		t.Fatal(err)
	}
	updated.Close()

	reloaded, err := metadata.Unlock(configPath, "new-master")
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Close()

	pw, err := metadata.GetDBPassword(reloaded, "postgres:prod")
	if err != nil || pw != "db-secret" {
		t.Fatalf("db password: %q %v", pw, err)
	}
	sk, err := metadata.GetS3SecretKey(reloaded)
	if err != nil || sk != "s3-secret" {
		t.Fatalf("s3 secret: %q %v", sk, err)
	}
	_, _, _, newS3, err := reloaded.Store.VaultMeta()
	if err != nil || !newS3.Valid {
		t.Fatal("expected reloaded s3 ciphertext")
	}
	if newS3.String == oldCipher {
		t.Fatal("expected S3 ciphertext to change after master rotation")
	}
}

func TestCreateWithMasterRoundTrip(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.jsonc")
	if err := os.WriteFile(configPath, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	session, err := metadata.CreateWithMaster(configPath, "master-pass")
	if err != nil {
		t.Fatal(err)
	}
	session.Close()
	unlocked, err := metadata.Unlock(configPath, "master-pass")
	if err != nil {
		t.Fatal(err)
	}
	unlocked.Close()
}

package metadata_test

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/crypto"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/metadata"
)

func TestPersistEncryptedSecrets(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "metadata")
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 10)
	}
	encID := "A1B2"
	session := &metadata.Session{
		MasterPassword: "test-master",
		AESKey:         key,
		Metadata: metadata.Metadata{
			DBPasswords: map[string]string{},
			EncID:       &encID,
		},
		MetadataPath: path,
	}
	if err := metadata.Write(path, session.Metadata); err != nil {
		t.Fatal(err)
	}
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
	info, err := os.Stat(path)
	if err != nil || info.Size() <= 5 {
		t.Fatal("expected metadata file to be written")
	}

	reloaded := &metadata.Session{
		MasterPassword: session.MasterPassword,
		AESKey:         session.AESKey,
		MetadataPath:   path,
	}
	reloaded.Metadata, err = metadata.Load(path)
	if err != nil {
		t.Fatal(err)
	}
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

func TestEmptyMetadataAndLegacyMigration(t *testing.T) {
	dir := t.TempDir()
	emptyPath := filepath.Join(dir, "empty")
	if _, err := metadata.Empty(emptyPath); err != nil {
		t.Fatal(err)
	}
	meta, err := metadata.Load(emptyPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(meta.DBPasswords) != 0 {
		t.Fatalf("expected empty db passwords: %+v", meta.DBPasswords)
	}

	legacyPath := filepath.Join(dir, "metadata.json")
	binaryPath := filepath.Join(dir, "metadata")
	legacy := `{"masterPassword":null,"kdfSalt":null,"dbPasswords":{},"encId":null}`
	if err := os.WriteFile(legacyPath, []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	migrated, err := metadata.Load(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	if migrated.EncID == nil || !regexp.MustCompile(`^[A-F0-9]{32}$`).MatchString(*migrated.EncID) {
		t.Fatalf("expected migrated enc id: %+v", migrated.EncID)
	}
	if _, err := os.Stat(legacyPath); !os.IsNotExist(err) {
		t.Fatal("expected legacy metadata.json to be removed")
	}
	info, err := os.Stat(binaryPath)
	if err != nil || info.Size() <= 5 {
		t.Fatal("expected binary metadata file")
	}
}

func TestCreateWithMasterRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "metadata")
	if _, err := metadata.CreateWithMaster(path, "master-pass"); err != nil {
		t.Fatal(err)
	}
	session, err := metadata.Unlock(path, "master-pass")
	if err != nil {
		t.Fatal(err)
	}
	secret, err := crypto.EncryptSecret(session.AESKey, "value")
	if err != nil {
		t.Fatal(err)
	}
	_ = secret
}

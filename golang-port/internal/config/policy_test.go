package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/config"
)

func TestValidateEncryptedDumpPolicy(t *testing.T) {
	err := config.ValidateEncryptedDumpPolicy(&config.Config{
		EncryptedDump:    true,
		RememberPassword: false,
	})
	if err == nil {
		t.Fatal("expected policy error")
	}

	err = config.ValidateEncryptedDumpPolicy(&config.Config{
		EncryptedDump:    true,
		RememberPassword: true,
	})
	if err != nil {
		t.Fatalf("unexpected policy error: %v", err)
	}
}

func TestLoadRejectsEncryptedDumpWithoutRememberPassword(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.jsonc")
	content := `{
		"rememberPassword": false,
		"encryptedDump": true,
		"items": {
			"prod": {
				"host": "db",
				"port": 5432,
				"user": "admin",
				"database": "app"
			}
		}
	}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Load(path); err == nil {
		t.Fatal("expected load to fail policy check")
	}
	result := config.ValidateFile(path)
	if result.OK {
		t.Fatal("expected validate to fail policy check")
	}
}

func TestFindDatabaseItemAndRestoreDestination(t *testing.T) {
	cfg := config.DefaultConfigScaffold(true)
	if item := config.FindDatabaseItem(&cfg, "prod"); item == nil || item.Key != "prod" {
		t.Fatalf("expected prod item: %+v", item)
	}
	if item := config.FindRestoreDestination(&cfg, "local_dev:dump"); item == nil || item.Key != "local_dev:dump" {
		t.Fatalf("expected nested restore item: %+v", item)
	}
	if config.FindRestoreDestination(&cfg, "missing") != nil {
		t.Fatal("expected nil for unknown key")
	}
}

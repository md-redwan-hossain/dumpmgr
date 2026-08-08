package config_test

import (
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/config"
)

func TestConfigItemsFlattenNested(t *testing.T) {
	cfg := mustParse(t, `{
		"items": {
			"source": {
				"host": "db",
				"port": 5432,
				"user": "admin",
				"database": "app",
				"items": {
					"copy": { "database": "app_copy", "user": "reader" }
				}
			}
		}
	}`)

	items := config.ConfigItems(cfg)
	sort.Slice(items, func(i, j int) bool { return items[i].Key < items[j].Key })

	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}
	if items[0].Key != "source" || items[0].Nested {
		t.Fatalf("unexpected parent item: %+v", items[0])
	}
	if items[1].Key != "source:copy" || !items[1].Nested || items[1].ParentKey != "source" {
		t.Fatalf("unexpected child item: %+v", items[1])
	}
	if config.DBKey("source:copy") != "postgres:source:copy" {
		t.Fatalf("unexpected db key")
	}
}

func TestConfigRestoreTreeReadonly(t *testing.T) {
	cfg := mustParse(t, `{
		"items": {
			"locked": {
				"host": "db", "port": 5432, "user": "admin", "database": "app", "readonly": true
			},
			"tree": {
				"host": "db", "port": 5432, "user": "admin", "database": "app", "readonly": true,
				"items": { "child": { "database": "child" } }
			}
		}
	}`)

	tree := config.ConfigRestoreTreeItems(cfg)
	sort.Slice(tree, func(i, j int) bool { return tree[i].Key < tree[j].Key })

	if len(tree) != 2 {
		t.Fatalf("expected 2 tree items, got %d", len(tree))
	}
	if tree[0].Key != "tree" || !tree[0].Disabled || tree[0].Depth != 0 {
		t.Fatalf("unexpected tree parent: %+v", tree[0])
	}
	if tree[1].Key != "tree:child" || tree[1].Disabled || tree[1].Depth != 1 {
		t.Fatalf("unexpected tree child: %+v", tree[1])
	}
}

func TestDefaultsAndScaffold(t *testing.T) {
	cfg := mustParse(t, `{}`)
	if !cfg.RememberPassword || cfg.EncryptedDump {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if config.ConfigImage(cfg) != config.DefaultImage {
		t.Fatalf("expected default image")
	}
	if len(config.DefaultConfigScaffold(false).Items) != 0 {
		t.Fatalf("expected empty scaffold")
	}
	fake := config.DefaultConfigScaffold(true)
	if _, ok := fake.Items["prod"]; !ok {
		t.Fatalf("expected prod in fake scaffold")
	}
	if fake.S3Options == nil || fake.S3Options.BucketName != "dumpmgr-demo" {
		t.Fatalf("unexpected fake s3 options: %+v", fake.S3Options)
	}
}

func TestRejectsInvalidPortAndUnknownFields(t *testing.T) {
	_, err := config.ParseJSONC([]byte(`{
		"items": {
			"bad": {
				"host": "db",
				"port": 70000,
				"user": "admin",
				"database": "app",
				"password": "must-not-be-configured"
			}
		}
	}`))
	if err == nil {
		t.Fatal("expected validation error")
	}
}

func TestLoadJSONCAndValidateWarnings(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.jsonc")
	content := `{
		// local test config
		"image": "postgres:18-alpine",
		"items": {}
	}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if config.ConfigImage(cfg) != "postgres:18-alpine" {
		t.Fatalf("unexpected image: %s", config.ConfigImage(cfg))
	}
	result := config.ValidateFile(path)
	if !result.OK {
		t.Fatalf("expected valid config: %+v", result.Issues)
	}
	if len(result.Warnings) < 2 {
		t.Fatalf("expected warnings, got %+v", result.Warnings)
	}
}

func TestWriteAndLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.jsonc")
	original := config.DefaultConfigScaffold(true)
	if err := config.Write(path, original); err != nil {
		t.Fatal(err)
	}
	loaded, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Items["local_dev"].Items["dump"].Database != "app_db_dump" {
		t.Fatalf("unexpected nested database: %+v", loaded.Items["local_dev"].Items)
	}
}

func mustParse(t *testing.T, data string) *config.Config {
	t.Helper()
	cfg, err := config.ParseJSONC([]byte(data))
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

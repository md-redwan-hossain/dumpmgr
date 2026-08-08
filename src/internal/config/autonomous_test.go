package config_test

import (
	"testing"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/config"
)

func TestAutonomousScheduleDefaults(t *testing.T) {
	cfg := mustParse(t, `{
		"autonomous": {
			"schedules": [{ "cron": "0 2 * * *" }]
		},
		"items": {
			"prod": {
				"host": "127.0.0.1",
				"port": 5432,
				"user": "db_user",
				"database": "app_db"
			}
		}
	}`)
	if len(cfg.Autonomous.Schedules) != 1 {
		t.Fatalf("expected 1 schedule, got %d", len(cfg.Autonomous.Schedules))
	}
	if cfg.Autonomous.Schedules[0].UploadToS3 {
		t.Fatal("expected uploadToS3 default false")
	}
	if len(cfg.Autonomous.Schedules[0].Items) != 0 {
		t.Fatalf("expected no items filter, got %+v", cfg.Autonomous.Schedules[0].Items)
	}
}

func TestAutonomousFullSection(t *testing.T) {
	cfg := mustParse(t, `{
		"autonomous": {
			"schedules": [
				{ "cron": "0 3 * * *", "items": ["prod"], "uploadToS3": true },
				{ "cron": "0 */6 * * *" }
			]
		},
		"items": {
			"prod": {
				"host": "127.0.0.1",
				"port": 5432,
				"user": "db_user",
				"database": "app_db"
			}
		}
	}`)
	if len(cfg.Autonomous.Schedules) != 2 {
		t.Fatalf("expected 2 schedules, got %d", len(cfg.Autonomous.Schedules))
	}
	if len(cfg.Autonomous.Schedules[0].Items) != 1 || cfg.Autonomous.Schedules[0].Items[0] != "prod" {
		t.Fatalf("unexpected items: %+v", cfg.Autonomous.Schedules[0].Items)
	}
}

func TestAutonomousRejectsEmptySchedules(t *testing.T) {
	_, err := config.ParseJSONC([]byte(`{
		"autonomous": { "schedules": [] },
		"items": {}
	}`))
	if err == nil {
		t.Fatal("expected validation error for empty schedules")
	}
}

func TestAutonomousRejectsEmptyCron(t *testing.T) {
	_, err := config.ParseJSONC([]byte(`{
		"autonomous": { "schedules": [{ "cron": "" }] },
		"items": {}
	}`))
	if err == nil {
		t.Fatal("expected validation error for empty cron")
	}
}

func TestAutonomousOptionalInConfig(t *testing.T) {
	cfg := mustParse(t, `{
		"autonomous": {
			"schedules": [{ "cron": "0 1 * * *", "uploadToS3": true }]
		},
		"items": {
			"prod": {
				"host": "127.0.0.1",
				"port": 5432,
				"user": "db_user",
				"database": "app_db"
			}
		}
	}`)
	if cfg.Autonomous.Schedules[0].Cron != "0 1 * * *" {
		t.Fatalf("unexpected cron: %s", cfg.Autonomous.Schedules[0].Cron)
	}
}

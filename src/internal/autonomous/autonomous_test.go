package autonomous_test

import (
	"strings"
	"testing"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/autonomous"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/config"
)

func TestValidateCronExpression(t *testing.T) {
	if err := autonomous.ValidateCronExpression("0 2 * * *"); err != nil {
		t.Fatalf("expected valid cron: %v", err)
	}
	if err := autonomous.ValidateCronExpression("not a cron"); err == nil {
		t.Fatal("expected invalid cron error")
	}
}

func TestRunRequiresAutonomousSection(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/config.jsonc"
	if err := config.Write(path, config.DefaultConfigScaffold(false)); err != nil {
		t.Fatal(err)
	}
	err := autonomous.Run(autonomous.Options{ConfigPath: path, Once: true})
	if err == nil || !strings.Contains(err.Error(), "autonomous section missing") {
		t.Fatalf("expected missing autonomous error, got %v", err)
	}
}

func TestItemsForScheduleUnknownItem(t *testing.T) {
	cfg := config.DefaultConfigScaffold(false)
	cfg.Items["prod"] = config.DatabaseEntry{
		Host: "127.0.0.1", Port: 5432, User: "u", Database: "db",
	}
	_, err := autonomous.ItemsForSchedule(&cfg, config.AutonomousSchedule{
		Cron:  "0 2 * * *",
		Items: []string{"missing"},
	})
	if err == nil || !strings.Contains(err.Error(), `unknown item "missing"`) {
		t.Fatalf("expected unknown item error, got %v", err)
	}
}

func TestItemsForScheduleAllItemsWhenEmpty(t *testing.T) {
	cfg := config.DefaultConfigScaffold(true)
	items, err := autonomous.ItemsForSchedule(&cfg, config.AutonomousSchedule{Cron: "0 2 * * *"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) == 0 {
		t.Fatal("expected all configured items")
	}
}

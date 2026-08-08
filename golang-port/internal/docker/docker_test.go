package docker_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/docker"
)

func TestDockerHostRewrite(t *testing.T) {
	cases := map[string]string{
		"localhost":           "host.docker.internal",
		"127.0.0.1":           "host.docker.internal",
		"::1":                 "host.docker.internal",
		"postgres.internal":   "postgres.internal",
	}
	for in, want := range cases {
		if got := docker.DockerHost(in); got != want {
			t.Fatalf("dockerHost(%q) = %q, want %q", in, got, want)
		}
	}
	if docker.RestoreJobs() < 1 {
		t.Fatal("expected at least one restore job")
	}
}

func TestDebugLogsRedactPassword(t *testing.T) {
	dir := t.TempDir()
	fakeDocker := filepath.Join(dir, "docker")
	script := "#!/bin/sh\nprintf '1\\n'\n"
	if err := os.WriteFile(fakeDocker, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	oldPath := os.Getenv("PATH")
	t.Setenv("PATH", dir+string(os.PathListSeparator)+oldPath)

	var logs []string
	docker.SetDebug(true, func(msg string) { logs = append(logs, msg) })
	t.Cleanup(func() { docker.SetDebug(false, nil) })

	db := docker.ResolvedDB{
		DatabaseItem: config.DatabaseItem{
			Key: "prod", Host: "db", Port: 5432, User: "admin", Database: "app",
		},
		Password: "super-secret",
	}
	if err := docker.VerifyConnection("postgres:18", "source", "prod", db, ""); err != nil {
		t.Fatal(err)
	}
	exists, err := docker.DatabaseExists("postgres:18", db, "")
	if err != nil || !exists {
		t.Fatalf("databaseExists: exists=%v err=%v", exists, err)
	}
	joined := strings.Join(logs, "\n")
	if !strings.Contains(joined, "PGPASSWORD=***") {
		t.Fatalf("expected redacted password in logs: %s", joined)
	}
	if strings.Contains(joined, "super-secret") {
		t.Fatalf("password leaked in logs: %s", joined)
	}
}

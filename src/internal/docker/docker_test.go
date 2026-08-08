package docker_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/docker"
)

func TestDockerHostRewrite(t *testing.T) {
	cases := map[string]string{
		"localhost":         "host.docker.internal",
		"127.0.0.1":         "host.docker.internal",
		"::1":               "host.docker.internal",
		"postgres.internal": "postgres.internal",
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

func TestDockerRunHostArgs(t *testing.T) {
	if runtime.GOOS == "linux" {
		args := docker.DockerRunHostArgs("localhost")
		if len(args) != 2 || args[0] != "--add-host" || args[1] != "host.docker.internal:host-gateway" {
			t.Fatalf("unexpected host-gateway args on linux: %v", args)
		}
	} else {
		if len(docker.DockerRunHostArgs("localhost")) != 0 {
			t.Fatal("expected no host-gateway args off linux")
		}
	}
	if len(docker.DockerRunHostArgs("postgres.internal")) != 0 {
		t.Fatal("expected no host-gateway for non-loopback host")
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

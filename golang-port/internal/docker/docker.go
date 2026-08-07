package docker

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/config"
)

const DumpCompress = "zstd:5"

type ResolvedDB struct {
	config.DatabaseItem
	Password string
}

var (
	debugEnabled bool
	debugLog     = func(string) {}
)

func SetDebug(enabled bool, log func(string)) {
	debugEnabled = enabled
	if enabled && log != nil {
		debugLog = log
	} else {
		debugLog = func(string) {}
	}
}

func AssertAvailable() error {
	cmd := exec.Command("docker", "info")
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker is not available")
	}
	return nil
}

func DockerHost(host string) string {
	h := strings.ToLower(host)
	switch h {
	case "localhost", "127.0.0.1", "::1":
		return "host.docker.internal"
	default:
		return host
	}
}

func RestoreJobs() int {
	n := runtime.NumCPU()
	if n > 8 {
		return 8
	}
	if n < 1 {
		return 1
	}
	return n
}

func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func quoteLiteral(value string) string {
	return `'` + strings.ReplaceAll(value, `'`, `''`) + `'`
}

func formatDockerCmd(args []string) string {
	var parts []string
	parts = append(parts, "docker")
	for _, a := range args {
		shown := a
		if strings.HasPrefix(a, "PGPASSWORD=") {
			idx := strings.Index(a, "=")
			shown = a[:idx+1] + "***"
		}
		if strings.ContainsAny(shown, " \t") {
			parts = append(parts, fmt.Sprintf("%q", shown))
		} else {
			parts = append(parts, shown)
		}
	}
	return strings.Join(parts, " ")
}

func runDocker(args []string, quiet bool) (int, string, string, error) {
	if debugEnabled {
		debugLog("[debug] " + formatDockerCmd(args))
	}
	cmd := exec.Command("docker", args...)
	cmd.Env = os.Environ()
	cmd.Stdin = nil
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return 0, "", "", err
		}
	}
	if !quiet {
		_, _ = os.Stdout.Write(stdout.Bytes())
		_, _ = os.Stderr.Write(stderr.Bytes())
	}
	return exitCode, stdout.String(), stderr.String(), nil
}

func needsHostGateway(host string) bool {
	return runtime.GOOS == "linux" && DockerHost(host) == "host.docker.internal"
}

// DockerRunHostArgs returns extra docker run flags for Linux loopback hosts.
func DockerRunHostArgs(host string) []string {
	if needsHostGateway(host) {
		return []string{"--add-host", "host.docker.internal:host-gateway"}
	}
	return nil
}

func pgBaseArgs(image, password, volume, dbHost string) []string {
	args := []string{"run", "--rm", "-e", "PGPASSWORD=" + password}
	if network := os.Getenv("DUMPMGR_DOCKER_NETWORK"); network != "" {
		args = append(args, "--network", network)
	}
	if dbHost != "" {
		args = append(args, DockerRunHostArgs(dbHost)...)
	}
	if volume != "" {
		args = append(args, "-v", volume)
	}
	args = append(args, image)
	return args
}

func maintenanceDB() string {
	return "postgres"
}

func VerifyConnection(image, role, label string, db ResolvedDB, database string) error {
	if database == "" {
		database = db.Database
	}
	host := DockerHost(db.Host)
	args := append(pgBaseArgs(image, db.Password, "", db.Host),
		"psql",
		"--host", host,
		"--port", fmt.Sprintf("%d", db.Port),
		"--username", db.User,
		"--dbname", database,
		"-tAc", "SELECT 1",
	)
	exitCode, stdout, stderr, err := runDocker(args, true)
	if err != nil {
		return err
	}
	if exitCode != 0 || strings.TrimSpace(stdout) != "1" {
		return fmt.Errorf("cannot connect to %s %q (%s@%s:%d/%s):\n%s",
			role, label, db.User, db.Host, db.Port, database, strings.TrimSpace(stderr+stdout))
	}
	return nil
}

func DatabaseExists(image string, db ResolvedDB, connectDatabase string) (bool, error) {
	if connectDatabase == "" {
		connectDatabase = maintenanceDB()
	}
	host := DockerHost(db.Host)
	esc := strings.ReplaceAll(db.Database, "'", "''")
	sql := fmt.Sprintf("SELECT 1 FROM pg_database WHERE datname='%s'", esc)
	args := append(pgBaseArgs(image, db.Password, "", db.Host),
		"psql",
		"--host", host,
		"--port", fmt.Sprintf("%d", db.Port),
		"--username", db.User,
		"--dbname", connectDatabase,
		"-tAc", sql,
	)
	exitCode, stdout, stderr, err := runDocker(args, true)
	if err != nil {
		return false, err
	}
	if exitCode != 0 {
		return false, fmt.Errorf("failed to check if database exists on %s:%d:\n%s",
			db.Host, db.Port, strings.TrimSpace(stderr+stdout))
	}
	return strings.TrimSpace(stdout) == "1", nil
}

func CreateDatabase(image string, db ResolvedDB, connectDatabase string) error {
	if connectDatabase == "" {
		connectDatabase = maintenanceDB()
	}
	host := DockerHost(db.Host)
	sql := fmt.Sprintf("CREATE DATABASE %s", quoteIdent(db.Database))
	args := append(pgBaseArgs(image, db.Password, "", db.Host),
		"psql",
		"--host", host,
		"--port", fmt.Sprintf("%d", db.Port),
		"--username", db.User,
		"--dbname", connectDatabase,
		"-v", "ON_ERROR_STOP=1",
		"-c", sql,
	)
	exitCode, stdout, stderr, err := runDocker(args, true)
	if err != nil {
		return err
	}
	if exitCode != 0 {
		return fmt.Errorf("failed to create database %q:\n%s", db.Database, strings.TrimSpace(stderr+stdout))
	}
	return nil
}

func DropDatabase(image string, db ResolvedDB, connectDatabase string) error {
	if connectDatabase == "" {
		connectDatabase = maintenanceDB()
	}
	host := DockerHost(db.Host)
	esc := strings.ReplaceAll(db.Database, "'", "''")
	statements := []string{
		fmt.Sprintf("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='%s' AND pid <> pg_backend_pid()", esc),
		fmt.Sprintf("DROP DATABASE IF EXISTS %s", quoteIdent(db.Database)),
	}
	for _, sql := range statements {
		args := append(pgBaseArgs(image, db.Password, "", db.Host),
			"psql",
			"--host", host,
			"--port", fmt.Sprintf("%d", db.Port),
			"--username", db.User,
			"--dbname", connectDatabase,
			"-v", "ON_ERROR_STOP=1",
			"-c", sql,
		)
		exitCode, stdout, stderr, err := runDocker(args, true)
		if err != nil {
			return err
		}
		if exitCode != 0 {
			return fmt.Errorf("failed to drop database %q:\n%s", db.Database, strings.TrimSpace(stderr+stdout))
		}
	}
	return nil
}

type EnsureLoginOpts struct {
	User            string
	Password        string
	Database        string
	ConnectDatabase string
}

func EnsureDatabaseLogin(image string, parentDB ResolvedDB, opts EnsureLoginOpts) error {
	host := DockerHost(parentDB.Host)
	loginDB := opts.ConnectDatabase
	if loginDB == "" {
		loginDB = maintenanceDB()
	}
	role := quoteIdent(opts.User)
	roleLit := quoteLiteral(opts.User)
	pwLit := quoteLiteral(opts.Password)
	dbIdent := quoteIdent(opts.Database)
	ensureRole := fmt.Sprintf(
		`DO $dumpmgr$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %s) THEN CREATE ROLE %s LOGIN PASSWORD %s; ELSE ALTER ROLE %s PASSWORD %s; END IF; END $dumpmgr$`,
		roleLit, role, pwLit, role, pwLit,
	)
	grantDB := fmt.Sprintf("GRANT ALL PRIVILEGES ON DATABASE %s TO %s", dbIdent, role)
	grantSchema := fmt.Sprintf("GRANT ALL ON SCHEMA public TO %s", role)
	steps := []struct {
		sql    string
		dbname string
	}{
		{ensureRole, loginDB},
		{grantDB, loginDB},
		{grantSchema, opts.Database},
	}
	for _, step := range steps {
		args := append(pgBaseArgs(image, parentDB.Password, "", parentDB.Host),
			"psql",
			"--host", host,
			"--port", fmt.Sprintf("%d", parentDB.Port),
			"--username", parentDB.User,
			"--dbname", step.dbname,
			"-v", "ON_ERROR_STOP=1",
			"-c", step.sql,
		)
		exitCode, stdout, stderr, err := runDocker(args, true)
		if err != nil {
			return err
		}
		if exitCode != 0 {
			return fmt.Errorf("failed to ensure login %q on %q:\n%s", opts.User, opts.Database, strings.TrimSpace(stderr+stdout))
		}
	}
	return nil
}

func DumpDatabase(image string, db ResolvedDB, workdir, dumpFileName string) error {
	absWorkdir, err := filepath.Abs(workdir)
	if err != nil {
		return err
	}
	volume := absWorkdir + ":/backup"
	host := DockerHost(db.Host)
	out := "/backup/" + dumpFileName
	args := append(pgBaseArgs(image, db.Password, volume, db.Host),
		"pg_dump",
		fmt.Sprintf("--host=%s", host),
		fmt.Sprintf("--port=%d", db.Port),
		fmt.Sprintf("--username=%s", db.User),
		fmt.Sprintf("--dbname=%s", db.Database),
		"--format=custom",
		fmt.Sprintf("--compress=%s", DumpCompress),
		fmt.Sprintf("--file=%s", out),
	)
	exitCode, stdout, stderr, err := runDocker(args, true)
	if err != nil {
		return err
	}
	if exitCode != 0 {
		return fmt.Errorf("pg_dump failed for %s@%s/%s:\n%s", db.User, db.Host, db.Database, strings.TrimSpace(stderr+stdout))
	}
	return nil
}

type RestoreOpts struct {
	Clean bool
}

type RestoreResult struct {
	Warnings string
}

var pgRestoreErrorRE = regexp.MustCompile(`(?i)pg_restore:\s*error:|ERROR:`)

func RestoreDatabase(image string, db ResolvedDB, workdir, dumpFileName string, opts RestoreOpts) (RestoreResult, error) {
	absWorkdir, err := filepath.Abs(workdir)
	if err != nil {
		return RestoreResult{}, err
	}
	volume := absWorkdir + ":/backup"
	host := DockerHost(db.Host)
	input := "/backup/" + dumpFileName
	args := append(pgBaseArgs(image, db.Password, volume, db.Host),
		"pg_restore",
		fmt.Sprintf("--host=%s", host),
		fmt.Sprintf("--port=%d", db.Port),
		fmt.Sprintf("--username=%s", db.User),
		fmt.Sprintf("--dbname=%s", db.Database),
	)
	if opts.Clean {
		args = append(args, "--clean", "--if-exists")
	}
	args = append(args, "--no-owner", "--no-acl", fmt.Sprintf("--jobs=%d", RestoreJobs()), input)
	exitCode, stdout, stderr, err := runDocker(args, true)
	if err != nil {
		return RestoreResult{}, err
	}
	out := strings.TrimSpace(stderr + stdout)
	if exitCode == 0 {
		return RestoreResult{}, nil
	}
	if exitCode > 1 || strings.Contains(strings.ToUpper(out), "FATAL:") {
		return RestoreResult{}, fmt.Errorf("pg_restore failed for %s@%s/%s:\n%s", db.User, db.Host, db.Database, out)
	}
	if exitCode == 1 {
		hasError := pgRestoreErrorRE.MatchString(out)
		errorsIgnored := strings.Contains(strings.ToLower(out), "errors ignored on restore")
		if hasError && !errorsIgnored {
			return RestoreResult{}, fmt.Errorf("pg_restore failed for %s@%s/%s:\n%s", db.User, db.Host, db.Database, out)
		}
		if hasError && errorsIgnored && out != "" {
			return RestoreResult{Warnings: out}, nil
		}
		return RestoreResult{}, nil
	}
	return RestoreResult{}, fmt.Errorf("pg_restore failed for %s@%s/%s:\n%s", db.User, db.Host, db.Database, out)
}

func Version() (string, error) {
	cmd := exec.Command("docker", "--version")
	out, err := cmd.Output()
	if err != nil {
		return "docker present (version unknown)", nil
	}
	s := strings.TrimSpace(string(out))
	if s == "" {
		return "docker present", nil
	}
	return s, nil
}

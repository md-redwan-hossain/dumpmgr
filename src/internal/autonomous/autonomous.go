package autonomous

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/docker"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/dumps"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/metadata"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/s3"
	"github.com/robfig/cron/v3"
)

const (
	MasterPasswordEnv = "DUMPMGR_MASTER_PASSWORD"
	S3SecretKeyEnv    = "DUMPMGR_S3_SECRET_KEY"
)

var cronParser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)

type Options struct {
	ConfigPath string
	Debug      bool
	Once       bool
}

func logf(format string, args ...any) {
	ts := time.Now().UTC().Format(time.RFC3339)
	fmt.Printf("[%s] "+format+"\n", append([]any{ts}, args...)...)
}

func logError(format string, args ...any) {
	ts := time.Now().UTC().Format(time.RFC3339)
	fmt.Fprintf(os.Stderr, "[%s] ERROR "+format+"\n", append([]any{ts}, args...)...)
}

func masterPasswordFromEnv() string {
	return strings.TrimSpace(os.Getenv(MasterPasswordEnv))
}

func s3SecretKeyFromEnv() string {
	return strings.TrimSpace(os.Getenv(S3SecretKeyEnv))
}

func unlockAutonomousSession(cfg *config.Config, configPath string) (*metadata.Session, error) {
	if !config.NeedsMaster(cfg) {
		return nil, nil
	}
	master := masterPasswordFromEnv()
	if master == "" {
		return nil, fmt.Errorf("%s is required for autonomous mode when rememberPassword, encryptedDump, or s3Options are enabled", MasterPasswordEnv)
	}
	return metadata.Unlock(configPath, master)
}

func resolveS3SecretKey(session *metadata.Session) (string, error) {
	if session != nil {
		stored, err := metadata.GetS3SecretKey(session)
		if err != nil {
			return "", err
		}
		if stored != "" {
			return stored, nil
		}
	}
	if key := s3SecretKeyFromEnv(); key != "" {
		return key, nil
	}
	return "", nil
}

func resolveItemPassword(cfg *config.Config, session *metadata.Session, item config.DatabaseItem) (string, error) {
	if cfg.RememberPassword && session != nil {
		saved, err := metadata.GetDBPassword(session, config.DBKey(item.Key))
		if err != nil {
			return "", err
		}
		if saved != "" {
			return saved, nil
		}
	}
	return "", fmt.Errorf(`no saved password for "%s". Run interactive dumpmgr once to store credentials in metadata`, item.Key)
}

func itemsForSchedule(cfg *config.Config, schedule config.AutonomousSchedule) ([]config.DatabaseItem, error) {
	all := config.ConfigItems(cfg)
	if len(schedule.Items) == 0 {
		return all, nil
	}
	byKey := make(map[string]config.DatabaseItem, len(all))
	for _, item := range all {
		byKey[item.Key] = item
	}
	selected := make([]config.DatabaseItem, 0, len(schedule.Items))
	for _, key := range schedule.Items {
		item, ok := byKey[key]
		if !ok {
			return nil, fmt.Errorf(`autonomous schedule references unknown item "%s"`, key)
		}
		selected = append(selected, item)
	}
	return selected, nil
}

type scheduledDumpOpts struct {
	Config      *config.Config
	Session     *metadata.Session
	Item        config.DatabaseItem
	UploadToS3  bool
	S3SecretKey string
}

func runScheduledDumpForItem(opts scheduledDumpOpts) (string, error) {
	cfg := opts.Config
	session := opts.Session
	item := opts.Item
	image := config.ConfigImage(cfg)
	dumpsRoot := dumps.ResolveRoot(cfg.DumpDirectory)
	if err := dumps.EnsureRootWritable(dumpsRoot); err != nil {
		return "", err
	}

	password, err := resolveItemPassword(cfg, session, item)
	if err != nil {
		return "", err
	}
	db := docker.ResolvedDB{DatabaseItem: item, Password: password}

	logf("Verifying connection to %s…", item.Key)
	if err := docker.VerifyConnection(image, "source", item.Key, db, ""); err != nil {
		return "", err
	}

	dir := dumps.DBDumpDir(dumpsRoot, item.Key)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	plainName := dumps.NewDumpFileName(item.Key)
	dumpPath := filepath.Join(dir, plainName)

	logf("Dumping %s → %s", item.Key, plainName)
	t0 := time.Now()
	if err := docker.DumpDatabase(image, db, dir, plainName); err != nil {
		return "", err
	}
	elapsed := time.Since(t0)
	size, _ := dumps.FileSize(dumpPath)
	logf("Dump complete for %s in %s (%s)", item.Key, dumps.FormatDuration(float64(elapsed.Milliseconds())), dumps.FormatBytes(size))

	finalPath := dumpPath
	if cfg.EncryptedDump {
		if session == nil || session.AESKey == nil {
			return "", fmt.Errorf("AES key required for encrypted dumps")
		}
		encID, err := metadata.EncID(session)
		if err != nil || encID == "" {
			return "", fmt.Errorf("encId missing from vault")
		}
		logf("Encrypting dump for %s…", item.Key)
		finalPath, err = dumps.EncryptDumpFile(dumpPath, session.AESKey, encID)
		if err != nil {
			return "", err
		}
		encSize, _ := dumps.FileSize(finalPath)
		logf("Encrypted %s (%s)", filepath.Base(finalPath), dumps.FormatBytes(encSize))
	}

	if opts.UploadToS3 && cfg.S3Options != nil {
		secretKey := opts.S3SecretKey
		if secretKey == "" {
			var err error
			secretKey, err = resolveS3SecretKey(session)
			if err != nil {
				return "", err
			}
		}
		if secretKey == "" {
			return "", fmt.Errorf("S3 upload requested but no secret key in metadata or %s", S3SecretKeyEnv)
		}
		ctx := context.Background()
		if err := s3.VerifyBucket(ctx, *cfg.S3Options, secretKey); err != nil {
			return "", err
		}
		client, err := s3.NewClient(*cfg.S3Options, secretKey)
		if err != nil {
			return "", err
		}
		key, err := s3.Upload(ctx, client, cfg.S3Options.BucketName, dumpsRoot, finalPath)
		if err != nil {
			return "", err
		}
		logf("Uploaded %s to %s", key, cfg.S3Options.BucketName)
	}

	return finalPath, nil
}

func runSchedule(cfg *config.Config, schedule config.AutonomousSchedule, session *metadata.Session, s3SecretKey string) error {
	logf("Running schedule %s", schedule.Cron)
	items, err := itemsForSchedule(cfg, schedule)
	if err != nil {
		return err
	}
	s3Key := s3SecretKey
	if schedule.UploadToS3 && cfg.S3Options != nil && s3Key == "" {
		s3Key, err = resolveS3SecretKey(session)
		if err != nil {
			return err
		}
	}
	for _, item := range items {
		if _, err := runScheduledDumpForItem(scheduledDumpOpts{
			Config:      cfg,
			Session:     session,
			Item:        item,
			UploadToS3:  schedule.UploadToS3,
			S3SecretKey: s3Key,
		}); err != nil {
			logError("Failed to dump %s: %v", item.Key, err)
		}
	}
	return nil
}

func validateCronExpression(expression string) error {
	if _, err := cronParser.Parse(expression); err != nil {
		return fmt.Errorf(`invalid cron expression "%s": %w`, expression, err)
	}
	return nil
}

// ValidateCronExpression checks a standard 5-field cron expression.
func ValidateCronExpression(expression string) error {
	return validateCronExpression(expression)
}

// ItemsForSchedule resolves configured database items for a schedule entry.
func ItemsForSchedule(cfg *config.Config, schedule config.AutonomousSchedule) ([]config.DatabaseItem, error) {
	return itemsForSchedule(cfg, schedule)
}

func nextCronRun(expression string) string {
	schedule, err := cronParser.Parse(expression)
	if err != nil {
		return "unknown"
	}
	next := schedule.Next(time.Now())
	if next.IsZero() {
		return "unknown"
	}
	return next.UTC().Format(time.RFC3339)
}

// Run starts the autonomous backup scheduler or runs all schedules once.
func Run(opts Options) error {
	if opts.Debug {
		docker.SetDebug(true, func(msg string) { logf("[debug] %s", msg) })
	}

	configPath := config.ResolvePath(opts.ConfigPath)
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	if cfg.Autonomous == nil {
		return fmt.Errorf("autonomous section missing in config.jsonc. Add schedules to enable autonomous backups")
	}
	if len(cfg.Autonomous.Schedules) == 0 {
		return fmt.Errorf("autonomous.schedules must contain at least one entry")
	}
	for _, schedule := range cfg.Autonomous.Schedules {
		if err := validateCronExpression(schedule.Cron); err != nil {
			return err
		}
	}

	if err := docker.AssertAvailable(); err != nil {
		return err
	}
	session, err := unlockAutonomousSession(cfg, configPath)
	if err != nil {
		return err
	}
	if session != nil {
		defer session.Close()
	}
	var s3SecretKey string
	if cfg.S3Options != nil {
		s3SecretKey, err = resolveS3SecretKey(session)
		if err != nil {
			return err
		}
	}

	logf("Autonomous mode started (%d schedule(s), once=%v)", len(cfg.Autonomous.Schedules), opts.Once)

	if opts.Once {
		for _, schedule := range cfg.Autonomous.Schedules {
			if err := runSchedule(cfg, schedule, session, s3SecretKey); err != nil {
				return err
			}
		}
		logf("Autonomous one-shot run complete")
		return nil
	}

	c := cron.New()
	for _, schedule := range cfg.Autonomous.Schedules {
		sched := schedule
		if _, err := c.AddFunc(sched.Cron, func() {
			_ = runSchedule(cfg, sched, session, s3SecretKey)
		}); err != nil {
			return err
		}
		logf(`Registered cron "%s" (next: %s)`, sched.Cron, nextCronRun(sched.Cron))
	}
	c.Start()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	logf("Scheduler running; waiting for cron triggers")
	<-sigCh
	logf("Stopping autonomous scheduler…")
	stopCtx := c.Stop()
	<-stopCtx.Done()
	return nil
}

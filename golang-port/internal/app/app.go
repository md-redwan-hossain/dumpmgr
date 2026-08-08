package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/briandowns/spinner"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/docker"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/dumps"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/initcmd"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/metadata"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/prompt"
	"github.com/md-redwan-hossain/dumpmgr/golang-port/internal/s3"
)

type Mode string

const (
	ModeDump         Mode = "dump"
	ModeRestore      Mode = "restore"
	ModeDumpRestore  Mode = "dump-restore"
)

type Options struct {
	ConfigPath string
	Yes        bool
	Debug      bool
	Mode       Mode
}

type S3Action string

const (
	S3Upload   S3Action = "upload"
	S3Download S3Action = "download"
)

func Intro() {
	fmt.Println("dumpmgr — Dump Manager, docker based db dump & restore tool")
}

func UnlockOrNull(cfg *config.Config, configPath string) (*metadata.Session, error) {
	if !config.NeedsMaster(cfg) {
		return nil, nil
	}
	metaPath := metadata.PathForConfig(configPath)
	for {
		master, err := prompt.Password("master password")
		if err != nil {
			return nil, err
		}
		session, err := metadata.Unlock(metaPath, master)
		if err == nil {
			return session, nil
		}
		fmt.Printf("✗ %v\n", err)
		again, err := prompt.TryAgain()
		if err != nil || !again {
			prompt.OnCancel()
		}
	}
}

func requireS3Session(cfg *config.Config, configPath string) (*metadata.Session, string, error) {
	if cfg.S3Options == nil {
		return nil, "", fmt.Errorf("S3 is not configured. Add s3Options to config.jsonc")
	}
	session, err := UnlockOrNull(cfg, configPath)
	if err != nil {
		return nil, "", err
	}
	if session == nil {
		return nil, "", fmt.Errorf("master password session required for S3")
	}
	secret, err := metadata.GetS3SecretKey(session)
	if err != nil {
		return nil, "", err
	}
	if secret == "" {
		secret, err = prompt.Password("S3 secret access key")
		if err != nil {
			return nil, "", err
		}
		if err := metadata.SetS3SecretKey(session, secret); err != nil {
			return nil, "", err
		}
		fmt.Println("✓ S3 secret access key encrypted in metadata")
	}
	return session, secret, nil
}

func RunS3Action(action S3Action, cfg *config.Config, configPath string, yes bool) error {
	if cfg.S3Options == nil {
		return fmt.Errorf("S3 is not configured. Add s3Options to config.jsonc")
	}
	_, secret, err := requireS3Session(cfg, configPath)
	if err != nil {
		return err
	}
	ctx := context.Background()
	if err := s3.VerifyBucket(ctx, *cfg.S3Options, secret); err != nil {
		return err
	}
	client, err := s3.NewClient(*cfg.S3Options, secret)
	if err != nil {
		return err
	}
	dumpsRoot := dumps.ResolveRoot(cfg.DumpDirectory)
	if err := dumps.EnsureRootWritable(dumpsRoot); err != nil {
		return err
	}

	if action == S3Upload {
		localPath, err := prompt.BrowseDumpFile(dumpsRoot, cfg.EncryptedDump)
		if err != nil {
			return err
		}
		key, err := s3.Upload(ctx, client, cfg.S3Options.BucketName, dumpsRoot, localPath)
		if err != nil {
			return err
		}
		fmt.Printf("✓ Uploaded %s to %s\n", key, cfg.S3Options.BucketName)
		return nil
	}

	objects, err := s3.ListObjects(ctx, *cfg.S3Options, secret)
	if err != nil {
		return err
	}
	key, err := prompt.SelectS3Object(objects)
	if err != nil {
		return err
	}
	target, err := s3.LocalPathForObject(dumpsRoot, key)
	if err != nil {
		return err
	}
	if _, err := os.Stat(target); err == nil && !yes {
		overwrite, err := prompt.ConfirmOverwrite(target)
		if err != nil {
			return err
		}
		if !overwrite {
			fmt.Println("⚠ Download cancelled")
			return nil
		}
	}
	downloaded, err := s3.Download(ctx, client, cfg.S3Options.BucketName, dumpsRoot, key)
	if err != nil {
		return err
	}
	fmt.Printf("✓ Downloaded %s to %s\n", key, downloaded)
	return nil
}

func resolveConnectedDB(cfg *config.Config, session *metadata.Session, item config.DatabaseItem, role string, maintenance bool) (docker.ResolvedDB, error) {
	image := config.ConfigImage(cfg)
	key := config.DBKey(item.Key)
	password, err := prompt.ConnectWithRetry(
		item.Key,
		func() (string, error) {
			return prompt.ResolveDBPassword(session, cfg.RememberPassword, item)
		},
		func(pw string) error {
			if cfg.RememberPassword && session != nil {
				return metadata.SetDBPassword(session, key, pw)
			}
			return nil
		},
		func(pw string) error {
			db := docker.ResolvedDB{DatabaseItem: item, Password: pw}
			database := ""
			if maintenance {
				database = "postgres"
			}
			return docker.VerifyConnection(image, role, item.Key, db, database)
		},
	)
	if err != nil {
		return docker.ResolvedDB{}, err
	}
	return docker.ResolvedDB{DatabaseItem: item, Password: password}, nil
}

func runDumpWithSpinner(image string, db docker.ResolvedDB, workdir, dumpFileName, label string) (float64, int64, string, error) {
	dumpPath := filepath.Join(workdir, dumpFileName)
	s := spinner.New(spinner.CharSets[14], 100*time.Millisecond)
	s.Prefix = fmt.Sprintf("Dumping %s… 0.0s", label)
	s.Start()
	t0 := time.Now()
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.Prefix = fmt.Sprintf("Dumping %s… %s", label, dumps.FormatDuration(float64(time.Since(t0).Milliseconds())))
			case <-done:
				return
			}
		}
	}()
	err := docker.DumpDatabase(image, db, workdir, dumpFileName)
	close(done)
	elapsed := float64(time.Since(t0).Milliseconds())
	if err != nil {
		s.Stop()
		return 0, 0, "", err
	}
	size, _ := dumps.FileSize(dumpPath)
	s.FinalMSG = fmt.Sprintf("✓ Dump complete in %s (%s)", dumps.FormatDuration(elapsed), dumps.FormatBytes(size))
	s.Stop()
	return elapsed, size, dumpPath, nil
}

func runRestoreWithSpinner(image string, db docker.ResolvedDB, workdir, dumpFileName, label string, clean bool) (float64, string, error) {
	jobsHint := fmt.Sprintf(" (--jobs %d)", docker.RestoreJobs())
	s := spinner.New(spinner.CharSets[14], 100*time.Millisecond)
	s.Prefix = fmt.Sprintf("Restoring %s%s… 0.0s", label, jobsHint)
	s.Start()
	t0 := time.Now()
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.Prefix = fmt.Sprintf("Restoring %s%s… %s", label, jobsHint, dumps.FormatDuration(float64(time.Since(t0).Milliseconds())))
			case <-done:
				return
			}
		}
	}()
	result, err := docker.RestoreDatabase(image, db, workdir, dumpFileName, docker.RestoreOpts{Clean: clean})
	close(done)
	elapsed := float64(time.Since(t0).Milliseconds())
	if err != nil {
		s.Stop()
		return 0, "", err
	}
	s.FinalMSG = fmt.Sprintf("✓ Restore complete in %s", dumps.FormatDuration(elapsed))
	s.Stop()
	if result.Warnings != "" {
		fmt.Printf("⚠ pg_restore reported ignored errors:\n%s\n", result.Warnings)
	}
	return elapsed, result.Warnings, nil
}

func ensureDestDatabase(cfg *config.Config, dest docker.ResolvedDB, destName string, yes bool) (bool, error) {
	image := config.ConfigImage(cfg)
	exists, err := docker.DatabaseExists(image, dest, "")
	if err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}
	create, err := prompt.ConfirmOrYes(
		fmt.Sprintf(`Database "%s" does not exist on destination (%s). Create it?`, dest.Database, destName),
		yes, false,
	)
	if err != nil {
		return false, err
	}
	if !create {
		return false, fmt.Errorf("destination database does not exist. Aborted")
	}
	fmt.Printf("→ Creating database %q…\n", dest.Database)
	if err := docker.CreateDatabase(image, dest, ""); err != nil {
		return false, err
	}
	fmt.Printf("✓ Created %q\n", dest.Database)
	return true, nil
}

func handleChangeMaster(cfg *config.Config, session *metadata.Session) (*metadata.Session, error) {
	next, err := prompt.Password("new master password")
	if err != nil {
		return nil, err
	}
	confirm, err := prompt.Password("confirm new master password")
	if err != nil {
		return nil, err
	}
	if next != confirm {
		return nil, fmt.Errorf("master passwords do not match")
	}

	oldKey := session.AESKey
	encID := ""
	if session.Metadata.EncID != nil {
		encID = *session.Metadata.EncID
	}
	fmt.Println("→ Re-encrypting saved database passwords…")
	updated, err := metadata.ChangeMasterPassword(session, next)
	if err != nil {
		return nil, err
	}
	fmt.Println("✓ Database passwords re-encrypted")

	dumpsRoot := dumps.ResolveRoot(cfg.DumpDirectory)
	if encID != "" {
		has, err := dumps.HasEncryptedDumpsWithEncID(dumpsRoot, encID)
		if err != nil {
			return nil, err
		}
		if has {
			action, err := prompt.SelectEncryptedDumpAction()
			if err != nil {
				return nil, err
			}
			if action == "delete" {
				n, err := dumps.DeleteEncryptedDumpsWithEncID(dumpsRoot, encID)
				if err != nil {
					return nil, err
				}
				fmt.Printf("✓ Deleted %d encrypted dump(s)\n", n)
			} else {
				if err := dumps.EnsureRootWritable(dumpsRoot); err != nil {
					return nil, err
				}
				n, err := dumps.ReencryptAllDumps(dumpsRoot, oldKey, updated.AESKey, encID)
				if err != nil {
					return nil, err
				}
				fmt.Printf("✓ Re-encrypted %d dump file(s)\n", n)
			}
		}
	}
	fmt.Println("✓ Master password changed")
	return updated, nil
}

func RunMode(mode Mode, opts Options, cfg *config.Config, session *metadata.Session) error {
	minItems := 1
	if mode == ModeDumpRestore {
		minItems = 2
	}
	if err := prompt.RequireItems(cfg, minItems); err != nil {
		return err
	}
	items := config.ConfigItems(cfg)
	image := config.ConfigImage(cfg)
	dumpsRoot := dumps.ResolveRoot(cfg.DumpDirectory)
	if err := dumps.EnsureRootWritable(dumpsRoot); err != nil {
		return err
	}

	switch mode {
	case ModeDump:
		return runDump(opts, cfg, session, items, image, dumpsRoot)
	case ModeRestore:
		return runRestore(opts, cfg, session, image, dumpsRoot)
	case ModeDumpRestore:
		return runDumpRestore(opts, cfg, session, items, image, dumpsRoot)
	default:
		return fmt.Errorf("unknown mode: %s", mode)
	}
}

func runDump(opts Options, cfg *config.Config, session *metadata.Session, items []config.DatabaseItem, image, dumpsRoot string) error {
	sourceItem, err := prompt.SelectDatabaseItem(items, "Select database to dump", "")
	if err != nil {
		return err
	}
	sourceDB, err := resolveConnectedDB(cfg, session, sourceItem, "source", false)
	if err != nil {
		return err
	}
	dir := dumps.DBDumpDir(dumpsRoot, sourceItem.Key)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	plainName := dumps.NewDumpFileName(sourceItem.Key)
	_, _, dumpPath, err := runDumpWithSpinner(image, sourceDB, dir, plainName, sourceItem.Key)
	if err != nil {
		return err
	}
	finalPath := dumpPath
	if cfg.EncryptedDump {
		if session == nil || session.AESKey == nil {
			return fmt.Errorf("AES key required for encrypted dumps")
		}
		if session.Metadata.EncID == nil || *session.Metadata.EncID == "" {
			return fmt.Errorf("encId missing from metadata")
		}
		fmt.Println("→ Encrypting dump…")
		finalPath, err = dumps.EncryptDumpFile(dumpPath, session.AESKey, *session.Metadata.EncID)
		if err != nil {
			return err
		}
		size, _ := dumps.FileSize(finalPath)
		fmt.Printf("✓ Encrypted (%s)\n", dumps.FormatBytes(size))
	}
	fmt.Printf("✓ Dump saved at %s\n", finalPath)
	return nil
}

func runRestore(opts Options, cfg *config.Config, session *metadata.Session, image, dumpsRoot string) error {
	dumpPath, err := prompt.BrowseDumpFile(dumpsRoot, cfg.EncryptedDump)
	if err != nil {
		return err
	}
	fileName := filepath.Base(dumpPath)
	dir := filepath.Dir(dumpPath)

	destItem, err := prompt.SelectDatabaseTree(cfg, "Select destination database", "")
	if err != nil {
		return err
	}

	var destDB docker.ResolvedDB
	intoExisting := false

	if destItem.Nested && destItem.ParentKey != "" {
		parentItem := config.GetParentItem(cfg, destItem.ParentKey)
		if parentItem == nil {
			return fmt.Errorf(`nested destination %q needs parent %q with user+database for connection verify`, destItem.Key, destItem.ParentKey)
		}
		fmt.Printf("→ Verifying parent %q…\n", parentItem.Key)
		parentDB, err := resolveConnectedDB(cfg, session, *parentItem, "destination", false)
		if err != nil {
			return err
		}
		fmt.Printf("✓ Parent %q OK\n", parentItem.Key)

		parentLogin := parentDB.Database
		childTarget := docker.ResolvedDB{
			DatabaseItem: config.DatabaseItem{
				Key: destItem.Key, Host: parentDB.Host, Port: parentDB.Port,
				User: parentDB.User, Database: destItem.Database, Nested: true, ParentKey: destItem.ParentKey,
			},
			Password: parentDB.Password,
		}
		childExists, err := docker.DatabaseExists(image, childTarget, parentLogin)
		if err != nil {
			return err
		}
		action, err := prompt.SelectNestedRestoreAction(fmt.Sprintf(`Restore %q into %q?`, fileName, destItem.Key), childExists)
		if err != nil {
			return err
		}
		if action == prompt.NestedNo {
			fmt.Println("⚠ Restore cancelled")
			return nil
		}
		if action == prompt.NestedDrop {
			fmt.Printf("→ Dropping database %q…\n", destItem.Database)
			if err := docker.DropDatabase(image, childTarget, parentLogin); err != nil {
				return err
			}
			fmt.Printf("→ Creating database %q…\n", destItem.Database)
			if err := docker.CreateDatabase(image, childTarget, parentLogin); err != nil {
				return err
			}
			fmt.Printf("✓ Recreated %q\n", destItem.Database)
		} else if action == prompt.NestedCreate {
			fmt.Printf("→ Creating database %q…\n", destItem.Database)
			if err := docker.CreateDatabase(image, childTarget, parentLogin); err != nil {
				return err
			}
			fmt.Printf("✓ Created %q\n", destItem.Database)
		}

		if action == prompt.NestedCreate || action == prompt.NestedDrop {
			if parentDB.User == destItem.User {
				item := destItem
				item.User = parentDB.User
				destDB = docker.ResolvedDB{DatabaseItem: item, Password: parentDB.Password}
			} else {
				childKey := config.DBKey(destItem.Key)
				var saved string
				if session != nil && cfg.RememberPassword {
					saved, _ = metadata.GetDBPassword(session, childKey)
				}
				var pwSource prompt.NestedCreatePasswordSource
				if opts.Yes {
					pwSource = prompt.PasswordParent
				} else {
					pwSource, err = prompt.SelectNestedCreatePassword(saved != "")
					if err != nil {
						return err
					}
				}
				switch pwSource {
				case prompt.PasswordParent:
					item := destItem
					item.User = parentDB.User
					destDB = docker.ResolvedDB{DatabaseItem: item, Password: parentDB.Password}
				case prompt.PasswordSaved:
					if saved == "" {
						return fmt.Errorf("no saved password for %q", destItem.Key)
					}
					destDB = docker.ResolvedDB{DatabaseItem: destItem, Password: saved}
				case prompt.PasswordNew:
					password, err := prompt.ConfirmedPassword(fmt.Sprintf("password for %s (%s)", destItem.Key, destItem.User))
					if err != nil {
						return err
					}
					fmt.Printf("→ Ensuring login %q…\n", destItem.User)
					if err := docker.EnsureDatabaseLogin(image, parentDB, docker.EnsureLoginOpts{
						User: destItem.User, Password: password, Database: destItem.Database, ConnectDatabase: parentLogin,
					}); err != nil {
						return err
					}
					if cfg.RememberPassword && session != nil {
						if err := metadata.SetDBPassword(session, childKey, password); err != nil {
							return err
						}
					}
					destDB = docker.ResolvedDB{DatabaseItem: destItem, Password: password}
					fmt.Printf("✓ Login %q ready\n", destItem.User)
				}
			}
		} else {
			intoExisting = true
			item := destItem
			item.User = parentDB.User
			destDB = docker.ResolvedDB{DatabaseItem: item, Password: parentDB.Password}
		}
	} else {
		destDB, err = resolveConnectedDB(cfg, session, destItem, "destination", true)
		if err != nil {
			return err
		}
		created, err := ensureDestDatabase(cfg, destDB, destItem.Key, opts.Yes)
		if err != nil {
			return err
		}
		intoExisting = !created
		confirmed, err := prompt.ConfirmOrYes(fmt.Sprintf(`Restore %q into %q?`, fileName, destItem.Key), opts.Yes, false)
		if err != nil {
			return err
		}
		if !confirmed {
			fmt.Println("⚠ Restore cancelled")
			return nil
		}
	}

	clean, err := resolveRestoreClean(intoExisting, opts.Yes)
	if err != nil {
		return err
	}

	restoreDir := dir
	restoreName := fileName
	var tempPlain string
	if dumps.IsEncryptedDumpName(fileName) {
		if session == nil || session.AESKey == nil {
			return fmt.Errorf("AES key required to decrypt dump")
		}
		tempPlain = filepath.Join(dir, fmt.Sprintf(".dumpmgr-decrypt-%d_%s", time.Now().UnixMilli(), dumps.PlainTempNameFromEncrypted(fileName)))
		fmt.Println("→ Decrypting dump…")
		if err := dumps.DecryptDumpToTemp(filepath.Join(dir, fileName), session.AESKey, tempPlain); err != nil {
			return err
		}
		restoreName = filepath.Base(tempPlain)
	}
	defer func() {
		if tempPlain != "" {
			_ = os.Remove(tempPlain)
		}
	}()

	if _, _, err := runRestoreWithSpinner(image, destDB, restoreDir, restoreName, destItem.Key, clean); err != nil {
		return err
	}
	fmt.Printf("✓ Restored %s → %s\n", fileName, destItem.Key)
	return nil
}

func runDumpRestore(opts Options, cfg *config.Config, session *metadata.Session, items []config.DatabaseItem, image, dumpsRoot string) error {
	sourceItem, err := prompt.SelectDatabaseItem(items, "Select source database", "")
	if err != nil {
		return err
	}
	destItem, err := prompt.SelectDatabaseTree(cfg, "Select destination database", sourceItem.Key)
	if err != nil {
		return err
	}
	sourceDB, err := resolveConnectedDB(cfg, session, sourceItem, "source", false)
	if err != nil {
		return err
	}
	destDB, err := resolveConnectedDB(cfg, session, destItem, "destination", true)
	if err != nil {
		return err
	}
	destCreated, err := ensureDestDatabase(cfg, destDB, destItem.Key, opts.Yes)
	if err != nil {
		return err
	}

	fmt.Println("Sync plan")
	fmt.Printf("  Source:      %s → %s@%s:%d/%s\n", sourceItem.Key, sourceDB.User, sourceDB.Host, sourceDB.Port, sourceDB.Database)
	fmt.Printf("  Destination: %s → %s@%s:%d/%s\n", destItem.Key, destDB.User, destDB.Host, destDB.Port, destDB.Database)
	fmt.Printf("  Image:       %s\n", image)
	fmt.Printf("  Compress:    %s\n", docker.DumpCompress)
	fmt.Printf("  Dumps:       %s\n", dumpsRoot)
	fmt.Printf("  Encrypted:   %v\n", cfg.EncryptedDump)

	confirmed, err := prompt.ConfirmOrYes(
		fmt.Sprintf(`Overwrite destination %q with dump from %q?`, destItem.Key, sourceItem.Key),
		opts.Yes, false,
	)
	if err != nil {
		return err
	}
	if !confirmed {
		fmt.Println("⚠ Sync cancelled")
		return nil
	}

	clean, err := resolveRestoreClean(!destCreated, opts.Yes)
	if err != nil {
		return err
	}

	dir := dumps.DBDumpDir(dumpsRoot, sourceItem.Key)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	plainName := dumps.NewDumpFileName(sourceItem.Key)
	if _, _, _, err := runDumpWithSpinner(image, sourceDB, dir, plainName, sourceItem.Key); err != nil {
		return err
	}
	if _, _, err := runRestoreWithSpinner(image, destDB, dir, plainName, destItem.Key, clean); err != nil {
		return err
	}

	finalPath := filepath.Join(dir, plainName)
	if cfg.EncryptedDump {
		if session == nil || session.AESKey == nil {
			return fmt.Errorf("AES key required for encrypted dumps")
		}
		if session.Metadata.EncID == nil || *session.Metadata.EncID == "" {
			return fmt.Errorf("encId missing from metadata")
		}
		fmt.Println("→ Encrypting dump…")
		var err error
		finalPath, err = dumps.EncryptDumpFile(finalPath, session.AESKey, *session.Metadata.EncID)
		if err != nil {
			return err
		}
		size, _ := dumps.FileSize(finalPath)
		fmt.Printf("✓ Encrypted (%s)\n", dumps.FormatBytes(size))
	}
	fmt.Printf("ℹ Dump kept at %s\n", finalPath)
	fmt.Printf("✓ Synced %s → %s\n", sourceItem.Key, destItem.Key)
	return nil
}

func resolveRestoreClean(intoExisting, yes bool) (bool, error) {
	if !intoExisting {
		return false, nil
	}
	return prompt.SelectReplaceExistingObjects(yes)
}

func RunMain(opts Options) error {
	if opts.Debug {
		docker.SetDebug(true, func(msg string) { fmt.Println(msg) })
		fmt.Println("Debug mode on")
	}
	Intro()

	configPath := config.ResolvePath(opts.ConfigPath)
	if !config.Exists(configPath) {
		fmt.Printf("✗ Config file not found: %s\n", configPath)
		choice, err := prompt.SelectInitChoice()
		if err != nil || choice == "abort" {
			prompt.OnCancel()
		}
		withFake := choice == "fake"
		if err := initcmd.Run(initcmd.Options{Config: configPath, WithFakeData: &withFake}); err != nil {
			return err
		}
		os.Exit(0)
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	if cfg.EncryptedDump && !cfg.RememberPassword {
		fmt.Println(`⚠ encryptedDump is true but rememberPassword is false. Encrypted dumps need the master-derived AES key, so set "rememberPassword": true in config.jsonc (or disable encryptedDump).`)
	}
	session, err := UnlockOrNull(cfg, configPath)
	if err != nil {
		return err
	}

	if opts.Mode != "" {
		if err := docker.AssertAvailable(); err != nil {
			return err
		}
		return RunMode(opts.Mode, opts, cfg, session)
	}

	for {
		mode, err := prompt.SelectMode(cfg)
		if err != nil {
			return err
		}
		if mode == prompt.ModeExit {
			fmt.Println("Bye")
			return nil
		}
		switch mode {
		case prompt.ModeChangeMaster:
			if session == nil {
				return fmt.Errorf("master password session required")
			}
			session, err = handleChangeMaster(cfg, session)
			if err != nil {
				fmt.Printf("✗ %v\n", err)
			}
		case prompt.ModeS3Upload:
			if err := RunS3Action(S3Upload, cfg, configPath, opts.Yes); err != nil {
				fmt.Printf("✗ %v\n", err)
			}
		case prompt.ModeS3Download:
			if err := RunS3Action(S3Download, cfg, configPath, opts.Yes); err != nil {
				fmt.Printf("✗ %v\n", err)
			}
		default:
			if err := docker.AssertAvailable(); err != nil {
				fmt.Printf("✗ %v\n", err)
				continue
			}
			if err := RunMode(Mode(mode), opts, cfg, session); err != nil {
				fmt.Printf("✗ %v\n", err)
			}
		}
	}
}

func UnlockForSecretOps(cfg *config.Config, configPath string) (*metadata.Session, error) {
	if !config.NeedsMaster(cfg) {
		fmt.Println(`⚠ metadata has no master password; nothing to list/wipe. Set "rememberPassword": true in config.jsonc.`)
		return nil, nil
	}
	return UnlockOrNull(cfg, configPath)
}

func SortedSecretKeys(session *metadata.Session) []string {
	keys := make([]string, 0, len(session.Metadata.DBPasswords))
	for k := range session.Metadata.DBPasswords {
		keys = append(keys, k)
	}
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}

func WarnEncryptedDumpConfig() string {
	return strings.TrimSpace(`encryptedDump is true but rememberPassword is false`)
}

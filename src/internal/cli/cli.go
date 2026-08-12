package cli

import (
	"fmt"
	"os"

	"github.com/md-redwan-hossain/dumpmgr/src/internal/app"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/autonomous"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/config"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/doctor"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/initcmd"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/metadata"
	"github.com/md-redwan-hossain/dumpmgr/src/internal/prompt"
	"github.com/spf13/cobra"
)

func Execute() error {
	return rootCmd().Execute()
}

func rootCmd() *cobra.Command {
	var configPath string
	var yes bool
	var debug bool
	var source, dest, dump string

	root := &cobra.Command{
		Use:   "dumpmgr",
		Short: "Dump Manager — dump and restore Postgres databases via Docker",
		Long: `Dump Manager — dump and restore Postgres databases via Docker.

Auxiliary commands:
  doctor              Check Docker / dumps dir / metadata integrity
  s3 upload           Upload a local dump to S3
  s3 download         Browse and download a dump from S3
  secret list         List stored DB password keys with metadata
  secret history      Show rotation history for a secret key
  secret wipe <key>   Remove a stored DB password by key
  vault status        Show SQLite vault summary
  audit list          List audit log entries
  dump-registry list  List indexed dumps with SHA-256
  dump-registry scan  Index existing dumps under dumps/
  restore-history list  List restore operations
  autonomous            Run scheduled backups (cron + optional S3 upload)
  config {init|validate|lint}`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return handleMain(configPath, yes, debug, "", source, dest, dump)
		},
	}
	root.Flags().StringVarP(&configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	root.Flags().BoolVar(&yes, "yes", false, "Skip confirms; auto-create missing dest DB")
	root.Flags().BoolVar(&debug, "debug", false, "Print docker/DB commands being executed")
	root.Flags().StringVar(&source, "source", "", "Database item key to dump (skip picker)")
	root.Flags().StringVar(&dest, "dest", "", "Destination database item key (skip picker)")
	root.Flags().StringVar(&dump, "dump", "", "Path to dump file (skip browser)")

	addModeCommands(root, &configPath, &yes, &debug)
	addS3Commands(root, &configPath, &yes)
	addDoctorCommand(root, &configPath)
	addSecretCommands(root, &configPath, &yes)
	addConfigCommands(root, &configPath)
	addInspectCommands(root, &configPath)
	addAutonomousCommand(root, &configPath, &debug)

	return root
}

func addModeCommands(root *cobra.Command, configPath *string, yes, debug *bool) {
	modes := []struct {
		name string
		mode app.Mode
		desc string
	}{
		{"dump", app.ModeDump, "Take dump (write dump file only)"},
		{"restore", app.ModeRestore, "Restore from dump"},
		{"dump-restore", app.ModeDumpRestore, "Take dump and restore (copy source → destination)"},
	}
	for _, m := range modes {
		m := m
		var source, dest, dump string
		cmd := &cobra.Command{
			Use:   m.name,
			Short: m.desc,
			RunE: func(cmd *cobra.Command, args []string) error {
				return handleMain(*configPath, *yes, *debug, m.mode, source, dest, dump)
			},
		}
		cmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
		cmd.Flags().BoolVar(yes, "yes", false, "Skip confirms; auto-create missing dest DB")
		cmd.Flags().BoolVar(debug, "debug", false, "Print docker/DB commands being executed")
		if m.mode == app.ModeDump || m.mode == app.ModeDumpRestore {
			cmd.Flags().StringVar(&source, "source", "", "Database item key to dump (skip picker)")
		}
		if m.mode == app.ModeRestore || m.mode == app.ModeDumpRestore {
			cmd.Flags().StringVar(&dest, "dest", "", "Destination database item key (skip picker)")
		}
		if m.mode == app.ModeRestore {
			cmd.Flags().StringVar(&dump, "dump", "", "Path to dump file (skip browser)")
		}
		root.AddCommand(cmd)
	}
}

func handleMain(configPath string, yes, debug bool, mode app.Mode, source, dest, dump string) error {
	opts := app.Options{
		ConfigPath: configPath,
		Yes:        yes,
		Debug:      debug,
		Mode:       mode,
		Source:     source,
		Dest:       dest,
		Dump:       dump,
	}
	if err := app.RunMain(opts); err != nil {
		prompt.LogError(err.Error())
		return err
	}
	return nil
}

func addS3Commands(root *cobra.Command, configPath *string, yes *bool) {
	s3Cmd := &cobra.Command{Use: "s3", Short: "Manually upload or download dumps using configured S3"}
	for _, action := range []struct {
		name string
		fn   app.S3Action
		desc string
	}{
		{"upload", app.S3Upload, "Upload a local dump to S3"},
		{"download", app.S3Download, "Browse and download a dump from S3"},
	} {
		a := action
		cmd := &cobra.Command{
			Use:   a.name,
			Short: a.desc,
			RunE: func(cmd *cobra.Command, args []string) error {
				return handleS3(a.fn, *configPath, *yes)
			},
		}
		cmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
		cmd.Flags().BoolVar(yes, "yes", false, "Overwrite an existing local download")
		s3Cmd.AddCommand(cmd)
	}
	root.AddCommand(s3Cmd)
}

func handleS3(action app.S3Action, configPath string, yes bool) error {
	path := config.ResolvePath(configPath)
	prompt.Intro(fmt.Sprintf("dumpmgr s3 %s", action))
	if !config.Exists(path) {
		prompt.LogError(fmt.Sprintf("Config file not found: %s", path))
		os.Exit(1)
	}
	cfg, err := config.Load(path)
	if err != nil {
		prompt.LogError(err.Error())
		os.Exit(1)
	}
	if err := app.RunS3Action(action, cfg, path, yes); err != nil {
		prompt.LogError(err.Error())
		return err
	}
	prompt.Outro("done")
	return nil
}

func addDoctorCommand(root *cobra.Command, configPath *string) {
	cmd := &cobra.Command{
		Use:   "doctor",
		Short: "Check Docker daemon, dumps dir permissions, and metadata integrity",
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			prompt.Intro("dumpmgr doctor")
			if !config.Exists(path) {
				prompt.LogError(fmt.Sprintf("Config file not found: %s", path))
				prompt.LogError("config missing")
				os.Exit(1)
			}
			cfg, err := config.Load(path)
			if err != nil {
				prompt.LogError(err.Error())
				prompt.LogError("config invalid")
				os.Exit(1)
			}
			report := doctor.Run(cfg, path)
			for _, check := range report.Checks {
				if check.OK {
					prompt.LogSuccess(fmt.Sprintf("%s: %s", check.Name, check.Message))
				} else {
					prompt.LogError(fmt.Sprintf("%s: %s", check.Name, check.Message))
					if check.Hint != "" {
						prompt.LogInfo(fmt.Sprintf("hint: %s", check.Hint))
					}
				}
			}
			if report.OK {
				prompt.Outro("doctor ok")
				return nil
			}
			prompt.LogError("doctor found problems")
			os.Exit(1)
			return nil
		},
	}
	cmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	root.AddCommand(cmd)
}

func addSecretCommands(root *cobra.Command, configPath *string, yes *bool) {
	secretCmd := &cobra.Command{Use: "secret", Short: "List, inspect, or wipe saved DB passwords"}

	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List stored DB password keys with created/updated/last-used timestamps",
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			prompt.Intro("dumpmgr secret list")
			cfg, err := loadConfigOrExit(path, "config missing")
			if err != nil {
				return err
			}
			session, err := app.UnlockForSecretOps(cfg, path)
			if err != nil {
				return err
			}
			if session == nil {
				prompt.LogInfo("nothing to list")
				return nil
			}
			defer session.Close()
			if err := printSecretList(session); err != nil {
				return err
			}
			keys, _ := app.SortedSecretKeys(session)
			prompt.LogInfo(fmt.Sprintf("%d stored", len(keys)))
			return nil
		},
	}
	listCmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")

	historyCmd := &cobra.Command{
		Use:   "history [key]",
		Short: "Show rotation history for a secret key",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			cfg, err := loadConfigOrExit(path, "config missing")
			if err != nil {
				return err
			}
			session, err := app.UnlockForSecretOps(cfg, path)
			if err != nil {
				return err
			}
			if session == nil {
				prompt.LogInfo("no history")
				return nil
			}
			defer session.Close()
			prompt.Intro(fmt.Sprintf("dumpmgr secret history %s", args[0]))
			return printSecretHistory(session, args[0], 50)
		},
	}
	historyCmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")

	wipeCmd := &cobra.Command{
		Use:   "wipe [key]",
		Short: "Remove a saved DB password by key (e.g. postgres:prod)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			targetKey := args[0]
			prompt.Intro(fmt.Sprintf("dumpmgr secret wipe %s", targetKey))
			cfg, err := loadConfigOrExit(path, "config missing")
			if err != nil {
				return err
			}
			session, err := app.UnlockForSecretOps(cfg, path)
			if err != nil {
				return err
			}
			if session == nil {
				prompt.LogInfo("nothing to wipe")
				return nil
			}
			defer session.Close()
			_, ok, err := session.Store.GetSecretCiphertext(targetKey)
			if err != nil {
				return err
			}
			if !ok {
				prompt.LogWarn(fmt.Sprintf(`"%s" is not stored.`, targetKey))
				prompt.LogInfo("no change")
				return nil
			}
			if !*yes {
				ok, err := prompt.ConfirmWipeSecret(targetKey)
				if err != nil {
					return err
				}
				if !ok {
					prompt.LogWarn("wipe cancelled")
					prompt.LogInfo("no change")
					return nil
				}
			}
			removed, err := metadata.DeleteDBPassword(session, targetKey)
			if err != nil {
				return err
			}
			if removed {
				prompt.LogSuccess(fmt.Sprintf(`Removed "%s".`, targetKey))
				prompt.LogInfo("Encrypted dumps remain unaffected (they use the master key, not per-DB passwords).")
			} else {
				prompt.LogWarn(fmt.Sprintf(`"%s" was already gone.`, targetKey))
			}
			prompt.Outro("done")
			return nil
		},
	}
	wipeCmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	wipeCmd.Flags().BoolVar(yes, "yes", false, "Skip confirmation prompt")

	secretCmd.AddCommand(listCmd, historyCmd, wipeCmd)
	root.AddCommand(secretCmd)
}

func addConfigCommands(root *cobra.Command, configPath *string) {
	configCmd := &cobra.Command{Use: "config", Short: "Manage config.jsonc"}

	initCmd := &cobra.Command{
		Use:   "init",
		Short: "Scaffold config.jsonc and metadata",
		RunE: func(cmd *cobra.Command, args []string) error {
			prompt.Intro("dumpmgr config init")
			withFake, _ := cmd.Flags().GetBool("with-fake-data")
			var withFakePtr *bool
			if cmd.Flags().Changed("with-fake-data") {
				withFakePtr = &withFake
			}
			if err := initcmd.Run(initcmd.Options{
				Config:       config.ResolvePath(*configPath),
				WithFakeData: withFakePtr,
			}); err != nil {
				prompt.LogError(err.Error())
				return err
			}
			return nil
		},
	}
	initCmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	initCmd.Flags().Bool("with-fake-data", false, "Skip prompt; populate sample database items")

	validateCmd := &cobra.Command{
		Use:   "validate",
		Short: "Validate config.jsonc and print a summary report",
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			prompt.Intro("dumpmgr config validate")
			result := config.ValidateFile(path)
			if !result.OK {
				for _, issue := range result.Issues {
					prompt.LogError(issue)
				}
				prompt.LogError("config invalid")
				os.Exit(1)
			}
			for _, line := range result.Report {
				if line != "" {
					prompt.LogInfo(line)
				}
			}
			for _, w := range result.Warnings {
				prompt.LogWarn(w)
			}
			if len(result.Warnings) > 0 {
				prompt.Outro("config ok (with warnings)")
			} else {
				prompt.Outro("config ok")
			}
			return nil
		},
	}
	validateCmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")

	lintCmd := &cobra.Command{
		Use:   "lint",
		Short: "Format config.jsonc in place (preserves comments)",
		RunE: func(cmd *cobra.Command, args []string) error {
			path := config.ResolvePath(*configPath)
			prompt.Intro("dumpmgr config lint")
			if err := config.LintFile(path); err != nil {
				prompt.LogError(err.Error())
				return err
			}
			prompt.LogSuccess(fmt.Sprintf("Formatted %s", path))
			prompt.Outro("done")
			return nil
		},
	}
	lintCmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")

	configCmd.AddCommand(initCmd, validateCmd, lintCmd)
	root.AddCommand(configCmd)
}

func loadConfigOrExit(path, outro string) (*config.Config, error) {
	if !config.Exists(path) {
		prompt.LogError(fmt.Sprintf("Config file not found: %s", path))
		prompt.LogError(outro)
		os.Exit(1)
	}
	cfg, err := config.Load(path)
	if err != nil {
		prompt.LogError(err.Error())
		prompt.LogError("config invalid")
		os.Exit(1)
	}
	return cfg, nil
}

func addAutonomousCommand(root *cobra.Command, configPath *string, debug *bool) {
	var once bool
	cmd := &cobra.Command{
		Use:   "autonomous",
		Short: "Run scheduled backups from config autonomous.schedules (cron + optional S3)",
		Long: `Run scheduled backups from config autonomous.schedules (cron + optional S3).

Unlocks the vault with DUMPMGR_MASTER_PASSWORD when rememberPassword, encryptedDump,
or s3Options are enabled. S3 secret key can come from the vault or DUMPMGR_S3_SECRET_KEY.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Println("dumpmgr autonomous")
			if err := autonomous.Run(autonomous.Options{
				ConfigPath: *configPath,
				Debug:      *debug,
				Once:       once,
			}); err != nil {
				fmt.Printf("✗ %v\n", err)
				return err
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(configPath, "config", "c", config.DefaultConfigPath, "Path to config.jsonc")
	cmd.Flags().BoolVar(debug, "debug", false, "Print docker/DB commands being executed")
	cmd.Flags().BoolVar(&once, "once", false, "Run all schedules immediately and exit")
	root.AddCommand(cmd)
}
